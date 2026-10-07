import "../../executors/freebuff.js";

export default {
  id: "freebuff",
  name: "Freebuff",
  alias: ["fb", "freebuff"],
  category: "oauth",
  format: "openai",
  executor: "freebuff",
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "minimax/minimax-m3", name: "MiniMax M3" },
    { id: "mimo/mimo-v2.5", name: "MiMo v2.5" },
    { id: "z-ai/glm-5.2", name: "GLM 5.2" },
    { id: "crof/kimi-k3-eco", name: "Kimi K3 Eco" },
    { id: "anthropic/claude-fable-5", name: "Claude Fable 5" },
    { id: "meta/muse-spark-1.2-contributor", name: "Meta Muse Spark 1.2 Contributor" },
  ],
};
