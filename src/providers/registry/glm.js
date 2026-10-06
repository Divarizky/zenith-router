export default {
  id: "glm",
  name: "Zai GLM Coding",
  alias: ["glm", "zai"],
  category: "oauth",
  format: "openai",
  transport: {
    baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
    messagesUrl: "https://api.z.ai/api/coding/paas/v4/messages",
    format: "openai",
  },
  models: [
    { id: "glm-4-plus", name: "GLM-4 Plus" },
    { id: "glm-4-flash", name: "GLM-4 Flash" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "codegeex-4", name: "CodeGeeX 4" },
  ],
};
