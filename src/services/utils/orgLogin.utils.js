// Services that run on the org's own login instead of an API key. The Python gateway makes the calls.
// - claude_code: Anthropic models through the org's Claude login (the token `claude setup-token` prints).
// - codex: OpenAI models through the org's ChatGPT login (the contents of ~/.codex/auth.json).
// An org saves one login and every agent set to the service uses it, with no key to pick per agent.
import axios from "axios";
import jwt from "jsonwebtoken";

const CLAUDE_CODE = "claude_code";
const CODEX = "codex";
const ORG_LOGIN_SERVICES = {
  [CLAUDE_CODE]: { label: "Claude", verifyPath: "claude_code/verify", serviceName: "Claude Code" },
  [CODEX]: { label: "ChatGPT", verifyPath: "codex/verify", serviceName: "Codex" }
};
// Same environment switch as latency.service.js. GTWY_API_URL points it somewhere else, for
// example at a gateway running on this machine (http://localhost:8080).
const GATEWAY_URL = process.env.GTWY_API_URL || (process.env.ENVIRONMENT === "TESTING" ? "https://dev-api.gtwy.ai" : "https://api.gtwy.ai");
const VERIFY_TIMEOUT_MS = 100000;

const isOrgLoginService = (service) => Boolean(ORG_LOGIN_SERVICES[service]);

// The gateway caches the org's login under this key (same Redis prefix in both servers).
const orgLoginCacheKey = (service, org_id) => `${service}_login_${org_id}`;
const allOrgLoginCacheKeys = (org_id) => Object.keys(ORG_LOGIN_SERVICES).map((service) => orgLoginCacheKey(service, org_id));

// What is pasted, as it is checked and saved. A Claude token copied from a wrapped terminal line
// carries a line break; a ChatGPT login is a JSON file and only loses the space around it.
const normalizeOrgLogin = (service, apikey) => {
  const text = String(apikey || "");
  return service === CLAUDE_CODE ? text.replace(/\s+/g, "") : text.trim();
};

// A login cannot be checked with one HTTP call from here; the gateway makes one tiny call on it.
async function verifyOrgLogin(service, login, org_id, user_id) {
  const { verifyPath, serviceName } = ORG_LOGIN_SERVICES[service];
  const authorization = jwt.sign({ org: { id: String(org_id) }, user: { id: String(user_id) } }, process.env.SecretKey, { expiresIn: 120 });
  try {
    await axios.post(
      `${GATEWAY_URL}/api/v2/model/${verifyPath}`,
      { apikey: login },
      { headers: { Authorization: authorization }, timeout: VERIFY_TIMEOUT_MS }
    );
    return { success: true };
  } catch (error) {
    const detail = error.response?.data?.detail;
    if (error.response?.status === 404 && !detail?.error) {
      return { success: false, error: `the gateway at ${GATEWAY_URL} does not have the ${serviceName} service yet` };
    }
    return { success: false, error: detail?.error || error.message };
  }
}

export { CLAUDE_CODE, CODEX, ORG_LOGIN_SERVICES, isOrgLoginService, orgLoginCacheKey, allOrgLoginCacheKeys, normalizeOrgLogin, verifyOrgLogin };
