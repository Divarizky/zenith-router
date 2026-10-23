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
import deepseekWeb from "./registry/deepseek-web.js";
import { listCustomModels, listImportedModels, listSyncedModels, isModelDisabled } from "../services/modelOverrides.js";
import { resolveCapabilities } from "./capabilities.js";

/**
 * Capability fields published per model on /v1/models, same shape as the upstream reference:
 * clients read capabilities.vision to decide whether image input is allowed and
 * capabilities.reasoning to decide whether reasoning_effort may be sent. A model
 * nobody has data for gets no field at all — better an absent claim than a wrong one.
 */
function modelCapabilityFields(modelId, storedCaps = null) {
  const caps = storedCaps || resolveCapabilities(modelId, storedCaps);
  if (!caps) return {};
  const fields = { capabilities: { vision: caps.vision === true, reasoning: caps.reasoning === true } };
  if (caps.contextWindow) fields.context_length = caps.contextWindow;
  if (caps.maxOutput) fields.max_completion_tokens = caps.maxOutput;
  return fields;
}
import { getConnections, getAntigravityInventoryRows } from "../db/index.js";
import { buildAntigravityFamilies, resolveFamilyRuntime } from "../services/antigravityCatalog.js";

/**
 * Every synced runtime id across active accounts, keyed by runtime id. Families
 * are derived from this so a model only one subscription carries still resolves.
 */
function antigravityModelRows() {
  const rows = {};
  for (const row of getAntigravityInventoryRows()) {
    if (rows[row.model_id]) continue;
    rows[row.model_id] = {
      displayName: row.display_name,
      supportsImages: row.supports_images === 1 ? true : row.supports_images === 0 ? false : undefined,
      supportsThinking: row.supports_thinking === 1 ? true : row.supports_thinking === 0 ? false : undefined,
      maxTokens: row.max_tokens ?? undefined,
      maxOutputTokens: row.max_output_tokens ?? undefined,
    };
  }
  return rows;
}

/** Builtin and synced families share this shape, so resolveFamilyRuntime needs no special case. */
function familyEntry(id, name, source = {}) {
  return {
    id,
    name,
    family: id,
    variants: source.variants || {},
    unsuffixed: source.unsuffixed,
    tiered: source.tiered,
    supportsImages: source.supportsImages,
    supportsThinking: source.supportsThinking,
    maxTokens: source.maxTokens,
    maxOutputTokens: source.maxOutputTokens,
    source: source.source || "synced",
  };
}

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
  deepseekWeb,
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
 * Built-in models of a provider: `{ id, name, source, capabilities }` with source
 * "builtin" or "synced". Providers with `freeModelSync` use their last synced free
 * list: "replace" swaps out the hardcoded list (kept only as a fallback until the
 * first sync), "merge" adds to it. `capabilities` is null when neither the provider
 * API nor the pattern table knows the model.
 */
export function getProviderModels(p) {
  const withCaps = (m, storedCaps = null) => {
    const capabilities = resolveCapabilities(m.id, storedCaps);
    return capabilities ? { ...m, capabilities } : m;
  };

  const staticModels = p.models.map((m) => withCaps({ id: m.id, name: m.name, source: "builtin" }));

  // Antigravity publishes a per-subscription catalog, so accounts on a higher
  // plan carry families the builtin list never had (gemini-4-argon, Claude 5.5).
  // Both sides are families now; the builtin list stays as the fallback for
  // whatever discovery has not reported yet.
  if (p.id === "antigravity") {
    const builtinFamilies = new Map(p.models.map((m) => [m.id, familyEntry(m.id, m.name, { ...m, source: "builtin" })]));
    for (const [family, discovered] of buildAntigravityFamilies(antigravityModelRows())) {
      const existing = builtinFamilies.get(family);
      // A discovered family wins its variants: it is what this account can call.
      if (existing) {
        existing.variants = { ...existing.variants, ...discovered.variants };
        existing.unsuffixed = discovered.unsuffixed || existing.unsuffixed;
        existing.tiered = discovered.tiered || existing.tiered;
        existing.supportsImages = discovered.supportsImages ?? existing.supportsImages;
        existing.supportsThinking = discovered.supportsThinking ?? existing.supportsThinking;
      } else {
        builtinFamilies.set(family, familyEntry(family, discovered.displayName || family, discovered));
      }
    }
    return [...builtinFamilies.values()].map((f) => withCaps(f));
  }

  if (!p.freeModelSync) return staticModels;

  const synced = listSyncedModels(p.id).map((m) =>
    withCaps({ id: m.model_id, name: m.name || m.model_id, source: "synced" }, m.capabilities)
  );
  if (synced.length === 0) return staticModels;
  if (p.freeModelSync === "replace") return synced;

  const staticIds = new Set(staticModels.map((m) => m.id));
  return [...staticModels, ...synced.filter((m) => !staticIds.has(m.id))];
}

/**
 * Runtime id and thinking level a catalog model resolves to for one effort.
 * Only families carry variants; any other id is already a runtime id, so the
 * result is undefined and the caller keeps the id it was given.
 */
