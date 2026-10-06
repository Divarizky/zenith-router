export default {
  id: "claude",
  name: "Claude (Anthropic)",
  alias: ["cc", "claude"],
  category: "oauth",
  format: "claude",
  transport: {
    baseUrl: "https://api.anthropic.com/v1/messages",
    format: "claude",
  },
  models: [
    { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
    { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet v2" },
    { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  ],
};
