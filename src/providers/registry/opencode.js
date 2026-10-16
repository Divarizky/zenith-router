import "../../executors/opencode.js";

export default {
  id: "opencode",
  name: "OpenCode Free",
  alias: ["oc", "opencode"],
  category: "free",
  noAuth: true,
  // Free models change often upstream; the synced list replaces the one below,
  // which only serves until the first successful sync.
  freeModelSync: "replace",
  format: "openai",
  transport: {
    baseUrl: "https://opencode.ai/inference/v1/chat/completions",
    messagesUrl: "https://opencode.ai/inference/v1/messages",
    responsesUrl: "https://opencode.ai/inference/v1/responses",
    modelsUrl: "https://opencode.ai/inference/v1/models",
    format: "openai",
    forceStream: true,
    headers: {
      "x-opencode-client": "cli",
    },
  },
  models: [
    { id: "big-pickle", name: "Big Pickle Free" },
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Free" },
    { id: "mimo-v2.6-flash-free", name: "Mimo v2.6 Flash Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free" },
    { id: "cat-jam-free", name: "Cat Jam Free" },
    { id: "space-bunny-free", name: "Space Bunny Free" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek v4.1 Flash Free" },
    { id: "step-5-preview-free", name: "Step 5 Preview Free" },
  ],
};
