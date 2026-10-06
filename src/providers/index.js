import claude from "./registry/claude.js";
import codex from "./registry/codex.js";
import github from "./registry/github.js";
import kiro from "./registry/kiro.js";
import antigravity from "./registry/antigravity.js";
import glm from "./registry/glm.js";
import opencode from "./registry/opencode.js";
import kilocode from "./registry/kilocode.js";

const REGISTRY = [claude, codex, github, kiro, antigravity, glm, opencode, kilocode];

const providerMap = new Map();
const aliasMap = new Map();

for (const p of REGISTRY) {
  providerMap.set(p.id, p);
  const aliases = Array.isArray(p.alias) ? p.alias : [p.alias || p.id];
  for (const a of aliases) {
    aliasMap.set(a.toLowerCase(), p);
  }
}

/**
 * Get provider definition by ID or Alias
 */
export function getProvider(idOrAlias) {
  if (!idOrAlias) return null;
  const key = String(idOrAlias).toLowerCase();
  return providerMap.get(key) || aliasMap.get(key) || null;
}

/**
 * Get all registered providers
 */
export function getAllProviders() {
  return REGISTRY;
}

/**
 * Resolve routing model string into { provider, targetModel }
 * Format examples:
 *   - "cc/claude-3-7-sonnet" -> provider: claude, targetModel: "claude-3-7-sonnet"
 *   - "glm/glm-4-flash"      -> provider: glm, targetModel: "glm-4-flash"
 *   - "claude-3-5-sonnet"    -> provider inferred by prefix
 */
export function resolveModel(modelStr) {
  if (!modelStr || typeof modelStr !== "string") return null;

  const slashIdx = modelStr.indexOf("/");
  const colonIdx = modelStr.indexOf(":");
  const sepIdx = slashIdx !== -1 ? slashIdx : colonIdx;

  if (sepIdx !== -1) {
    const prefix = modelStr.slice(0, sepIdx);
    const targetModel = modelStr.slice(sepIdx + 1);
    const provider = getProvider(prefix);
    if (provider) {
      return { provider, targetModel, rawModel: modelStr };
    }
  }

  // Guess provider by model name prefix if no slash given
  if (modelStr.startsWith("claude-")) {
    return { provider: getProvider("claude"), targetModel: modelStr, rawModel: modelStr };
  }
  if (modelStr.startsWith("gpt-") || modelStr.startsWith("o1") || modelStr.startsWith("o3")) {
    return { provider: getProvider("codex"), targetModel: modelStr, rawModel: modelStr };
  }
  if (modelStr.startsWith("gemini-")) {
    return { provider: getProvider("antigravity"), targetModel: modelStr, rawModel: modelStr };
  }
  if (modelStr.startsWith("glm-") || modelStr.startsWith("codegeex")) {
    return { provider: getProvider("glm"), targetModel: modelStr, rawModel: modelStr };
  }

  return null;
}

/**
 * Return list of all available models in OpenAI Model List format
 */
export function getAvailableModels() {
  const result = [];
  const now = Math.floor(Date.now() / 1000);

  for (const p of REGISTRY) {
    const primaryAlias = Array.isArray(p.alias) ? p.alias[0] : (p.alias || p.id);

    for (const m of p.models) {
      // Direct prefixed model: e.g. "glm/glm-4-flash"
      result.push({
        id: `${primaryAlias}/${m.id}`,
        object: "model",
        created: now,
        owned_by: p.id,
        permission: [],
        root: m.id,
        parent: null,
      });

      // Also register bare model name if unique or standard
      result.push({
        id: `${p.id}/${m.id}`,
        object: "model",
        created: now,
        owned_by: p.id,
        permission: [],
        root: m.id,
        parent: null,
      });
    }
  }

  // Deduplicate by id
  const seen = new Set();
  return result.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
