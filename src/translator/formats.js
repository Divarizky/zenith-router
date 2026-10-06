export const FORMATS = {
  OPENAI: "openai",
  CLAUDE: "claude",
};

export function normalizeFormat(fmt) {
  if (!fmt) return FORMATS.OPENAI;
  const f = String(fmt).toLowerCase();
  if (f === "claude" || f === "anthropic") return FORMATS.CLAUDE;
  return FORMATS.OPENAI;
}
