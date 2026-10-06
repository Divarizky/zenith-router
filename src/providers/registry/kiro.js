export default {
  id: "kiro",
  name: "Kiro AI (Amazon Bedrock)",
  alias: ["kr", "kiro"],
  category: "free",
  format: "kiro",
  transport: {
    baseUrl: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    format: "kiro",
  },
  models: [
    { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet (Kiro)" },
    { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet (Kiro)" },
    { id: "gpt-4o", name: "GPT-4o (Kiro)" },
  ],
};
