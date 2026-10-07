import claude from "./registry/claude.js";
import codex from "./registry/codex.js";
import github from "./registry/github.js";
import kiro from "./registry/kiro.js";
import antigravity from "./registry/antigravity.js";
import glm from "./registry/glm.js";
import opencode from "./registry/opencode.js";
import kilocode from "./registry/kilocode.js";
import nvidia from "./registry/nvidia.js";
import cline from "./registry/cline.js";
import mistral from "./registry/mistral.js";
import cloudflareAi from "./registry/cloudflare-ai.js";
import openrouter from "./registry/openrouter.js";
import llm7 from "./registry/llm7.js";
import bazaarlink from "./registry/bazaarlink.js";
import together from "./registry/together.js";
import freebuff from "./registry/freebuff.js";
import ollama from "./registry/ollama.js";
import commandcode from "./registry/commandcode.js";
import ovhcloud from "./registry/ovhcloud.js";
import xkiro from "./registry/xkiro.js";
import { listCustomModels, listImportedModels, listSyncedModels, isModelDisabled } from "../services/modelOverrides.js";

const REGISTRY = [
  claude,
  codex,
  github,
  kiro,
  antigravity,
  glm,
  opencode,
  kilocode,
  nvidia,
  cline,
  mistral,
  cloudflareAi,
  openrouter,
  llm7,
  bazaarlink,
  together,
  freebuff,
  ollama,
  commandcode,
  ovhcloud,
  xkiro,
];

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
 * Built-in models of a provider: `{ id, name, source }` with source "builtin" or "synced".
 * Providers with `freeModelSync` use their last synced free list: "replace" swaps out the
 * hardcoded list (kept only as a fallback until the first sync), "merge" adds to it.
 */
export function getProviderModels(p) {
  const staticModels = p.models.map((m) => ({ id: m.id, name: m.name, source: "builtin" }));
  if (!p.freeModelSync) return staticModels;

  const synced = listSyncedModels(p.id).map((m) => ({ id: m.model_id, name: m.name || m.model_id, source: "synced" }));
  if (synced.length === 0) return staticModels;
  if (p.freeModelSync === "replace") return synced;

  const staticIds = new Set(staticModels.map((m) => m.id));
  return [...staticModels, ...synced.filter((m) => !staticIds.has(m.id))];
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

  const checkDisabled = (provider, targetModel) =>
    provider && !isModelDisabled(provider.id, targetModel) ? { provider, targetModel, rawModel: modelStr } : null;

  if (sepIdx !== -1) {
    const prefix = modelStr.slice(0, sepIdx);
    const targetModel = modelStr.slice(sepIdx + 1);
    const provider = getProvider(prefix);
    if (provider) {
      return checkDisabled(provider, targetModel) || null;
    }
  }

  const guess = (provider, targetModel) =>
    provider && !isModelDisabled(provider.id, targetModel) ? { provider, targetModel, rawModel: modelStr } : null;

  // Guess provider by model name prefix if no slash given
  if (modelStr.startsWith("claude-")) {
    return guess(getProvider("claude"), modelStr);
  }
  if (modelStr.startsWith("gpt-") || modelStr.startsWith("o1") || modelStr.startsWith("o3")) {
    return guess(getProvider("codex"), modelStr);
  }
  if (modelStr.startsWith("gemini-")) {
    return guess(getProvider("antigravity"), modelStr);
  }
  if (modelStr.startsWith("glm-") || modelStr.startsWith("codegeex")) {
    return guess(getProvider("glm"), modelStr);
  }

  return null;
}

/**
 * Return list of all available models in OpenAI Model List format
 */
export function getAvailableModels() {
  const result = [];
  const now = Math.floor(Date.now() / 1000);

  // Disabled registry models are filtered out.
  for (const p of REGISTRY) {
    const primaryAlias = Array.isArray(p.alias) ? p.alias[0] : (p.alias || p.id);

    for (const m of getProviderModels(p)) {
      if (isModelDisabled(p.id, m.id)) continue;

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

  // Models imported from a provider's live list (dashboard "Import Models").
  for (const im of listImportedModels()) {
    const provider = getProvider(im.provider);
    if (!provider || isModelDisabled(provider.id, im.model_id)) continue;
    const primaryAlias = Array.isArray(provider.alias) ? provider.alias[0] : (provider.alias || provider.id);
    result.push({
      id: `${primaryAlias}/${im.model_id}`,
      object: "model",
      created: now,
      owned_by: provider.id,
      permission: [],
      root: im.model_id,
      parent: null,
      imported: true,
    });
  }

  // Custom models ride along with caps derived from a simple cloud default.
  const seenIds = new Set(result.map((r) => r.id));
  for (const cm of listCustomModels()) {
    const provider = getProvider(cm.provider);
    const primaryAlias = provider ? (Array.isArray(provider.alias) ? provider.alias[0] : (provider.alias || provider.id)) : cm.provider;
    if (isModelDisabled(cm.provider, cm.model_id)) continue;
    const id = `${primaryAlias}/${cm.model_id}`;
    if (!seenIds.has(id)) {
      result.push({
        id,
        object: "model",
        created: now,
        owned_by: cm.provider,
        permission: [],
        root: cm.model_id,
        parent: null,
        custom: true,
      });
      seenIds.add(id);
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
