export default {
  id: "opencode",
  name: "OpenCode Free",
  alias: ["oc", "opencode"],
  category: "free",
  noAuth: true,
  format: "openai",
  transport: {
    baseUrl: "https://opencode.ai/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Free" },
    { id: "union-alpha", name: "Union Alpha Free" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free" },
  ],
};
