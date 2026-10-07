export default {
  id: "ovhcloud",
  name: "OVHcloud AI Endpoints",
  alias: ["ovh", "ovhcloud"],
  category: "free",
  noAuth: true,
  // Anonymous tier answers /chat/completions without API key (2 req/min per IP).
  // An optional OVHcloud key raises the limit to 400 req/min.
  freeModelSync: "replace",
  format: "openai",
  transport: {
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "gpt-oss-120b", name: "GPT-OSS 120B" },
    { id: "gpt-oss-20b", name: "GPT-OSS 20B" },
    { id: "Qwen3.6-27B", name: "Qwen 3.6 27B" },
    { id: "Mistral-Small-3.2-24B-Instruct-2506", name: "Mistral Small 3.2 24B" },
    { id: "Qwen2.5-VL-72B-Instruct", name: "Qwen 2.5 VL 72B" },
  ],
};
