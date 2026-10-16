import "../../executors/antigravity.js";
import { antigravityUserAgent } from "../../services/antigravityIdentity.js";

const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";

export default {
  id: "antigravity",
  name: "Antigravity (Google)",
  alias: ["ag", "antigravity"],
  category: "oauth",
  format: "antigravity",
  transport: {
    baseUrls: [ANTIGRAVITY_IDE_BASE_URL],
    format: "antigravity",
    headers: {
      "User-Agent": antigravityUserAgent(),
    },
    retry: {
      429: 3,
      500: 3,
      503: 3,
    },
    usage: {
      quotaApiUrl: `${ANTIGRAVITY_IDE_BASE_URL}/v1internal:fetchAvailableModels`,
    },
  },
  // One entry per family; the thinking level selects the runtime id upstream.
  // Suffixed runtime ids (-low/-medium/-high) are not catalog entries any more:
  // the level comes from the request (reasoning_effort / reasoning.effort /
  // thinking.budget_tokens), defaulting to medium like agy's own
  // defaultAgentModelId. A `-tiered` family takes the level as thinkingLevel.
  models: [
    {
      id: "gemini-4-argon",
      name: "Gemini 4 Argon",
      variants: { low: "gemini-4-argon-low", medium: "gemini-4-argon-medium", high: "gemini-4-argon-high" },
    },
    {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      // Medium maps to the -tiered bucket, which carries the level itself as
      // thinkingLevel. An account that lists its own -low/-high overrides these
      // entries, and one with no bucket at all falls back within the variants it
      // has (see resolveProviderRuntime).
      variants: { low: "gemini-3.8-flash-tiered", medium: "gemini-3.8-flash-tiered", high: "gemini-3.8-flash-tiered" },
      tiered: "gemini-3.8-flash-tiered",
    },
    {
      id: "gemini-3.5-flash",
      name: "Gemini 3.5 Flash",
      variants: { low: "gemini-3.5-flash-extra-low", medium: "gemini-3.5-flash-low", high: "gemini-3-flash-agent" },
    },
    { id: "gemini-3-flash", name: "Gemini 3 Flash", unsuffixed: "gemini-3-flash" },
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      variants: { low: "claude-opus-5-5-low", medium: "claude-opus-5-5-medium", high: "claude-opus-5-5-high" },
    },
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      variants: { low: "claude-sonnet-5-5-low", medium: "claude-sonnet-5-5-medium", high: "claude-sonnet-5-5-high" },
    },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", variants: { high: "claude-opus-4-6-thinking" } },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", unsuffixed: "claude-sonnet-4-6" },
    { id: "gpt-oss-120b", name: "GPT-OSS 120B", variants: { medium: "gpt-oss-120b-medium" } },
  ],
  oauth: {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  },
};
