export default {
  id: "mistral",
  name: "Mistral AI",
  alias: ["mis", "mistral", "mistralai"],
  category: "apikey",
  keyUrl: "https://console.mistral.ai/api-keys",
  // Mistral Experiment (free) tier: 1B tokens/month shared across the org, but
  // not every model on /v1/models is callable on it (some have a 0/minute limit
  // or tier_not_allowed). Sync keeps only the chat models the account can call
  // and replaces the list below, which is a fallback until the first sync.
  freeModelSync: "replace",
  format: "openai",
  transport: {
    baseUrl: "https://api.mistral.ai/v1/chat/completions",
    format: "openai",
    // Mistral rejects unknown fields with 422 extra_forbidden, and OpenAI
    // clients like Pi send several of them. Map the ones with a Mistral
    // equivalent and drop the rest.
    paramRenames: { max_completion_tokens: "max_tokens", seed: "random_seed" },
    dropParams: ["store", "user", "logit_bias", "verbosity", "web_search_options"],
    // Mistral only accepts tool call ids of exactly 9 alphanumeric characters,
    // so ids from other models in the history (call_123..., toolu_...) are remapped.
    toolCallIds: "alnum9",
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
