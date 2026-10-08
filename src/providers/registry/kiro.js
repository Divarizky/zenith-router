import "../../executors/kiro.js";

export default {
  id: "kiro",
  name: "Kiro AI",
  alias: ["kr", "kiro"],
  category: "free",
  format: "kiro",
  transport: {
    baseUrl: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    baseUrls: [
      "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
      "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
      "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    ],
    format: "kiro",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/vnd.amazon.eventstream",
      "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
      "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    },
    tokenUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
  },
  models: [
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
    { id: "claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4.5", name: "Claude Opus 4.5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
    { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
    { id: "deepseek-3.2", name: "DeepSeek 3.2" },
    { id: "qwen3-coder-next", name: "Qwen3 Coder Next" },
    { id: "glm-5", name: "GLM 5" },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
  ],
  oauth: {
    ssoOidcEndpoint: "https://oidc.us-east-1.amazonaws.com",
    tokenUrl: "https://oidc.us-east-1.amazonaws.com/token",
    deviceAuthUrl: "https://oidc.us-east-1.amazonaws.com/device_authorization",
  },
};
