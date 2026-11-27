import { getSetting, setSetting } from "../settings.js";
import { getAccounts } from "./accounts.js";
import { isPendingAntigravityAcpAccount } from "./workers.js";

const CATALOG_SETTING = "antigravity_acp_model_catalog";
const MAX_MODELS = 200;
const MAX_ID_LENGTH = 200;

/** accountId -> { method: "config_option"|"legacy", configId, models: [{id,name}] } */
let cache = null;
let cacheRaw = null;

function cleanText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function dedupe(models) {
  const seen = new Set();
  const out = [];
  for (const model of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}

function flattenSelectOptions(options) {
  const flat = [];
  for (const item of Array.isArray(options) ? options : []) {
    if (item && Array.isArray(item.options)) flat.push(...item.options);
    else flat.push(item);
  }
  return flat;
}

/**
 * Reads the model catalog from a session/new result. configOptions (category "model", type "select")
 * has priority; the legacy models.availableModels shape is only a fallback. Nothing is invented:
 * an unrecognised shape yields null.
 */
export function parseSessionModelCatalog(session) {
  if (!session || typeof session !== "object") return null;
  if (Array.isArray(session.configOptions)) {
    const option = session.configOptions.find((o) => o && o.category === "model" && o.type === "select" && cleanText(o.id));
    if (option) {
      const models = dedupe(flattenSelectOptions(option.options).map((o) => {
        const id = cleanText(o?.value);
        return id ? { id, name: cleanText(o.name) || id } : null;
      }).filter(Boolean));
      // An empty model select is authoritative: never fall back to the legacy shape.
      return { method: "config_option", configId: option.id, models };
    }
  }
  const legacy = session.models?.availableModels;
  if (Array.isArray(legacy)) {
    const models = dedupe(legacy.map((m) => {
      const id = cleanText(m?.modelId);
      return id ? { id, name: cleanText(m.name) || id } : null;
    }).filter(Boolean));
    if (models.length) return { method: "legacy", configId: null, models };
  }
  return null;
}

function load() {
  let raw = "{}";
  try { raw = getSetting(CATALOG_SETTING, "{}"); } catch {}
  if (cache && raw === cacheRaw) return cache;
  cache = new Map();
  cacheRaw = raw;
  try {
    const parsed = JSON.parse(raw);
    for (const [id, entry] of Object.entries(parsed || {})) {
      const models = Array.isArray(entry?.models) ? dedupe(entry.models.map((m) => (cleanText(m?.id) ? { id: m.id, name: cleanText(m.name) || m.id } : null)).filter(Boolean)) : [];
      if ((models.length || entry.method === "config_option") && (entry.method === "config_option" || entry.method === "legacy")) {
        cache.set(id, { method: entry.method, configId: cleanText(entry.configId), models });
      }
    }
  } catch {}
  return cache;
}

function persist() {
  cacheRaw = JSON.stringify(Object.fromEntries(cache));
  setSetting(CATALOG_SETTING, cacheRaw);
}

/** Drops entries of accounts that are no longer listed (removed accounts). */
function prune() {
  const live = new Set(getAccounts().map((a) => a.id));
  let changed = false;
  for (const id of [...load().keys()]) {
    if (!live.has(id) && !isPendingAntigravityAcpAccount(id)) { cache.delete(id); changed = true; }
  }
  if (changed) persist();
}

/** Stores the catalog seen in a fresh session for one account; replaces the previous one. */
export function recordAntigravityAcpAccountCatalog(accountId, session) {
  const parsed = parseSessionModelCatalog(session);
  if (!parsed) {
    invalidateAntigravityAcpAccountCatalog(accountId); // never keep a stale catalog
    return parsed;
  }
  load().set(accountId, parsed);
  persist();
  return parsed;
}

export function invalidateAntigravityAcpAccountCatalog(accountId) {
  if (load().delete(accountId)) persist();
}

export function getAntigravityAcpAccountCatalog(accountId) {
  prune();
  return load().get(accountId) || null;
}

/** Returns accountIds whose recorded catalog contains modelId. */
export function getAntigravityAcpAccountsForModel(modelId) {
  if (!cleanText(modelId)) return [];
  prune();
  const out = [];
  for (const [accountId, entry] of load().entries()) {
    if (entry.models.some((m) => m.id === modelId)) out.push(accountId);
  }
  return out;
}

/** Union of the catalogs of enabled accounts that are still logged in (checked by the caller-provided filter). */
export function getAntigravityAcpMergedModels(isAccountUsable = () => true) {
  prune();
  const accounts = getAccounts().filter((a) => a.enabled && isAccountUsable(a.id));
  const merged = [];
  for (const account of accounts) {
    const entry = load().get(account.id);
    if (entry) merged.push(...entry.models);
  }
  return dedupe(merged);
}

export function resetAntigravityAcpCatalogForTests() {
  cache = null;
  cacheRaw = null;
}
