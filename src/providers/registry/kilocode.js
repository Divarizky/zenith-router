export default {
  id: "kilocode",
  name: "Kilo Code Free Tier",
  alias: ["kc", "kilocode"],
  category: "oauth",
  format: "openai",
  transport: {
    baseUrl: "https://api.kilo.ai/api/openrouter/chat/completions",
    format: "openai",
  },
  models: [
    { id: "deepseek-chat", name: "DeepSeek Chat (Kilo)" },
    { id: "deepseek-coder", name: "DeepSeek Coder (Kilo)" },
    { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4 (Kilo)" },
  ],
};
