export default {
  id: "xkiro",
  name: "xKiro",
  alias: ["xkr", "xkiro"],
  category: "apikey",
  // 5M tokens/day (~150M/mo) free pool across models tagged access_tier: "free".
  // Public models endpoint allows syncing without an account.
  freeModelSync: "merge",
  format: "openai",
  transport: {
    baseUrl: "https://api.xkiro.com/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "qwen/qwen3-coder-plus:free", name: "Qwen3 Coder Plus" },
    { id: "minimax/minimax-m3:free", name: "MiniMax M3" },
    { id: "qwen/qwen3.6-plus:free", name: "Qwen 3.6 Plus" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "mistralai/mistral-large-2512", name: "Mistral Large 3" },
    { id: "mistralai/mistral-small-2603", name: "Mistral Small 4" },
    { id: "mistralai/codestral-2508", name: "Codestral" },
    { id: "sensenova/sensenova-6.8-flash-lite", name: "SenseNova 6.8 Flash-Lite" },
    { id: "qwen/qwen3.7-plus:free", name: "Qwen 3.7 Plus" },
    { id: "qwen/qwen3.8-max:free", name: "Qwen 3.8 Max" },
    { id: "qwen/qwen3-vl-plus:free", name: "Qwen3 VL Plus" },
  ],
};
