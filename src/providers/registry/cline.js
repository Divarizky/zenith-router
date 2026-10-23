import "../../executors/cline.js";

// Cline quirks (from the upstream reference): non-streaming requests are forced to
// stream upstream, then SSE is aggregated back into a normal completion. Some
// non-streaming responses are wrapped in {"success":true,"data":{...}} and are
// unwrapped by the gateway.
export default {
  id: "cline",
  name: "Cline",
  alias: ["cl", "cline"],
  category: "oauth",
  // The free catalog is published by the public recommended-models feed,
  // so sync works without an account (upstream clinepassModels.js).
  freeModelSync: "merge",
  format: "openai",
  // Envelope {"success":false} dengan HTTP 200 diubah jadi status error
  // supaya fallback dan combo berjalan (src/executors/cline.js).
  executor: "cline",
  transport: {
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    forceStream: true,
    format: "openai",
    headers: {
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
    },
  },
  models: [
    { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5" },
    { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "spacexai/grok-4.7", name: "Grok 4.7" },
    { id: "openai/gpt-6-astra", name: "GPT-6 Astra" },
    { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "moonshotai/kimi-k3", name: "Kimi K3" },
  ],
};
