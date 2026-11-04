export default {
  id: "kilocode",
  name: "Kilo Code",
  alias: ["kc", "kilocode"],
  category: "oauth",
  // Kilo's free models are synced and added to the list below, like the upstream kiloFreeModels.
  freeModelSync: "merge",
  // Semua model Kilo yang tersinkron melayani tool calling (klaim per provider untuk gate agentic).
  supportsTools: true,
  format: "openai",
  transport: {
    baseUrl: "https://api.kilo.ai/api/openrouter/chat/completions",
    format: "openai",
  },
  models: [
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
  ],
};
