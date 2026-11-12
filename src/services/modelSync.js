import { getDb } from "../db/index.js";
import { getAllProviders, getProvider } from "../providers/index.js";
import { fetchProviderModels } from "./modelImport.js";
import { fetchFreebuffCatalog } from "./freebuffCatalog.js";
import { refreshOpencodeCatalog } from "./opencodeCatalog.js";
import { getSetting, setSetting } from "./settings.js";
import { replaceRetiredModels, getModelSyncState } from "./modelOverrides.js";
import { syncManagedCombos } from "./managedCombos.js";
import { refreshBenchmarkSnapshot } from "./benchmarkSync.js";

const DEFAULT_INTERVAL_HOURS = 6;

const ERROR_TEXT = {
  unsupported: "Provider tidak punya endpoint daftar model.",
  no_account: "Butuh akun untuk mengambil daftar model.",
  upstream_error: "Gagal mengambil daftar model dari provider.",
  empty: "Provider tidak mengembalikan model gratis.",
};

function recordState(providerId, { ok, count = 0, error = null }) {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO model_sync_state (provider, last_attempt_at, last_success_at, ok, count, error)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = COALESCE(excluded.last_success_at, model_sync_state.last_success_at),
         ok = excluded.ok,
         count = CASE WHEN excluded.ok = 1 THEN excluded.count ELSE model_sync_state.count END,
         error = excluded.error`
    )
    .run(providerId, now, ok ? now : null, ok ? 1 : 0, count, error);
}

/**
 * Record which built-in ids upstream no longer lists. `liveIds` is what the
 * payload carried, so an empty or half list never retires anything, and a retired
 * id that comes back is dropped from the set and routes again. Registry
 * `builtinAliases` are callable but unpublished, so they are kept even when the
 * payload never names them.
 *
 * "replace" providers are skipped: their synced list already is the catalog, and
 * if it ever disappears the full hardcoded list should come back, not a stub.
 */
function retireMissingBuiltins(provider, liveIds) {
  if (!provider.catalogRefresh || provider.freeModelSync === "replace") return { retired: 0 };
  if (!Array.isArray(liveIds) || liveIds.length === 0) return { retired: 0 };
  const live = new Set([...liveIds, ...(provider.builtinAliases || [])]);
  if (live.size === 0) return { retired: 0 };

  const retiredIds = provider.models.map((m) => m.id).filter((id) => !live.has(id));
  replaceRetiredModels(provider.id, retiredIds);
  return { retired: retiredIds.length };
}

/**
 * Refresh one provider's live catalog without claiming any model is free: used
 * by providers whose free access is not per-model (OVHcloud's account credit).
 * Returns `{ code, retired, count? }`.
 */
export async function refreshProviderCatalog(providerId) {
  const provider = getProvider(providerId);
  if (!provider?.catalogRefresh) return { code: "unsupported", retired: 0 };

  const fetched = await fetchProviderModels(provider);
  if (!fetched.ok) {
    const suffix = fetched.status ? ` (HTTP ${fetched.status})` : "";
    recordState(provider.id, { ok: false, error: `${ERROR_TEXT[fetched.code] || fetched.code}${suffix}` });
    return fetched.status
      ? { code: fetched.code, retired: 0, status: fetched.status }
      : { code: fetched.code, retired: 0 };
  }

  // An empty list is an upstream hiccup, not a retraction of the whole catalog:
  // treating it as truth would hide every built-in model at once.
  if (!fetched.liveIds?.length) {
    recordState(provider.id, { ok: false, error: ERROR_TEXT.empty });
    return { code: "empty", retired: 0 };
  }

  const { retired } = retireMissingBuiltins(provider, fetched.liveIds);
  // The sync state doubles as the "when did the catalog last answer" stamp for
  // providers with no free list, so the dashboard can show it.
  const previousCount = getModelSyncState(provider.id)?.count || 0;
  recordState(provider.id, { ok: true, count: previousCount });
  return { code: "refreshed", retired, count: previousCount };
}

/**
 * Sync one provider's free model list. A failed or empty fetch keeps the
 * previous synced list, so a flaky upstream never wipes working models.
 * Providers with `catalogRefresh` also get their retired built-ins rewritten from
 * the same payload. Returns `{ code, count, status?, retired? }`.
 */
export async function syncFreeModels(providerId) {
  const provider = getProvider(providerId);
  if (!provider?.freeModelSync) return { code: "unsupported", count: 0 };

  if (provider.id === "freebuff") {
    const prevEtag = getSetting("freebuff_sync_etag", "");
    const res = await fetchFreebuffCatalog({ etag: prevEtag || null });

    if (res.notModified) {
      const existingCount =
        getDb().prepare("SELECT COUNT(*) as c FROM synced_models WHERE provider = ?").get("freebuff")?.c || 0;
      recordState("freebuff", { ok: true, count: existingCount });
      return { code: "synced", count: existingCount };
    }

    if (!res.ok) {
      recordState("freebuff", { ok: false, error: ERROR_TEXT[res.code] || res.code });
      return { code: res.code, count: 0 };
    }

    if (res.etag) setSetting("freebuff_sync_etag", res.etag);
    if (res.agentMap) setSetting("freebuff_agent_map", JSON.stringify(res.agentMap));

    const free = res.models;
    const db = getDb();
    const now = Date.now();
    const insert = db.prepare(
      "INSERT OR REPLACE INTO synced_models (provider, model_id, name, synced_at) VALUES (?, ?, ?, ?)"
    );
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM synced_models WHERE provider = ?").run("freebuff");
      for (const m of free) insert.run("freebuff", m.id, m.name || null, now);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    recordState("freebuff", { ok: true, count: free.length });
    return { code: "synced", count: free.length };
  }

  const fetched = await fetchProviderModels(provider);
  if (!fetched.ok) {
    const suffix = fetched.status ? ` (HTTP ${fetched.status})` : "";
    recordState(provider.id, { ok: false, error: `${ERROR_TEXT[fetched.code] || fetched.code}${suffix}` });
    return fetched.status ? { code: fetched.code, count: 0, status: fetched.status } : { code: fetched.code, count: 0 };
  }

  // An empty liveIds list on a catalog-refresh provider indicates an upstream hiccup
  // rather than a full catalog withdrawal; do not wipe or retire existing models.
  if (provider.catalogRefresh && (!fetched.liveIds || fetched.liveIds.length === 0)) {
    recordState(provider.id, { ok: false, error: ERROR_TEXT.empty });
    return { code: "empty", count: 0 };
  }

  const free = fetched.models.filter((m) => m.isFree);
  if (free.length === 0) {
    recordState(provider.id, { ok: false, error: ERROR_TEXT.empty });
    return { code: "empty", count: 0 };
  }

  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO synced_models (provider, model_id, name, capabilities, synced_at) VALUES (?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM synced_models WHERE provider = ?").run(provider.id);
    // "replace" providers offer no import, so imported rows can only be leftovers
    // that would keep models routed after upstream drops them.
    if (provider.freeModelSync === "replace") {
      db.prepare("DELETE FROM imported_models WHERE provider = ?").run(provider.id);
    }
    for (const m of free) insert.run(provider.id, m.id, m.name || null, m.capabilities ? JSON.stringify(m.capabilities) : null, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  recordState(provider.id, { ok: true, count: free.length });
  const { retired } = retireMissingBuiltins(provider, fetched.liveIds);
  // `retired` is only reported for providers that mirror their static catalog, so
  // the shape of the result stays stable for the free-only providers.
  return provider.catalogRefresh && provider.freeModelSync !== "replace"
    ? { code: "synced", count: free.length, retired }
    : { code: "synced", count: free.length };
}

/** Sync every provider that declares freeModelSync; one failure doesn't stop the rest. */
export async function syncAllFreeModels() {
  const results = {};
  for (const p of getAllProviders().filter((x) => x.freeModelSync)) {
    try {
      results[p.id] = await syncFreeModels(p.id);
    } catch {
      results[p.id] = { code: "upstream_error", count: 0 };
    }
  }
  return results;
}

/**
 * Refresh every catalog that mirrors upstream, including providers with no free
 * list (OVHcloud). Runs alongside the free sync so the dashboard notice and the
 * retired set stay in step; a failure on one provider does not stop the rest.
 */
export async function syncAllCatalogs() {
  const results = await syncAllFreeModels();
  for (const p of getAllProviders().filter((x) => x.catalogRefresh && !x.freeModelSync)) {
    try {
      results[p.id] = await refreshProviderCatalog(p.id);
    } catch {
      results[p.id] = { code: "upstream_error", retired: 0 };
    }
  }
  return results;
}

/** Interval from ZENITH_MODEL_SYNC_INTERVAL_HOURS (default 6); 0 or negative turns sync off. */
export function getSyncIntervalMs() {
  const raw = process.env.ZENITH_MODEL_SYNC_INTERVAL_HOURS;
  const hours = raw === undefined || raw === "" ? DEFAULT_INTERVAL_HOURS : Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 0;
}

/**
 * Sync once at startup, then on an interval. The timer is unref'd so it never
 * keeps the process alive. Returns the timer, or null when sync is turned off.
 */
export function startModelSyncScheduler() {
  const intervalMs = getSyncIntervalMs();
  if (!intervalMs) return null;
  // The OpenCode model import installs the catalog it downloads, so the extra
  // refresh only fetches when that import failed (it skips a fresh snapshot).
  const run = async () => {
    await syncAllCatalogs().catch(() => {});
    await refreshOpencodeCatalog().catch(() => {});
    await refreshBenchmarkSnapshot().catch(() => {});
    await syncManagedCombos().catch(() => {});
  };
  run().catch(() => {});
  const timer = setInterval(() => run().catch(() => {}), intervalMs);
  timer.unref?.();
  return timer;
}
