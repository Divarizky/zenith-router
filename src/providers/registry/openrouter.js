export default {
  id: "openrouter",
  name: "OpenRouter",
  alias: ["or", "openrouter"],
  category: "apikey",
  keyUrl: "https://openrouter.ai/keys",
  // /api/v1/models is public; paid models in the list need an API key.
  freeModelSync: "merge",
  format: "openai",
  transport: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    format: "openai",
    headers: {
      "HTTP-Referer": "https://zenith.local",
      "X-Title": "Zenith Router",
    },
  },
  models: [
    { id: "openrouter/auto", name: "Auto (Best for Prompt)" },
    { id: "openai/gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek V3" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct" },
  ],
};
