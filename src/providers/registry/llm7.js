export default {
  id: "llm7",
  name: "LLM7",
  alias: ["llm7", "l7"],
  category: "apikey",
  format: "openai",
  transport: {
    baseUrl: "https://api.llm7.io/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "gpt-5.5", name: "GPT-5.5 (LLM7)" },
    { id: "claude-opus-5", name: "Claude Opus 5 (LLM7)" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (LLM7)" },
    { id: "grok-4.5", name: "Grok 4.5 (LLM7)" },
    { id: "kimi-k3", name: "Kimi K3 (LLM7)" },
  ],
};
