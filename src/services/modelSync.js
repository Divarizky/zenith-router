import { getDb } from "../db/index.js";
import { getAllProviders, getProvider } from "../providers/index.js";
import { fetchProviderModels } from "./modelImport.js";

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
 * Sync one provider's free model list. A failed or empty fetch keeps the
 * previous synced list, so a flaky upstream never wipes working models.
 * Returns `{ code, count, status? }`; code is synced or a fetch error code.
 */
export async function syncFreeModels(providerId) {
  const provider = getProvider(providerId);
  if (!provider?.freeModelSync) return { code: "unsupported", count: 0 };

  const fetched = await fetchProviderModels(provider);
  if (!fetched.ok) {
    const suffix = fetched.status ? ` (HTTP ${fetched.status})` : "";
    recordState(provider.id, { ok: false, error: `${ERROR_TEXT[fetched.code] || fetched.code}${suffix}` });
    return fetched.status ? { code: fetched.code, count: 0, status: fetched.status } : { code: fetched.code, count: 0 };
  }

  const free = fetched.models.filter((m) => m.isFree);
  if (free.length === 0) {
    recordState(provider.id, { ok: false, error: ERROR_TEXT.empty });
    return { code: "empty", count: 0 };
  }

  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO synced_models (provider, model_id, name, synced_at) VALUES (?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM synced_models WHERE provider = ?").run(provider.id);
    // "replace" providers offer no import, so imported rows can only be leftovers
    // that would keep models routed after upstream drops them.
    if (provider.freeModelSync === "replace") {
      db.prepare("DELETE FROM imported_models WHERE provider = ?").run(provider.id);
    }
    for (const m of free) insert.run(provider.id, m.id, m.name || null, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  recordState(provider.id, { ok: true, count: free.length });
  return { code: "synced", count: free.length };
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

/** Interval from ZENROUTE_MODEL_SYNC_INTERVAL_HOURS (default 6); 0 or negative turns sync off. */
export function getSyncIntervalMs() {
  const raw = process.env.ZENROUTE_MODEL_SYNC_INTERVAL_HOURS;
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
  syncAllFreeModels().catch(() => {});
  const timer = setInterval(() => syncAllFreeModels().catch(() => {}), intervalMs);
  timer.unref?.();
  return timer;
}
