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
  // AC-01 deliberately exposes one model while the ACP surface is validated.
  models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (ACP)" }],
};
