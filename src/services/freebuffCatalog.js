// Service to fetch and parse official Freebuff model definitions and root agent mappings
// directly from CodebuffAI/freebuff GitHub repository.
// Dual-layer: static registry fallback + dynamic parsed models with ETag awareness.

const GITHUB_RAW_BASE =
  "https://raw.githubusercontent.com/CodebuffAI/freebuff/main/common/src/constants";

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Test hook: override fetch implementation */
export function setFreebuffCatalogFetch(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

/**
 * Fetch and parse official Freebuff model catalog and agent mappings from GitHub raw.
 * Supports HTTP 304 Not Modified via ETag.
 * Returns:
 *   - { ok: true, notModified: true, etag }
 *   - { ok: true, models: [...], agentMap: {...}, etag }
 *   - { ok: false, code: "upstream_error" }
 */
export async function fetchFreebuffCatalog({ etag = null } = {}) {
  try {
    const headers = {
      Accept: "text/plain",
      "User-Agent": "zenith-router/model-sync",
    };
    if (etag) headers["If-None-Match"] = etag;

    const [agentsRes, modelsRes, idsRes] = await Promise.all([
      fetchImpl(`${GITHUB_RAW_BASE}/free-agents.ts`, { headers }),
      fetchImpl(`${GITHUB_RAW_BASE}/freebuff-models.ts`, { headers }),
      fetchImpl(`${GITHUB_RAW_BASE}/freebuff-model-ids.ts`, { headers }).catch(() => null),
    ]);

    if (agentsRes.status === 304 && modelsRes.status === 304) {
      return { ok: true, notModified: true, etag };
    }

    if (!agentsRes.ok || !modelsRes.ok) {
      return { ok: false, code: "upstream_error", status: modelsRes.status || agentsRes.status };
    }

    const newEtag = modelsRes.headers.get("etag") || agentsRes.headers.get("etag") || null;
    const agentsText = await agentsRes.text();
    const modelsText = await modelsRes.text();
    const idsText = idsRes && idsRes.ok ? await idsRes.text() : "";

    const parsed = parseFreebuffSources({ agentsText, modelsText, idsText });
    if (!parsed || parsed.models.length === 0) {
      return { ok: false, code: "empty" };
    }

    return {
      ok: true,
      models: parsed.models,
      agentMap: parsed.agentMap,
      etag: newEtag,
    };
  } catch (err) {
    return { ok: false, code: "upstream_error", error: err.message };
  }
}

/**
 * Pure parser for Freebuff constants TypeScript files.
 */
export function parseFreebuffSources({ agentsText = "", modelsText = "", idsText = "" }) {
  // 1. Resolve constant wire IDs
  const constToWire = {
    FREEBUFF_MIMO_V25_MODEL_ID: "mimo/mimo-v2.5",
    FREEBUFF_MIMO_V26_PRO_MODEL_ID: "mimo/mimo-v2.6-pro",
  };
  const constRegex = /export const (FREEBUFF_[A-Z0-9_]+_MODEL_ID)\s*=\s*['"]([^'"]+)['"]/g;
  let m;
  for (const text of [modelsText, idsText]) {
    while ((m = constRegex.exec(text)) !== null) {
      constToWire[m[1]] = m[2];
    }
  }

  // 2. Parse model definitions by splitting on "const [A-Z0-9_]+_MODEL ="
  const modelDefs = {};
  const chunks = modelsText.split(/(?=const [A-Z0-9_]+_MODEL\s*=)/g);
  for (const chunk of chunks) {
    const headerMatch = chunk.match(/^const ([A-Z0-9_]+_MODEL)\s*=/);
    if (!headerMatch) continue;
    const modelVar = headerMatch[1];
    const idMatch = chunk.match(/id:\s*([A-Za-z0-9_.]+)/);
    const displayMatch = chunk.match(/displayName:\s*['"]([^'"]+)['"]/);
    const premiumMatch = chunk.match(/premium:\s*(true|false)/);
    if (idMatch) {
      const constName = idMatch[1];
      const wireId = constToWire[constName] || (constName.includes("/") ? constName : null);
      if (wireId) {
        modelDefs[modelVar] = {
          wireId,
          displayName: displayMatch ? displayMatch[1] : wireId,
          premium: premiumMatch ? premiumMatch[1] === "true" : false,
        };
      }
    }
  }

  // 3. Parse FREEBUFF_ROOT_AGENT_ID_BY_MODEL from free-agents.ts
  const agentMap = {};
  const mapSectionMatch = agentsText.match(/FREEBUFF_ROOT_AGENT_ID_BY_MODEL[\s\S]*?=\s*\{([\s\S]*?)\n\}/);
  if (mapSectionMatch) {
    const lines = mapSectionMatch[1].split("\n");
    for (const line of lines) {
      const entry = line.match(/\[([A-Z0-9_]+)\]:\s*['"]([^'"]+)['"]/);
      if (entry) {
        const constName = entry[1];
        const agentId = entry[2];
        const wireId = constToWire[constName];
        if (wireId) {
          agentMap[wireId] = agentId;
        }
      }
    }
  }

  // 4. Parse FREEBUFF_PAUSED_FREE_MODEL_IDS (withdrawn/paused models)
  const pausedSet = new Set();
  const pausedMatch = modelsText.match(/FREEBUFF_PAUSED_FREE_MODEL_IDS[\s\S]*?=\s*\[([\s\S]*?)\] as const/);
  if (pausedMatch) {
    const items = pausedMatch[1].match(/FREEBUFF_[A-Z0-9_]+_MODEL_ID/g) || [];
    for (const item of items) {
      if (constToWire[item]) pausedSet.add(constToWire[item]);
    }
  }

  // 5. Parse FREEBUFF_PRO_ONLY_EVERY_SURFACE_MODEL_IDS (paid-only subscriptions)
  const proOnlySet = new Set();
  const proOnlyMatch = modelsText.match(/FREEBUFF_PRO_ONLY_EVERY_SURFACE_MODEL_IDS[\s\S]*?=\s*\[([\s\S]*?)\]/);
  if (proOnlyMatch) {
    const items = proOnlyMatch[1].match(/FREEBUFF_[A-Z0-9_]+_MODEL_ID/g) || [];
    for (const item of items) {
      if (constToWire[item]) proOnlySet.add(constToWire[item]);
    }
  }

  // 6. Active models from FREEBUFF_MODELS
  const freeModelsListMatch = modelsText.match(/export const FREEBUFF_MODELS = \[([\s\S]*?)\] as const/);
  const activeModels = [];
  const seenIds = new Set();
  if (freeModelsListMatch) {
    const items = freeModelsListMatch[1].match(/[A-Z0-9_]+_MODEL/g) || [];
    for (const item of items) {
      const def = modelDefs[item];
      if (
        def &&
        agentMap[def.wireId] &&
        !pausedSet.has(def.wireId) &&
        !proOnlySet.has(def.wireId) &&
        !seenIds.has(def.wireId)
      ) {
        seenIds.add(def.wireId);
        activeModels.push({
          id: def.wireId,
          name: def.displayName,
          isFree: true,
        });
      }
    }
  }

  // Sanity check: must have at least 2 models and valid agent mappings
  if (activeModels.length === 0 || Object.keys(agentMap).length === 0) {
    return null;
  }

  return {
    models: activeModels,
    agentMap,
  };
}
