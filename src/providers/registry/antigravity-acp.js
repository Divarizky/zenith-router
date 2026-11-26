import "../../executors/antigravityAcp.js";

export default {
  id: "antigravity-acp",
  name: "Antigravity ACP",
  alias: ["agy-acp"],
  category: "free",
  format: "openai",
  noAuth: true,
  supportsTools: false,
  transport: {
    format: "openai",
    baseUrl: "http://127.0.0.1/antigravity-acp",
  },
  // Models come only from per-account ACP discovery (see getProviderModels); none are invented here.
  models: [],
};
