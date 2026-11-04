import "../../executors/kilocode.js";

export default {
  id: "kilo-free",
  name: "Kilo Code Free Tier",
  alias: ["kcf", "kilo-free"],
  category: "free",
  noAuth: true,
  supportsTools: true,
  format: "openai",
  transport: {
    baseUrl: "https://api.kilo.ai/api/gateway/chat/completions",
    modelsUrl: "https://api.kilo.ai/api/gateway/models",
    format: "openai",
  },
  models: [
    { id: "kilo-auto/free", name: "Auto Free" },
    { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning Free" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra Free" },
    { id: "nvidia/nemotron-3.5-super-vl:free", name: "Nemotron 3.5 Super VL Free" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni Free" },
    { id: "openrouter/free", name: "OpenRouter Free Models Router" },
    { id: "dots-studio/dots-3-note-preview:free", name: "Dots 3 Note Preview Free" },
    { id: "liquid/lfm-2.5-2.6b:free", name: "Liquid LFM 2.5 2.6B Free" },
    { id: "cohere/north-mini-code:free", name: "Cohere North Mini Code Free" },
    { id: "recursive/flint-v1.0:free", name: "Recursive Flint Free" },
    { id: "xingchen-agi/xing4.0-29b-a4b:free", name: "XingChen 4.0 29B Free" },
    { id: "reflection/beam-free", name: "Reflection Beam 1.0 Free" },
    { id: "inclusionai/ling-3.1-flash-1019-free", name: "Ling 3.1 Flash Free" },
  ],
};
