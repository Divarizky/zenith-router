export const FORMATS = {
  OPENAI: "openai",
  CLAUDE: "claude",
  OPENAI_RESPONSES: "openai-responses",
  GEMINI: "gemini",
  KIRO: "kiro",
};

export function normalizeFormat(fmt) {
  if (!fmt) return FORMATS.OPENAI;
  const f = String(fmt).toLowerCase();
  if (f === "claude" || f === "anthropic") return FORMATS.CLAUDE;
  if (f === "openai-responses" || f === "responses") return FORMATS.OPENAI_RESPONSES;
  if (f === "gemini" || f === "cloudcode" || f === "antigravity") return FORMATS.GEMINI;
  if (f === "kiro" || f === "codewhisperer") return FORMATS.KIRO;
  return FORMATS.OPENAI;
}
