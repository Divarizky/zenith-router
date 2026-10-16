/**
 * Filter for OpenCode free models.
 * Free models typically carry the `-free` suffix, `-contributor`, or the standalone `big-pickle`.
 * JEV models are evaluation models and excluded.
 */
export function isFreeOpencodeModel(id) {
  const lower = String(id || "").toLowerCase();
  if (lower.startsWith("jev-")) return false;
  return lower.endsWith("-free") || lower.includes("-contributor") || lower === "big-pickle";
}
