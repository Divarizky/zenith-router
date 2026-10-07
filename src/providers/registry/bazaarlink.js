export default {
  id: "bazaarlink",
  name: "Bazaarlink",
  alias: ["bzl", "bazaarlink"],
  category: "apikey",
  // Sync needs an account; without one it reports no_account and keeps the static list.
  freeModelSync: "merge",
  format: "openai",
  transport: {
    baseUrl: "https://bazaarlink.ai/api/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "auto:free", name: "Auto Free (Zero Cost)" },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "gpt-5.5", name: "GPT-5.5" },
    { id: "gpt-5.4", name: "GPT-5.4" },
    { id: "grok-4.3", name: "Grok 4.3" },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
    { id: "kimi-k2.6", name: "Kimi K2.6" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "minimax-m3", name: "MiniMax M3" },
    { id: "qwen3.6-plus", name: "Qwen 3.6 Plus" },
    { id: "nemotron-3-super-120b-a12b", name: "Nemotron 3 Super" },
  ],
};
