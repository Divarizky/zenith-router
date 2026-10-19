import { parseOpencodeCatalog, setOpencodeCatalog } from "./opencodeCatalog.js";

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

/**
 * Free models from a models.opencode.ai/api.json payload. Cost decides, not the
 * name: the suffix lies on both sides (`jev-1.13-free` is free evaluation-only,
 * `claude-fable-5` has no suffix but is paid), and `status: deprecated` is the
 * only way to know upstream retired a model before it answers 410.
 *
 * The parsed snapshot is installed as a side effect so endpoint resolution and
 * the model list always come from the same payload.
 */
export function parseOpencodeCatalogFreeModels(json) {
  const parsed = parseOpencodeCatalog(json);
  if (!parsed) return [];
  setOpencodeCatalog(json);
  const out = [];
  for (const model of parsed.models.values()) {
    if (/^jev-/i.test(model.id)) continue;
    out.push({ id: model.id, name: model.name, isFree: model.isFree && !model.deprecated });
  }
  return out;
}
