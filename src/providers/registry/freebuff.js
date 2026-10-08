import "../../executors/freebuff.js";

// Free models: CodebuffAI/freebuff common/src/constants/freebuff-models.ts
// (SUPPORTED_FREEBUFF_MODELS minus withdrawn/paused/paid-only rows) and the
// official model->agent map common/src/constants/free-agents.ts
// (FREEBUFF_ROOT_AGENT_ID_BY_MODEL).
export default {
  id: "freebuff",
  name: "Freebuff",
  alias: ["fb", "freebuff"],
  category: "oauth",
  // Free catalog synced from CodebuffAI/freebuff repository constants on GitHub
  freeModelSync: "merge",
  format: "openai",
  executor: "freebuff",
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "mimo/mimo-v2.5", name: "MiMo 2.6 Flash (Default)" },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek/deepseek-v4-flash-fast", name: "DeepSeek V4 Flash Fast" },
    { id: "openai/gpt-6-luna", name: "GPT-6 Luna" },
    { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol" },
    { id: "mimo/mimo-v2.6-pro", name: "MiMo 2.6 Pro" },
    { id: "minimax/minimax-m3", name: "MiniMax M3" },
    { id: "anthropic/claude-fable-5.1", name: "Claude Fable 5.1" },
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2" },
    { id: "upstage/solar-mini4", name: "Solar Mini 4" },
    { id: "upstage/solar-pro4", name: "Solar Pro 4" },
    { id: "crof/kimi-k3-eco", name: "Kimi K3 Eco" },
  ],
};
