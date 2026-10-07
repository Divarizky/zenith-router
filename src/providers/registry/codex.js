import "../../executors/codex.js";

const CODEX_CLI_VERSION = "0.159.0";

export default {
  id: "codex",
  name: "OpenAI Codex",
  alias: ["cx", "codex"],
  category: "oauth",
  format: "openai-responses",
  transport: {
    baseUrl: "https://chatgpt.com/backend-api/codex/responses",
    format: "openai-responses",
    forceStream: true,
    cliVersion: CODEX_CLI_VERSION,
    headers: {
      originator: "codex_cli_rs",
      "User-Agent": `codex_cli_rs/${CODEX_CLI_VERSION}`,
      version: CODEX_CLI_VERSION,
    },
    usage: {
      url: "https://chatgpt.com/backend-api/wham/usage",
    },
  },
  models: [
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
    { id: "gpt-6-astra", name: "GPT 6.0 Astra" },
    { id: "gpt-6-sol", name: "GPT 6.0 Sol" },
    { id: "gpt-6-luna", name: "GPT 6.0 Luna" },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
  ],
  oauth: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
  },
};
