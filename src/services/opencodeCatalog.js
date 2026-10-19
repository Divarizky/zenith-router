/**
 * OpenCode publishes its own catalog at models.opencode.ai/api.json: the base
 * URL its CLI calls and which models upstream has retired. Both used to be
 * hardcoded, so a model the official CLI sends to `/inference/openai/v1` was
 * sent to the `/inference/v1` gateway instead (its abuse filter is stricter),
 * and retired ids kept being routed until upstream answered 410.
 *
 * The defaults below serve until the first successful fetch. A failed fetch
 * never clears a good snapshot, so a flaky network cannot reroute traffic.
 */
import { captureLine } from "./logger.js";

export const OPENCODE_CATALOG_URL = "https://models.opencode.ai/api.json";
export const OPENCODE_DEFAULT_BASE_URL = "https://opencode.ai/inference/openai/v1";
export const OPENCODE_LEGACY_BASE_URL = "https://opencode.ai/inference/v1";
export const OPENCODE_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const OPENCODE_CATALOG_TIMEOUT_MS = 8000;

const TRUSTED_CATALOG_BASE_RE = /^https:\/\/([a-z0-9-]+\.)*opencode\.ai(\/|$)/i;

let snapshot = null;
let inflight = null;

export function resetOpencodeCatalog() {
  snapshot = null;
  inflight = null;
}

export function isTrustedCatalogBaseUrl(url) {
  return typeof url === "string" && TRUSTED_CATALOG_BASE_RE.test(url);
}

function trimBase(url) {
  return String(url).replace(/\/+$/, "");
}

function laneSuffix(lane) {
  if (lane === "responses") return "/responses";
  if (lane === "messages") return "/messages";
  return "/chat/completions";
}

/**
 * Map one catalog entry. `api` may pin a different base for that model alone
 * (the anthropic-protocol models live under /inference/anthropic/v1), and
 * `cost.input === 0` is what makes a model free — the name suffix is not
 * authoritative upstream, e.g. `jev-*` are free evaluation models.
 */
function parseModel(id, raw) {
  if (!raw || typeof raw !== "object") return null;
  const cost = raw.cost && typeof raw.cost === "object" ? raw.cost : null;
  const api = raw.provider?.api ?? raw.api;
  return {
    id,
    name: typeof raw.name === "string" && raw.name ? raw.name : id,
    deprecated: raw.status === "deprecated",
    api: isTrustedCatalogBaseUrl(api) ? trimBase(api) : null,
    isFree: cost ? Number(cost.input) === 0 : false,
    reasoning: Boolean(raw.reasoning),
    limit: raw.limit && typeof raw.limit === "object" ? raw.limit : null,
  };
}

/** Parse a catalog payload into `{ baseUrl, models }`, or null when unusable. */
export function parseOpencodeCatalog(json) {
  const oc = json?.opencode;
  if (!oc || typeof oc !== "object") return null;
  const models = new Map();
  for (const [id, raw] of Object.entries(oc.models || {})) {
    const model = parseModel(id, raw);
    if (model) models.set(id, model);
  }
  const hasBase = isTrustedCatalogBaseUrl(oc.api);
  if (models.size === 0 && !hasBase) return null;
  return { baseUrl: hasBase ? trimBase(oc.api) : OPENCODE_DEFAULT_BASE_URL, models };
}

/** Install a payload without fetching; used by the model sync and by tests. */
export function setOpencodeCatalog(json) {
  const parsed = parseOpencodeCatalog(json);
  if (!parsed) return null;
  snapshot = { ...parsed, fetchedAt: Date.now() };
  return snapshot;
}

export function getOpencodeCatalog() {
  return snapshot;
}

export function getOpencodeCatalogBaseUrl() {
  return snapshot?.baseUrl || OPENCODE_DEFAULT_BASE_URL;
}

export function getOpencodeModelInfo(model) {
  const id = typeof model === "string" ? model : model?.id;
  if (!id || !snapshot) return null;
  return snapshot.models.get(id) || snapshot.models.get(String(id).toLowerCase()) || null;
}

