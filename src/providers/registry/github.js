export default {
  id: "github",
  name: "GitHub Copilot",
  alias: ["gh", "copilot", "github"],
  category: "oauth",
  format: "openai",
  transport: {
    baseUrl: "https://api.githubcopilot.com/chat/completions",
    format: "openai",
  },
  models: [
    { id: "gpt-4o", name: "GPT-4o (Copilot)" },
    { id: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet (Copilot)" },
    { id: "claude-3.7-sonnet", name: "Claude 3.7 Sonnet (Copilot)" },
    { id: "o3-mini", name: "o3-mini (Copilot)" },
    { id: "gpt-5.2", name: "GPT-5.2 (Copilot)" },
  ],
};
