export default {
  id: "llm7",
  name: "LLM7 Free Tier",
  alias: ["llm7", "l7", "llm7-free"],
  category: "free",
  noAuth: true,
  supportsTools: true,
  // Merged, not replaced: `default` and `fast` are chat aliases the /v1/models
  // list never carries, and a hardcoded id can be retired upstream without the
  // alias disappearing. Retired ids are dropped by the catalog refresh instead.
  freeModelSync: "merge",
  catalogRefresh: true,
  builtinAliases: ["default", "fast"],
  format: "openai",
  transport: {
    baseUrl: "https://api.llm7.io/v1/chat/completions",
    modelsUrl: "https://api.llm7.io/v1/models",
    format: "openai",
  },
  models: [
    { id: "default", name: "LLM7 Default" },
    { id: "fast", name: "LLM7 Fast" },
    { id: "minimax-m2.7", name: "MiniMax M2.7 (LLM7)" },
    { id: "codestral-latest", name: "Codestral Latest (LLM7)" },
    { id: "gpt-oss:20b", name: "GPT-OSS 20B (LLM7)" },
    { id: "mistral-Nemo-Instruct-2407", name: "Mistral Nemo Instruct 2407 (LLM7)" },
    { id: "nemotron-3-nano:30b", name: "Nemotron 3 Nano 30B (LLM7)" },
    { id: "DeepSeek-V4-Flash-0731", name: "DeepSeek V4 Flash 0731 (LLM7)" },
    { id: "GLM-5.3-Flash", name: "GLM 5.3 Flash (LLM7)" },
  ],
};
