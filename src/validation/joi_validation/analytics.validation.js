import Joi from "joi";

// A multi-select string filter: either one string (possibly comma-separated, split
// in the controller) or an array of strings from bracket-style query params.
const multiString = Joi.alternatives().try(Joi.array().items(Joi.string().trim().min(1)), Joi.string().trim().min(1));

const getAgentAnalytics = {
  params: Joi.object()
    .keys({
      bridge_id: Joi.string().trim().min(1).required().messages({
        "string.empty": "bridge_id cannot be empty",
        "any.required": "bridge_id is required"
      })
    })
    .unknown(true),
  query: Joi.object()
    .keys({
      range: Joi.alternatives()
        .try(Joi.number().integer().min(1).max(365), Joi.string().pattern(/^[0-9]+[hd]$/))
        .optional()
        .messages({
          "number.max": "range cannot exceed 365 days",
          "string.pattern.base": "range must be a valid format like '1h' or '24h'"
        }),
      interval: Joi.string()
        .pattern(/^[0-9]+[hd]$/)
        .optional()
        .messages({
          "string.pattern.base": "interval must be a valid format like '1h' or '24h'"
        }),
      start_date: Joi.date().iso().optional(),
      end_date: Joi.date().iso().min(Joi.ref("start_date")).optional().messages({
        "date.min": "end_date must be after start_date"
      }),
      // tool_id / model / service are multi-select: accept a single string
      // (optionally comma-separated) or an array of strings (e.g. tool_id[]=a&tool_id[]=b).
      tool_id: multiString.optional(),
      model: multiString.optional(),
      service: multiString.optional(),
      user_feedback: Joi.string().valid("good", "bad", "all").optional().default("all"),
      error: Joi.string().valid("true", "false").optional(),
      version_id: Joi.string().trim().min(1).optional(),
      testcase_id: Joi.string().trim().min(1).optional(),
      keyword: Joi.string().min(1).max(500).optional(),
      message_id: Joi.string().trim().min(1).optional(),
      filter_by: Joi.object().unknown(true).optional(),
      analytics: Joi.boolean().truthy("true").falsy("false").optional().default(false),
      page: Joi.number().integer().min(1).optional().default(1),
      page_size: Joi.number().integer().min(1).max(100).optional().default(20)
    })
    .unknown(true)
};

const getAgentAnalyticsFilters = {
  params: Joi.object()
    .keys({
      bridge_id: Joi.string().trim().min(1).required().messages({
        "string.empty": "bridge_id cannot be empty",
        "any.required": "bridge_id is required"
      })
    })
    .unknown(true)
};

// One or two keys, comma-separated: variables.<key>, model or day.
const usageKey = "(?:variables\\.[A-Za-z0-9_]{1,64}|model|day)";
const variableMatch = Joi.object().pattern(/^[A-Za-z0-9_]{1,64}$/, Joi.string().allow("").max(200));

const getAgentUsage = {
  params: Joi.object()
    .keys({ bridge_id: Joi.string().trim().min(1).required() })
    .unknown(true),
  query: Joi.object()
    .keys({
      group_by: Joi.string()
        .pattern(new RegExp(`^${usageKey}(?:,${usageKey})?$`))
        .required()
        .messages({ "string.pattern.base": "group_by takes one or two of: variables.<key>, model, day" }),
      range: Joi.alternatives()
        .try(Joi.number().integer().min(1).max(365), Joi.string().pattern(/^[0-9]+[hd]$/))
        .optional(),
      // Exact matches on a variable's value. variables_ne keeps rows that do not have the variable.
      variables_eq: variableMatch.optional(),
      variables_ne: variableMatch.optional(),
      sort: Joi.string().valid("est_cost", "total_requests", "failed_runs", "total_tokens", "credits", "day").optional(),
      limit: Joi.number().integer().min(1).max(500).optional().default(50),
      filter_by: Joi.object().unknown(true).optional()
    })
    .unknown(true)
};

const getEmbedAnalytics = {
  params: Joi.object()
    .keys({
      folder_id: Joi.string().trim().min(1).required().messages({
        "string.empty": "folder_id cannot be empty",
        "any.required": "folder_id is required"
      })
    })
    .unknown(true),
  query: Joi.object()
    .keys({
      range: Joi.alternatives()
        .try(Joi.number().integer().min(1).max(365), Joi.string().pattern(/^[0-9]+[hd]$/))
        .optional()
        .messages({
          "number.max": "range cannot exceed 365 days",
          "string.pattern.base": "range must be a valid format like '1h' or '24h'"
        }),
      interval: Joi.string()
        .pattern(/^[0-9]+[hd]$/)
        .optional(),
      start_date: Joi.date().iso().optional(),
      end_date: Joi.date().iso().min(Joi.ref("start_date")).optional().messages({
        "date.min": "end_date must be after start_date"
      }),
      user_id: Joi.string().trim().min(1).optional(),
      search: Joi.string().trim().allow("").max(200).optional(),
      page: Joi.number().integer().min(1).optional(),
      limit: Joi.number().integer().min(1).max(100).optional()
    })
    .unknown(true)
};

export default {
  getAgentAnalytics,
  getAgentAnalyticsFilters,
  getAgentUsage,
  getEmbedAnalytics
};
