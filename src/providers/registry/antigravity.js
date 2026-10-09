import "../../executors/antigravity.js";

const ANTIGRAVITY_IDE_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_IDE_USER_AGENT = "antigravity/ide/0.0.1 darwin/arm64";

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
      "User-Agent": ANTIGRAVITY_IDE_USER_AGENT,
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
  // Tier variants of *-flash-tiered: the tier travels as generationConfig.thinkingConfig.thinkingLevel.
  // Appending "(high)" to the model name makes Google answer 404 (verified against a live account).
  models: [
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)", upstreamModelId: "gemini-3.8-flash-tiered", thinkingLevel: "high" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)", upstreamModelId: "gemini-3.8-flash-tiered", thinkingLevel: "medium" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)", upstreamModelId: "gemini-3.8-flash-tiered", thinkingLevel: "low" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", upstreamModelId: "gemini-3.8-flash-tiered", thinkingLevel: "medium" },
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)", upstreamModelId: "gemini-3.7-flash-tiered", thinkingLevel: "high" },
    { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)", upstreamModelId: "gemini-3.7-flash-tiered", thinkingLevel: "medium" },
    { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)", upstreamModelId: "gemini-3.7-flash-tiered", thinkingLevel: "low" },
    { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)", upstreamModelId: "gemini-3.6-flash-tiered", thinkingLevel: "high" },
    { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)", upstreamModelId: "gemini-3.6-flash-tiered", thinkingLevel: "medium" },
    { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)", upstreamModelId: "gemini-3.6-flash-tiered", thinkingLevel: "low" },
    { id: "gemini-3.5-flash-high", name: "Gemini 3.5 Flash (High)", upstreamModelId: "gemini-3-flash-agent" },
    { id: "gemini-3.5-flash-low", name: "Gemini 3.5 Flash (Low)" },
    { id: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
  ],
  oauth: {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  },
};
