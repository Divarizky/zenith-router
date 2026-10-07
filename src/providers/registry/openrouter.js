export default {
  id: "openrouter",
  name: "OpenRouter",
  alias: ["or", "openrouter"],
  category: "apikey",
  format: "openai",
  transport: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    format: "openai",
    headers: {
      "HTTP-Referer": "https://zenroute.local",
      "X-Title": "zenroute",
    },
  },
  models: [
    { id: "auto", name: "Auto (Best for Prompt)" },
    { id: "openai/gpt-4o-mini", name: "GPT-4o Mini" },
    { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek V3" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B Instruct" },
    { id: "google/gemini-2.0-flash-exp:free", name: "Gemini 2.0 Flash (Free)" },
    { id: "meta-llama/llama-3.3-70b-instruct:free", name: "Llama 3.3 70B (Free)" },
    { id: "qwen/qwen-2.5-coder-32b-instruct:free", name: "Qwen 2.5 Coder 32B (Free)" },
    { id: "deepseek/deepseek-r1:free", name: "DeepSeek R1 (Free)" },
  ],
};
