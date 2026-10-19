import "../../executors/opencode.js";
import {
  OPENCODE_DEFAULT_BASE_URL,
  OPENCODE_LEGACY_BASE_URL,
} from "../../services/opencodeCatalog.js";

export default {
  id: "opencode",
  name: "OpenCode Free",
  alias: ["oc", "opencode"],
  category: "free",
  noAuth: true,
  // Free models change often upstream; the synced list replaces the one below,
  // which only serves until the first successful sync. The authoritative source
  // is models.opencode.ai/api.json, not the inference gateway's own model list:
  // it marks retired models and prices every entry (services/opencodeCatalog.js).
  freeModelSync: "replace",
  format: "openai",
  transport: {
    // The base the official CLI calls. The legacy `/inference/v1` gateway runs a
    // stricter abuse filter and refuses models this base serves, e.g. the
    // nemotron and space-bunny families.
    baseUrl: `${OPENCODE_DEFAULT_BASE_URL}/chat/completions`,
    // Claude-shaped bodies cannot go to the OpenAI-compatible base.
    messagesUrl: `${OPENCODE_LEGACY_BASE_URL}/messages`,
    responsesUrl: `${OPENCODE_DEFAULT_BASE_URL}/responses`,
    modelsUrl: `${OPENCODE_LEGACY_BASE_URL}/models`,
    format: "openai",
    forceStream: true,
    headers: {
      "x-opencode-client": "cli",
    },
  },
  // Mirrors the free, non-deprecated part of the catalog at the time of writing.
  models: [
    { id: "big-pickle", name: "Big Pickle Free" },
    { id: "beam-free", name: "Beam Free" },
    { id: "mimo-v2.6-flash-free", name: "MiMo v2.6 Flash Free" },
    { id: "glm-5.3-flash-free", name: "GLM 5.3 Flash Free" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free" },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free" },
    { id: "space-bunny-free", name: "Space Bunny Free" },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek v4.1 Flash Free" },
  ],
};
