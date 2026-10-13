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
    baseUrl: "https://opencode.ai/zen/v1/chat/completions",
    messagesUrl: "https://opencode.ai/zen/v1/messages",
    responsesUrl: "https://opencode.ai/zen/v1/responses",
    format: "openai",
    forceStream: true,
    headers: {
      "x-opencode-client": "desktop",
    },
  },
  models: [
    { id: "big-pickle", name: "Big Pickle Free" },
    { id: "exo-free", name: "Exo Free" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free" },
    { id: "mimo-v2.6-flash-free", name: "Mimo v2.6 Flash Free" },
    { id: "space-bunny-free", name: "Space Bunny Free" },
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free" },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Free" },
    { id: "jev-1.13-free", name: "Jev 1.13 Free" },
  ],
};
