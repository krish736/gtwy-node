/**
 * Migration: register the `codex` service and its models.
 *
 * `codex` runs OpenAI models through the Codex CLI, signed in with the org's own ChatGPT login (the
 * contents of `~/.codex/auth.json` that `codex login` writes) instead of an OpenAI API key. The
 * Python gateway makes the calls (src/services/commonServices/openAI/codex_session.py); the request
 * and response keep the openai (Responses API) wire format, so the service and its models are copies
 * of the openai ones with these differences:
 *
 * - No key check against api.openai.com: a ChatGPT login is checked by the gateway
 *   (POST /api/v2/model/codex/verify), see orgLogin.utils.js.
 * - Only the models a ChatGPT plan serves through Codex (CODEX_MODELS), copied from the openai
 *   model of the same name when it exists.
 * - No OpenAI server tools: web search, image generation and code interpreter are switched off and
 *   MCP runs client-side in the gateway.
 * - No max_tokens and no service tier (Codex has no setting for them), no batch or priority prices.
 *
 * Idempotent: upserts by service_name / (service, model_name). Run it again after adding a model
 * to CODEX_MODELS.
 *
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */

const SOURCE = "openai";
const SERVICE = "codex";
// What `model/list` returns for a ChatGPT plan on Codex CLI 0.171 (Nov 2026).
const CODEX_MODELS = [
  "gpt-6.2-sol",
  "gpt-6.2-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5"
];
const DEFAULT_MODEL = "gpt-6-luna";
// Settings Codex has no option for; the agent page should not offer them.
const DROPPED_SETTINGS = ["max_tokens", "temperature", "top_p", "service_tier"];
const OPENAI_SERVER_TOOLS = /web search|image generation|code interpreter/i;
const DROPPED_PRICES = [
  "batch_input_cost",
  "batch_output_cost",
  "batch_cached_cost",
  "priority_input_cost",
  "priority_output_cost",
  "priority_cached_cost"
];

const buildService = (openai, models) => {
  // eslint-disable-next-line no-unused-vars
  const { _id, web_search_tool, image_generation_tool, code_interpreter_tool, validation_config, in_built_tools, ...rest } = openai;
  const defaultModel = models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0];
  return {
    ...rest,
    service_name: SERVICE,
    client: "codex_cli",
    default_model: defaultModel,
    default_fallback_model: defaultModel,
    // Nothing to call from Node: the gateway checks a ChatGPT login by making one tiny call on it.
    validation_config: { method: "GATEWAY", path: "codex/verify", headers: {} },
    in_built_tools: (in_built_tools || []).filter((tool) => !OPENAI_SERVER_TOOLS.test(tool?.name || "") || /gtwy/i.test(tool?.name || "")),
    status: 1
  };
};

const buildModel = (model) => {
  // eslint-disable-next-line no-unused-vars
  const { _id, __v, created_at, updated_at, ...rest } = model;
  const configuration = { ...(rest.configuration || {}) };
  for (const key of DROPPED_SETTINGS) delete configuration[key];
  const validationConfig = { ...(rest.validationConfig || {}) };
  validationConfig.mcp_type = "client";
  validationConfig.inbuilt_tools = { ...(validationConfig.inbuilt_tools || {}), web_search: false, image_generation: false, code_interpreter: false };
  if (validationConfig.specification) {
    const specification = { ...validationConfig.specification };
    for (const key of DROPPED_PRICES) delete specification[key];
    validationConfig.specification = specification;
  }
  return { ...rest, configuration, service: SERVICE, validationConfig };
};

export const up = async (db) => {
  const now = new Date();

  const openai = await db.collection("services").findOne({ service_name: SOURCE });
  if (!openai) throw new Error(`[codex] no "${SOURCE}" services document to copy from`);

  const models = await db
    .collection("modelconfigurations")
    .find({ service: SOURCE, status: 1, "validationConfig.type": "chat", model_name: { $in: CODEX_MODELS } })
    .toArray();
  if (!models.length) throw new Error(`[codex] none of the Codex models is an active "${SOURCE}" chat model`);
  const missing = CODEX_MODELS.filter((name) => !models.some((model) => model.model_name === name));
  if (missing.length) console.log(`[codex] not registered under "${SOURCE}", skipped: ${missing.join(", ")}`);

  const serviceResult = await db.collection("services").updateOne(
    { service_name: SERVICE },
    {
      $set: buildService(
        openai,
        models.map((model) => model.model_name)
      )
    },
    { upsert: true }
  );
  console.log(`[codex] service ${serviceResult.upsertedCount ? "inserted" : serviceResult.modifiedCount ? "updated" : "unchanged"}.`);

  const modelOps = models.map(buildModel).map((model) => ({
    updateOne: {
      filter: { service: SERVICE, model_name: model.model_name },
      update: { $set: { ...model, updated_at: now }, $setOnInsert: { created_at: now } },
      upsert: true
    }
  }));
  const modelResult = await db.collection("modelconfigurations").bulkWrite(modelOps, { ordered: false });
  console.log(`[codex] models: ${modelResult.upsertedCount} inserted, ${modelResult.modifiedCount} updated, ${models.length} total.`);
};

/**
 * Removes the service and its models. Saved ChatGPT logins (apikeycredentials rows with service
 * "codex") are left in place.
 *
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */
export const down = async (db) => {
  await db.collection("modelconfigurations").deleteMany({ service: SERVICE });
  await db.collection("services").deleteMany({ service_name: SERVICE });
};
