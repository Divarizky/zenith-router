// Cline quirks (from 9router/OmniRoute), not yet handled by the gateway:
// - Non-streaming responses are wrapped in {"success":true,"data":{...}}.
// - Non-streaming requests fail upstream; they need forceStream + SSE-to-JSON
//   conversion. Stream requests work without changes.
// ponytail: add `forceStream` + envelope unwrap when non-stream Cline support is needed.
export default {
  id: "cline",
  name: "Cline",
  alias: ["cl", "cline"],
  category: "oauth",
  // The free catalog is published by the public recommended-models feed,
  // so sync works without an account (9router clinepassModels.js).
  freeModelSync: "merge",
  format: "openai",
  transport: {
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    format: "openai",
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
    },
  },
  models: [
    { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    { id: "x-ai/grok-4.5", name: "Grok 4.5" },
    { id: "openai/gpt-5.6-sol", name: "GPT-5.6 Sol" },
    { id: "moonshotai/kimi-k3", name: "Kimi K3" },
    { id: "anthropic/claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "openrouter/free", name: "Free Models Router" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (Free)" },
    { id: "tencent/hy3:free", name: "Tencent Hy3 (Free)" },
    { id: "stepfun/step-3.7-flash", name: "Step 3.7 Flash (Free)" },
    { id: "poolside/laguna-m.1:free", name: "Laguna M.1 (Free)" },
    { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B (Free)" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra (Free)" },
    { id: "minimax/minimax-m3", name: "MiniMax M3 (Free)" },
  ],
};
