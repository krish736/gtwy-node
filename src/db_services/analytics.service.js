import Sequelize from "sequelize";
import models from "../../models/index.js";
import { ResponseSender } from "../services/utils/customResponse.utils.js";
import { buildConversationFilterSql } from "./conversationFilters.util.js";
import logger from "../logger.js";

const responseSender = new ResponseSender();

// Resolve the time window + bucket size from either a `range` (days) or a custom
// start_date/end_date pair. Short windows are bucketed hourly, longer ones daily.
function computeWindow({ range, start_date, end_date, interval }) {
  const end = end_date ? new Date(end_date) : new Date();
  let start;
  let durationInHours = 0;

  if (start_date && end_date) {
    start = new Date(start_date);
    durationInHours = Math.max(1, (end.getTime() - start.getTime()) / 3600000);
  } else {
    const r = range || "7d";
    const isHours = r.toString().endsWith("h");
    const val = Number(r.toString().replace(/[^0-9.]/g, "")) || 7;

    if (isHours) {
      durationInHours = val;
    } else {
      durationInHours = val * 24;
    }
    start = new Date(end.getTime() - durationInHours * 3600000);
  }

  // Choose bucket size based on total duration to provide a nice chart curve
  let bucket = "day";
  if (durationInHours <= 72) {
    bucket = "hour";
  }
  if (interval) {
    bucket = interval;
  }

  return { start, end, bucket };
}

function getBucketExpressionAndParams(bucketStr, params) {
  let bucketSql = "date_trunc(:bucket, created_at)";
  let finalParams = { ...params, bucket: bucketStr };

  if (bucketStr && bucketStr.match(/^([0-9]+)h$/)) {
    const hours = parseInt(bucketStr.match(/^([0-9]+)h$/)[1], 10);
    if (hours === 24) {
      finalParams.bucket = "day";
    } else if (hours === 1) {
      finalParams.bucket = "hour";
    } else {
      const seconds = hours * 3600;
      bucketSql = `to_timestamp(floor(extract(epoch from created_at) / ${seconds}) * ${seconds}) AT TIME ZONE 'UTC'`;
      delete finalParams.bucket;
    }
  }

  return { bucketSql, finalParams };
}

const pgSelect = (query, replacements) => models.pg.sequelize.query(query, { type: Sequelize.QueryTypes.SELECT, replacements });

// Build the optional ` AND (<expr>)` clause from the shared filter builder.
// Values are inline-escaped, so no extra bind params are needed.
function filterClause(filters) {
  const expr = buildConversationFilterSql(filters);
  return expr ? ` AND (${expr})` : "";
}

// Single-row aggregate for the dashboard cards. latency/tokens are JSONB so we
// extract the numeric keys. Tokens store input_tokens/output_tokens/expected_cost
// (total_tokens may be absent, so fall back to input + output). Cost comes from
// the tokens.expected_cost key — entirely from conversation_logs, no Timescale.
async function getSummary({ bridge_id, org_id, start, end, filters }) {
  const query = `
    SELECT
      COUNT(*)::int AS total_requests,
      COUNT(*) FILTER (WHERE status = true)::int  AS success_count,
      COUNT(*) FILTER (WHERE status = false)::int AS failed_runs,
      COALESCE(AVG((latency->>'over_all_time')::float) FILTER (WHERE status = true), 0) AS avg_response,
      COALESCE(SUM(
        COALESCE((tokens->>'total_tokens')::float,
                 COALESCE((tokens->>'input_tokens')::float, 0) + COALESCE((tokens->>'output_tokens')::float, 0))
      ), 0) AS total_tokens,
      COALESCE(SUM((tokens->>'expected_cost')::float), 0) AS est_cost,
      COUNT(*) FILTER (WHERE user_feedback = 1)::int AS positive_feedback,
      COUNT(*) FILTER (WHERE user_feedback = 2)::int AS negative_feedback
    FROM conversation_logs
    WHERE bridge_id = :bridge_id AND org_id = :org_id
      AND created_at BETWEEN :start AND :end ${filterClause(filters)}`;
  const rows = await pgSelect(query, { bridge_id, org_id, start, end });
  return rows[0] || {};
}

