export default {
  id: "nous",
  name: "Nous Research",
  alias: ["nous", "nousresearch"],
  category: "apikey",
  keyUrl: "https://portal.nousresearch.com",
  supportsTools: true,
  // No seeded ids: the free list comes only from the public /v1/models catalog
  // (see IMPORTERS.nous), so it is empty until the first successful sync.
  freeModelSync: "merge",
  format: "openai",
  transport: {
    baseUrl: "https://inference-api.nousresearch.com/v1/chat/completions",
    modelsUrl: "https://inference-api.nousresearch.com/v1/models",
    format: "openai",
  },
  models: [],
};
