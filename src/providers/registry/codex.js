export default {
  id: "codex",
  name: "OpenAI Codex",
  alias: ["cx", "codex"],
  category: "oauth",
  format: "openai-responses",
  transport: {
    baseUrl: "https://chatgpt.com/backend-api/lat/r",
    format: "openai-responses",
  },
  models: [
    { id: "gpt-4o", name: "GPT-4o" },
    { id: "gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "o1", name: "OpenAI o1" },
    { id: "o3-mini", name: "OpenAI o3-mini" },
    { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
  ],
};
