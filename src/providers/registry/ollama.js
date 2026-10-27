export default {
  id: "ollama",
  name: "Ollama Cloud",
  alias: ["ol", "ollama", "ollama-cloud"],
  category: "apikey",
  keyUrl: "https://ollama.com/settings/keys",
  // /v1/models is public; chat completions require an API key from https://ollama.com/settings/keys.
  freeModelSync: "merge",
  format: "openai",
  transport: {
    baseUrl: "https://ollama.com/v1/chat/completions",
    format: "openai",
  },
  // Hanya model yang bisa dipanggil key free plan (diverifikasi 27-10-2026,
  // daftar yang sama dengan FREE_OLLAMA di services/modelImport.js). Model cloud
  // berbayar butuh usage credits dan hanya akan gagal 402 di upstream.
  models: [
    { id: "gemma4:31b", name: "Gemma 4 31B" },
    { id: "gemma4:31b-cloud", name: "Gemma 4 31B Cloud" },
    { id: "gpt-oss:120b", name: "GPT OSS 120B" },
    { id: "gpt-oss:20b", name: "GPT OSS 20B" },
    { id: "nemotron-3-ultra", name: "Nemotron 3 Ultra" },
    { id: "nemotron-3-super", name: "Nemotron 3 Super" },
    { id: "nemotron-3-nano:30b", name: "Nemotron 3 Nano 30B" },
    { id: "beam", name: "Beam" },
  ],
};