// Time-series for the "Requests Over Time" chart: success vs failed per bucket.
async function getRequestsOverTime({ bridge_id, org_id, start, end, bucket, filters }) {
  const { bucketSql, finalParams } = getBucketExpressionAndParams(bucket, { bridge_id, org_id, start, end });
  const query = `
    SELECT
      ${bucketSql} AS t,
      COUNT(*) FILTER (WHERE status = true)::int  AS success,
      COUNT(*) FILTER (WHERE status = false)::int AS failed
    FROM conversation_logs
    WHERE bridge_id = :bridge_id AND org_id = :org_id
      AND created_at BETWEEN :start AND :end ${filterClause(filters)}
    GROUP BY 1 ORDER BY 1 ASC`;
  return pgSelect(query, finalParams);
}

// Time-series for the "Response Time" chart: p50 (typical) / p95 (slow) / p99 (worst)
// of over_all_time per bucket.
async function getResponseTime({ bridge_id, org_id, start, end, bucket, filters }) {
  const { bucketSql, finalParams } = getBucketExpressionAndParams(bucket, { bridge_id, org_id, start, end });
  const query = `
    SELECT
      ${bucketSql} AS t,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY (latency->>'over_all_time')::float) AS typical,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY (latency->>'over_all_time')::float) AS slow,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY (latency->>'over_all_time')::float) AS worst
    FROM conversation_logs
    WHERE bridge_id = :bridge_id AND org_id = :org_id
      AND created_at BETWEEN :start AND :end ${filterClause(filters)}
      AND (latency->>'over_all_time') IS NOT NULL
    GROUP BY 1 ORDER BY 1 ASC`;
  return pgSelect(query, finalParams);
}

// Time-series for the "Cost" chart: sum of tokens.expected_cost per bucket
// (same source as summary.est_cost).
async function getCostOverTime({ bridge_id, org_id, start, end, bucket, filters }) {
  const { bucketSql, finalParams } = getBucketExpressionAndParams(bucket, { bridge_id, org_id, start, end });
  const query = `
    SELECT
      ${bucketSql} AS t,
      COALESCE(SUM((tokens->>'expected_cost')::float), 0) AS cost
    FROM conversation_logs
    WHERE bridge_id = :bridge_id AND org_id = :org_id
      AND created_at BETWEEN :start AND :end ${filterClause(filters)}
    GROUP BY 1 ORDER BY 1 ASC`;
  return pgSelect(query, finalParams);
}

// ---- Usage grouped by a variable / model / day (returned in the response, no RT layer) ----

const USAGE_COLUMNS = { model: "model", day: "to_char(date_trunc('day', created_at), 'YYYY-MM-DD')" };

// getSummary's numbers for one agent and window, one row per group (variables.<name>, model or day),
// plus the totals over all groups. One pass over the table: the totals are summed from the groups,
// not from a second scan. A group whose key is null holds the messages that have no value for it.
// variables_eq / variables_ne compare a variable's value exactly; "not equal" keeps rows without it.
// Names and values travel as bind params; the validator limits group_by and sort to known words.
async function getUsage({ bridge_id, org_id, start, end, filters, group_by, variables_eq = {}, variables_ne = {}, sort, limit }) {
  const params = { bridge_id, org_id, start, end, limit };
  const groups = group_by.map((key, i) => {
    if (USAGE_COLUMNS[key]) return USAGE_COLUMNS[key];
    params[`gk${i}`] = key.replace("variables.", "");
    return `variables->>:gk${i}`;
  });
  const where = [];
  Object.entries(variables_eq).forEach(([key, value], i) => {
    Object.assign(params, { [`ek${i}`]: key, [`ev${i}`]: value });
    where.push(`AND variables->>:ek${i} = :ev${i}`);
  });
  Object.entries(variables_ne).forEach(([key, value], i) => {
    Object.assign(params, { [`nk${i}`]: key, [`nv${i}`]: value });
    where.push(`AND COALESCE(variables->>:nk${i}, '') <> :nv${i}`);
  });
  const order = sort === "day" ? `g${group_by.indexOf("day")}` : sort;
  // updated_at is never before created_at, so the extra bound changes no result; it lets the
  // (org_id, bridge_id, updated_at) index narrow the scan to the window instead of the whole agent.
  const query = `
    WITH g AS (
      SELECT ${groups.map((expr, i) => `${expr} AS g${i}`).join(", ")},
        COUNT(*)::int AS total_requests,
        COUNT(*) FILTER (WHERE status = false)::int AS failed_runs,
        COALESCE(SUM(
          COALESCE((tokens->>'total_tokens')::float,
                   COALESCE((tokens->>'input_tokens')::float, 0) + COALESCE((tokens->>'output_tokens')::float, 0))
        ), 0) AS total_tokens,
        COALESCE(SUM((tokens->>'expected_cost')::float), 0) AS est_cost,
        COALESCE(SUM((tokens->>'credits')::float), 0) AS credits
      FROM conversation_logs
      WHERE org_id = :org_id AND bridge_id = :bridge_id
        AND updated_at >= :start
        AND created_at BETWEEN :start AND :end ${filterClause(filters)} ${where.join(" ")}
      GROUP BY ${groups.map((_, i) => i + 1).join(", ")}
    )
    SELECT g.*, COUNT(*) OVER ()::int AS all_groups,
      SUM(total_requests) OVER ()::int AS all_requests, SUM(failed_runs) OVER ()::int AS all_failed,
      SUM(total_tokens) OVER () AS all_tokens, SUM(est_cost) OVER () AS all_cost, SUM(credits) OVER () AS all_credits
    FROM g ORDER BY ${order} DESC LIMIT :limit`;
  const rows = await pgSelect(query, params);

  const numbers = (requests, failed, tokens, cost, credits) => ({
    total_requests: requests || 0,
    failed_runs: failed || 0,
    total_tokens: Math.round(tokens || 0),
    est_cost: Number(Number(cost || 0).toFixed(6)),
    credits: Number(Number(credits || 0).toFixed(4))
  });
  const all = rows[0] || {};
  return {
    summary: numbers(all.all_requests, all.all_failed, all.all_tokens, all.all_cost, all.all_credits),
    groups: rows.map((row) => ({
      ...Object.fromEntries(group_by.map((key, i) => [key, row[`g${i}`] ?? null])),
      ...numbers(row.total_requests, row.failed_runs, row.total_tokens, row.est_cost, row.credits)
    })),
    truncated: (all.all_groups || 0) > rows.length
  };
}

