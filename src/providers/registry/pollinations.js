export default {
  id: "pollinations",
  name: "Pollinations AI",
  alias: ["poll", "pollinations"],
  category: "free",
  keyUrl: "https://pollinations.ai",
  noAuth: true,
  // Anonymous tier answers /openai/chat/completions without any key.
  // Free access is per-IP rate limited, so there is no free-model sync.
  format: "openai",
  transport: {
    baseUrl: "https://text.pollinations.ai/openai/chat/completions",
    modelsUrl: "https://text.pollinations.ai/openai/models",
    format: "openai",
  },
  models: [
    { id: "openai-fast", name: "OpenAI Fast (Pollinations)" },
  ],
};