export function resolveProviderRuntime(providerDef, modelId, effort, accountRows = null) {
  // With an account's own rows, variants come from what that account carries, so
  // the level falls back within it and never picks an id it cannot serve.
  const entry = accountRows
    ? buildAntigravityFamilies(
        Object.fromEntries([...accountRows].map(([id, row]) => [id, { displayName: row.display_name }]))
      ).get(modelId)
    : getProviderModels(providerDef)?.find((m) => m.id === modelId);
  if (!entry) return undefined;
  return resolveFamilyRuntime(entry, effort);
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
 * Capabilities of one canonical `provider/model` combo member, resolved the same
 * way the catalog resolves provider models: stored sync data first, then the
 * pattern table. Null when nothing is known — same rule as modelCapabilityFields,
 * so both the catalog rollup and the vision reorder stay honest about what they
 * do not know.
 */
export function memberCapabilities(member) {
  const resolved = resolveModel(member);
  if (!resolved) return null;
  let stored = null;
  try {
    stored =
      listSyncedModels(resolved.provider.id).find((m) => m.model_id === resolved.targetModel)?.capabilities || null;
  } catch {
    stored = null;
  }
  return resolveCapabilities(resolved.targetModel, stored);
}

/**
 * Return list of all available models in OpenAI Model List format.
 *
 * Mirroring the upstream `buildModelsList` (src/app/api/v1/models/route.js) and
 * OmniRoute `handleGetModels` (src/app/api/models/route.ts): only providers with
 * an active connection contribute their catalog. `noAuth` free providers are
 * always kept. Callers needing the full registry (tests, audit) can pass
 * { all: true } or ?all=true on the endpoint.
 */
export function getAvailableModels({ all = false } = {}) {
  const result = [];
  const now = Math.floor(Date.now() / 1000);

  // Provider IDs and aliases that currently have at least one active account.
  let activeProviders = null;
  if (!all) {
    activeProviders = new Set();
    try {
      for (const conn of getConnections()) {
        if (conn.is_active !== 1) continue;
        const provider = getProvider(conn.provider);
        if (!provider) {
          activeProviders.add(String(conn.provider).toLowerCase());
          continue;
        }
        activeProviders.add(provider.id);
        const aliases = Array.isArray(provider.alias) ? provider.alias : [provider.alias || provider.id];
        for (const a of aliases) activeProviders.add(String(a).toLowerCase());
      }
    } catch {
      activeProviders = null; // DB not ready -> fail open to full list
    }
  }

  const providerVisible = (p) =>
    all || !activeProviders || p.noAuth || activeProviders.has(p.id) ||
    (Array.isArray(p.alias) ? p.alias : [p.alias || p.id]).some((a) => activeProviders.has(String(a).toLowerCase()));

  // Disabled registry models are filtered out.
  for (const p of REGISTRY) {
    if (!providerVisible(p)) continue;
    const primaryAlias = Array.isArray(p.alias) ? p.alias[0] : (p.alias || p.id);

    for (const m of getProviderModels(p)) {
      if (isModelDisabled(p.id, m.id)) continue;

      // Register one canonical model ID using primary alias (e.g. "fb/mimo-v2.5" or "glm/glm-4-flash")
      const entry = {
        id: `${primaryAlias}/${m.id}`,
        object: "model",
        created: now,
        owned_by: p.id,
        permission: [],
        root: m.id,
        parent: null,
      };
      Object.assign(entry, modelCapabilityFields(m.id, m.capabilities));
      result.push(entry);
    }
  }

  // Models imported from a provider's live list (dashboard "Import Models").
  for (const im of listImportedModels()) {
    const provider = getProvider(im.provider);
    if (!provider || isModelDisabled(provider.id, im.model_id) || !providerVisible(provider)) continue;
    const primaryAlias = Array.isArray(provider.alias) ? provider.alias[0] : (provider.alias || provider.id);
    const entry = {
      id: `${primaryAlias}/${im.model_id}`,
      object: "model",
      created: now,
      owned_by: provider.id,
      permission: [],
      root: im.model_id,
      parent: null,
      imported: true,
    };
    Object.assign(entry, modelCapabilityFields(im.model_id));
    result.push(entry);
  }

  // Custom models ride along with caps derived from a simple cloud default.
  const seenIds = new Set(result.map((r) => r.id));
  for (const cm of listCustomModels()) {
    const provider = getProvider(cm.provider);
    if (provider && !providerVisible(provider)) continue;
    const primaryAlias = provider ? (Array.isArray(provider.alias) ? provider.alias[0] : (provider.alias || provider.id)) : cm.provider;
    if (isModelDisabled(cm.provider, cm.model_id)) continue;
    const id = `${primaryAlias}/${cm.model_id}`;
    if (!seenIds.has(id)) {
      const entry = {
        id,
        object: "model",
        created: now,
        owned_by: cm.provider,
        permission: [],
        root: cm.model_id,
        parent: null,
        custom: true,
      };
      Object.assign(entry, modelCapabilityFields(cm.model_id));
      result.push(entry);
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