async function pushAnalytics(channel, data) {
  await responseSender.sendResponse({
    rtlLayer: true,
    data,
    reqBody: { rtlOptions: { channel, ttl: 30, apikey: process.env.RTLAYER_AUTH } },
    headers: {}
  });
}

// Background worker: runs the dashboard sections concurrently and pushes each over the
// RT layer the moment it is ready (progressive render). Each section fails
// independently — a broken section pushes an error message instead of poisoning
// the rest.
async function runAndPush({ bridge_id, org_id, channel, window, filters }) {
  const ctx = { bridge_id, org_id, ...window, filters };
  const base = { bridge_id, range_start: window.start, range_end: window.end };

  const summaryTask = (async () => {
    try {
      const row = await getSummary(ctx);
      const total = row.total_requests || 0;
      const summary = {
        total_requests: total,
        success_rate: total ? Number(((row.success_count / total) * 100).toFixed(1)) : 0,
        avg_response: Math.round(row.avg_response || 0),
        failed_runs: row.failed_runs || 0,
        total_tokens: Math.round(row.total_tokens || 0),
        est_cost: Number(Number(row.est_cost || 0).toFixed(4)),
        positive_feedback: row.positive_feedback || 0,
        negative_feedback: row.negative_feedback || 0
      };
      await pushAnalytics(channel, { type: "summary", success: true, ...base, summary });
    } catch (error) {
      logger.error(`analytics summary failed for ${bridge_id}: ${error.message}`);
      await pushAnalytics(channel, { type: "summary", success: false, ...base, error: error.message });
    }
  })();

  const requestsTask = (async () => {
    try {
      const requests_over_time = await getRequestsOverTime(ctx);
      await pushAnalytics(channel, { type: "requests_over_time", success: true, ...base, requests_over_time });
    } catch (error) {
      logger.error(`analytics requests_over_time failed for ${bridge_id}: ${error.message}`);
      await pushAnalytics(channel, { type: "requests_over_time", success: false, ...base, error: error.message });
    }
  })();

  const responseTimeTask = (async () => {
    try {
      const response_time = await getResponseTime(ctx);
      await pushAnalytics(channel, { type: "response_time", success: true, ...base, response_time });
    } catch (error) {
      logger.error(`analytics response_time failed for ${bridge_id}: ${error.message}`);
      await pushAnalytics(channel, { type: "response_time", success: false, ...base, error: error.message });
    }
  })();

  const costTask = (async () => {
    try {
      const cost_over_time = await getCostOverTime(ctx);
      await pushAnalytics(channel, { type: "cost_over_time", success: true, ...base, cost_over_time });
    } catch (error) {
      logger.error(`analytics cost_over_time failed for ${bridge_id}: ${error.message}`);
      await pushAnalytics(channel, { type: "cost_over_time", success: false, ...base, error: error.message });
    }
  })();

  await Promise.allSettled([summaryTask, requestsTask, responseTimeTask, costTask]);
}

