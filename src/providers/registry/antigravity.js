export default {
  id: "antigravity",
  name: "Antigravity (Google)",
  alias: ["ag", "antigravity"],
  category: "oauth",
  format: "antigravity",
  transport: {
    baseUrl: "https://autopush-alkalicognition-pa.sandbox.googleapis.com/v1",
    format: "antigravity",
  },
  models: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet (Antigravity)" },
  ],
};