export function isOpencodeModelDeprecated(model) {
  return Boolean(getOpencodeModelInfo(model)?.deprecated);
}

export function getOpencodeCatalogAgeMs(now = Date.now()) {
  return snapshot ? now - snapshot.fetchedAt : Infinity;
}

export function isOpencodeCatalogStale(now = Date.now()) {
  return getOpencodeCatalogAgeMs(now) >= OPENCODE_CATALOG_TTL_MS;
}

/** Free, still-supported models of the installed snapshot. */
export function listOpencodeCatalogFreeModels() {
  if (!snapshot) return [];
  const out = [];
  for (const model of snapshot.models.values()) {
    if (model.deprecated || !model.isFree) continue;
    if (/^jev-/i.test(model.id)) continue;
    out.push({ id: model.id, name: model.name });
  }
  return out;
}

/**
 * Base URL for an external bridge (`opencode-free-bridge` running under Bun,
 * for its TLS fingerprint). Set ZENITH_OPENCODE_BASE_URL to e.g.
 * `http://127.0.0.1:20129/v1`; a trailing slash is ignored.
 */
export function getOpencodeBaseUrlOverride() {
  const raw = process.env.ZENITH_OPENCODE_BASE_URL;
  return typeof raw === "string" && raw.trim() ? trimBase(raw.trim()) : null;
}

/**
 * `/messages` carries a Claude-shaped body, which the OpenAI-compatible base
 * refuses. The legacy base serves it today, so that stays the default unless
 * the catalog pins an anthropic base for the model.
 */
function messagesBase(modelApi) {
  if (modelApi && /\/anthropic\//i.test(modelApi)) return modelApi;
  return OPENCODE_LEGACY_BASE_URL;
}

/** Full upstream URL for a model on a lane: chat, responses or messages. */
export function resolveOpencodeUrl(model, lane = "chat") {
  const override = getOpencodeBaseUrlOverride();
  if (override) return `${override}${laneSuffix(lane)}`;

  const modelApi = getOpencodeModelInfo(model)?.api || null;
  const base = modelApi || getOpencodeCatalogBaseUrl();

  if (lane === "messages") return `${messagesBase(modelApi)}${laneSuffix(lane)}`;
  // The Responses lane is that same base with /responses; a base that is not a
  // versioned one cannot be split that way, so such a model stays on chat.
  if (lane === "responses" && !base.endsWith("/v1")) return `${base}${laneSuffix("chat")}`;
  return `${base}${laneSuffix(lane)}`;
}

/**
 * Refresh the snapshot from the catalog. Concurrent callers share one request,
 * and a stale snapshot stays installed when the fetch fails.
 */
export async function refreshOpencodeCatalog({ fetchImpl, timeoutMs = OPENCODE_CATALOG_TIMEOUT_MS, force = false } = {}) {
  if (!force && !isOpencodeCatalogStale()) return { ok: true, cached: true };
  if (inflight) return inflight;

  const doFetch = fetchImpl || globalThis.fetch;
  inflight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await doFetch(OPENCODE_CATALOG_URL, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!res?.ok) return { ok: false, status: res?.status, code: "upstream_error" };
      const parsed = parseOpencodeCatalog(await res.json());
      if (!parsed) return { ok: false, status: res.status, code: "malformed" };
      snapshot = { ...parsed, fetchedAt: Date.now() };
      captureLine(`[OPENCODE] Catalog synced: ${parsed.models.size} models, base ${parsed.baseUrl}`);
      return { ok: true, count: parsed.models.size };
    } catch (err) {
      captureLine(`[OPENCODE] Catalog fetch failed: ${err?.name === "AbortError" ? "timeout" : err?.message || err}`);
      return { ok: false, code: "upstream_error" };
    } finally {
      clearTimeout(timer);
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Keep the snapshot fresh when the model sync scheduler is off (its run also
 * installs the catalog). Unref'd so it never holds the process open.
 */
export function startOpencodeCatalogRefresh({ fetchImpl, intervalMs = OPENCODE_CATALOG_TTL_MS } = {}) {
  const refresh = () => refreshOpencodeCatalog({ fetchImpl }).catch(() => {});
  refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  return timer;
}