// Distinct filter options for a bridge, used by the frontend to build the
// dropdowns. Scans the whole bridge (no time window). Returns:
//   tools_data:        { "<display tool name>": "<tool id>" }  (function/MCP calls)
//   knowledgebase_data:{ "<resource_id>": "<resource_id>" }    (RAG calls)
//   agent_data:        { "<agent name>": "<id>" }              (agent calls)
//   unique_model:      { "<service>": ["<model>", ...] }
async function getFilterOptions({ bridge_id, org_id }) {
  // Calls: unnest the JSONB array, then each `{ "fc_..": {entry} }` object, and
  // pull the type discriminator (data.metadata.type), display name + id. Filter to
  // array rows first so jsonb_array_elements never runs on a non-array value.
  // One row per (type, id). Some records carry no display_tool_name/name
  // (queued/in-progress or older rows), so we aggregate across all records and
  // prefer a real name — only falling back to the id when no record ever stored a
  // name (or only stored the id as the name).
  const toolsQuery = `
    SELECT
      call_type,
      call_id,
      COALESCE(
        MAX(call_name) FILTER (WHERE call_name IS NOT NULL AND call_name <> call_id),
        call_id
      ) AS call_name
    FROM (
      SELECT
        COALESCE(kv.value->'data'->'metadata'->>'type', 'function') AS call_type,
        -- The usable identifier depends on the call type: functions/MCP have a
        -- top-level id; RAG (knowledgebase) has a null id and lives in
        -- args.resource_id; agent calls have a null id and live in
        -- data.metadata.agent_id (the called agent's bridge id). Resolve in order.
        COALESCE(
          kv.value->>'id',
          kv.value->'args'->>'resource_id',
          kv.value->'data'->'metadata'->>'agent_id',
          kv.value->>'bridge_id'
        ) AS call_id,
        COALESCE(kv.value->>'display_tool_name', kv.value->>'name') AS call_name
      FROM (
        SELECT tools_call_data
        FROM conversation_logs
        WHERE bridge_id = :bridge_id AND org_id = :org_id
          AND jsonb_typeof(tools_call_data) = 'array'
          AND tools_call_data <> '[]'::jsonb
      ) cl
      CROSS JOIN LATERAL jsonb_array_elements(cl.tools_call_data) AS elem
      CROSS JOIN LATERAL jsonb_each(elem) AS kv
      WHERE COALESCE(
        kv.value->>'id',
        kv.value->'args'->>'resource_id',
        kv.value->'data'->'metadata'->>'agent_id',
        kv.value->>'bridge_id'
      ) IS NOT NULL
    ) t
    GROUP BY call_type, call_id`;

  const modelsQuery = `
    SELECT DISTINCT service, model
    FROM conversation_logs
    WHERE bridge_id = :bridge_id AND org_id = :org_id
      AND model IS NOT NULL AND model <> ''`;

  const [toolRows, modelRows] = await Promise.all([pgSelect(toolsQuery, { bridge_id, org_id }), pgSelect(modelsQuery, { bridge_id, org_id })]);

  // Bucket each call by its type: agent -> agent_data, RAG -> knowledgebase_data,
  // everything else (function / mcp / unknown) -> tools_data.
  const tools_data = {};
  const knowledgebase_data = {};
  const agent_data = {};
  for (const row of toolRows) {
    const name = row.call_name || row.call_id;
    if (!name) continue;
    const type = (row.call_type || "function").toLowerCase();
    if (type === "agent") agent_data[name] = row.call_id;
    // KB calls share a generic display name ("get_knowledge_base_data"), so key by
    // the resource_id to keep each distinct knowledgebase as its own entry.
    else if (type === "rag") knowledgebase_data[row.call_id] = row.call_id;
    else tools_data[name] = row.call_id;
  }

  const unique_model = {};
  for (const row of modelRows) {
    const service = row.service || "other";
    if (!unique_model[service]) unique_model[service] = [];
    if (!unique_model[service].includes(row.model)) unique_model[service].push(row.model);
  }

  return { tools_data, knowledgebase_data, agent_data, unique_model };
}

export default {
  computeWindow,
  runAndPush,
  getFilterOptions,
  getUsage
};
