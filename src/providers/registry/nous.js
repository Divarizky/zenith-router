export default {
  id: "nous",
  name: "Nous Research",
  alias: ["nous", "nousresearch"],
  category: "apikey",
  keyUrl: "https://portal.nousresearch.com",
  supportsTools: true,
  // Single active turn per account with minimum spacing so the fair-share rate
  // limit window on free-tier models (e.g. qwen4-max) is not exceeded by concurrent turns.
  concurrency: 1,
  serialTurns: true,
  softRateLimit: true,
  throttleMs: 2500,
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
