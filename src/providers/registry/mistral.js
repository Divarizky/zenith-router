export default {
  id: "mistral",
  name: "Mistral AI",
  alias: ["mis", "mistral", "mistralai"],
  category: "apikey",
  keyUrl: "https://console.mistral.ai/api-keys",
  // Mistral Experiment (free) tier: 1B tokens/month shared across the org.
  // Every chat model on /v1/models is usable on that tier, so sync marks all
  // chat models free (Mistral returns no pricing fields).
  freeModelSync: "merge",
  format: "openai",
  transport: {
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    format: "openai",
  },
  models: [
    { id: "mistral-large-latest", name: "Mistral Large 3" },
    { id: "mistral-medium-3-5", name: "Mistral Medium 3.5" },
    { id: "mistral-small-latest", name: "Mistral Small 4" },
    { id: "devstral-latest", name: "Devstral 2" },
    { id: "codestral-latest", name: "Codestral" },
    { id: "open-mistral-nemo", name: "Mistral Nemo" },
    { id: "ministral-8b-latest", name: "Ministral 8B" },
    { id: "ministral-3b-latest", name: "Ministral 3B" },
    { id: "pixtral-large-latest", name: "Pixtral Large" },
  ],
};
