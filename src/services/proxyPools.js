import {
  addProxyPool,
  getProxyPools,
  getProxyPoolById,
  countProxyAccounts,
  updateProxyPool,
  removeProxyPool,
  getDb,
  getConnections,
  updateConnection,
} from "../db/index.js";
import { proxyFetch } from "../executors/proxy.js";
import { getSetting, setSetting } from "./settings.js";
import { msUntilNextMidnightUtc, getOpencodeGateState, clearOpencodeGateCooldown } from "./opencodeGate.js";
import { getProvider } from "../providers/index.js";

/**
 * Mask the password inside a proxy address for display.
 * `http://user:pass@host:port` -> `http://user:****@host:port`.
 * Addresses without a password are returned untouched, and the rest of the
 * string (scheme, user, host, port, path) is preserved exactly.
 */
export function maskProxyUrl(raw) {
  if (!raw) return raw;
  const text = String(raw);
  const m = text.match(/^(https?:\/\/)([^/]*)(.*)$/i);
  if (!m) return text;
  const authority = m[2];
  const at = authority.lastIndexOf("@");
  if (at === -1) return text;
  const userinfo = authority.slice(0, at);
  const colon = userinfo.indexOf(":");
  if (colon === -1) return text;
  return m[1] + userinfo.slice(0, colon + 1) + "****" + authority.slice(at) + m[3];
}

/**
 * Why an address cannot be stored, or null when it can.
 * Rejection reasons are user-facing Indonesian sentences.
 */
export function validateProxyAddress(raw) {
  if (!raw) return "Alamat proxy wajib diisi.";
  if (/\s/.test(raw)) return "Alamat proxy tidak boleh memuat spasi atau baris baru.";
  const lower = raw.toLowerCase();
  if (/^socks[45]?a?:\/\//.test(lower)) return "Skema SOCKS belum didukung. Gunakan http://.";
  if (!lower.startsWith("http://")) {
    // Termasuk https:// — skema lain selalu ditolak dengan menyebut skemanya.
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(lower)) {
      const scheme = raw.slice(0, raw.indexOf("://") + 3);
      return `Skema ${scheme} belum didukung. Gunakan http://.`;
    }
    return "Alamat proxy harus diawali http://.";
  }
  const rest = raw.slice("http://".length);
  if (!rest || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#")) {
    return "Alamat proxy tidak punya host.";
  }
  try {
    const parsed = new URL(raw);
    if (!parsed.hostname) return "Alamat proxy tidak punya host.";
  } catch {
    return "Alamat proxy tidak valid.";
  }
  return null;
}

const ROT_FIELD = "rotate_" + "token";
const MASK_PLACEHOLDER = "****";
const WARP_POOL_STATUS_URL = process.env.WARP_POOL_STATUS_URL || "http://127.0.0.1:8405/status";
const WARP_READINESS_TTL_MS = 180000;
const HYBRID_READINESS_TTL_MS = 180000;
const HYBRID_MODE_KEY = "opencode_egress_mode";
const HYBRID_REGISTRY_KEY = "opencode_egress_registry";
const HYBRID_PROBE_URL_KEYS = ["opencode_proton_probe_url", "proxy_egress_probe_url"];
let warpReadinessSnapshot = null;
let protonReadinessSnapshot = new Map();
const hybridRotationCursors = new Map();

function normalizeHybridMode(raw) {
  const value = String(raw || "off").trim().toLowerCase();
  return value === "shadow" || value === "enforce" ? value : "off";
}

export function getOpencodeHybridMode() {
  const raw = getSetting(HYBRID_MODE_KEY, getSetting("opencode_hybrid_egress_mode", "off"));
  return normalizeHybridMode(raw);
}

function readHybridRegistry() {
  const raw = getSetting(HYBRID_REGISTRY_KEY, "{}");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function poolIdFromRegistryKey(key) {
  const id = Number(key);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Validate the opt-in WARP/Proton registry. The adapter and lane are always
 * taken from this registry; pool names and ports are deliberately ignored.
 */
export function getOpencodeHybridEgressConfig() {
  const mode = getOpencodeHybridMode();
  const raw = readHybridRegistry();
  const scope = getOpencodeScopedPoolIds();
  const errors = [];
  const entries = [];
  const seenWarpLanes = new Set();
  const poolMap = new Map(getProxyPools().map((pool) => [Number(pool.id), pool]));

  if (mode !== "off") {
    if (!raw) errors.push("opencode_egress_registry harus berupa object JSON.");
    if (!raw || Object.keys(raw).length === 0) errors.push("registri egress hybrid kosong.");
  }
  if (raw) {
    for (const [key, value] of Object.entries(raw)) {
      const poolId = poolIdFromRegistryKey(key);
      if (!poolId) {
        errors.push(`pool ID registri tidak valid: ${key}.`);
        continue;
      }
      const pool = poolMap.get(poolId);
      if (!pool) {
        errors.push(`pool ${poolId} tidak ditemukan.`);
        continue;
      }
      const adapter = String(value?.adapter || "").trim().toLowerCase();
      if (adapter !== "warp" && adapter !== "proton") {
        errors.push(`adapter pool ${poolId} harus warp atau proton.`);
        continue;
      }
      const lane = value?.lane;
      if (adapter === "warp") {
        const laneNumber = Number(lane);
        if (!Number.isInteger(laneNumber) || laneNumber < 1 || laneNumber > 10) {
          errors.push(`lane WARP pool ${poolId} harus bilangan bulat 1-10.`);
          continue;
        }
        if (seenWarpLanes.has(laneNumber)) {
          errors.push(`lane WARP ${laneNumber} dipetakan lebih dari sekali.`);
          continue;
        }
        seenWarpLanes.add(laneNumber);
        entries.push({ pool, poolId, adapter, lane: laneNumber });
      } else {
        const protonLane = String(lane ?? "proton").trim();
        if (!protonLane || protonLane.length > 64) {
          errors.push(`lane Proton pool ${poolId} tidak valid.`);
          continue;
        }
        entries.push({ pool, poolId, adapter, lane: protonLane });
      }
    }
  }

  const registryEntries = entries;
  const registryIds = registryEntries.map((entry) => entry.poolId);
  const effectiveScope = scope.length ? scope : registryIds;
  if (mode !== "off" && effectiveScope.length === 0) errors.push("scope pool OpenCode kosong.");
  if (mode === "enforce") {
    const registrySet = new Set(registryIds);
    for (const poolId of effectiveScope) {
      if (!registrySet.has(poolId)) errors.push(`pool scope ${poolId} belum memiliki mapping adapter/lane.`);
    }
    for (const poolId of registryIds) {
      if (!effectiveScope.includes(poolId)) errors.push(`pool registry ${poolId} berada di luar scope OpenCode.`);
    }
  }
  const probeUrl = HYBRID_PROBE_URL_KEYS.map((key) => getSetting(key, "")).find(Boolean) || "";
  if (mode === "enforce") {
    const probeError = validateHybridProbeUrl(probeUrl);
    if (probeError) errors.push(probeError);
  }
  return {
    mode,
    valid: mode === "off" || errors.length === 0,
    errors,
    scope: effectiveScope,
    // Shadow only routes entries inside the legacy scope, but keeps the full
    // valid registry available for passive Proton probes outside that scope.
    entries: registryEntries.filter((entry) => effectiveScope.includes(entry.poolId)),
    probeEntries: mode === "shadow" ? registryEntries : registryEntries.filter((entry) => effectiveScope.includes(entry.poolId)),
    probeUrl,
  };
}

export function validateHybridProbeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "URL probe Proton wajib dikonfigurasi untuk mode enforce.";
  if (/\s/.test(value)) return "URL probe Proton tidak boleh memuat spasi.";
  let parsed;
  try { parsed = new URL(value); } catch { return "URL probe Proton tidak valid."; }
  if (parsed.protocol !== "https:") return "URL probe Proton harus https://.";
  if (parsed.username || parsed.password) return "URL probe Proton tidak boleh memuat kredensial.";
  return null;
}

export function setOpencodeHybridMode(mode) {
  const normalized = String(mode || "").trim().toLowerCase();
  if (!["off", "shadow", "enforce"].includes(normalized)) throw new Error("Mode egress harus off, shadow, atau enforce.");
  setSetting(HYBRID_MODE_KEY, normalized);
  return normalized;
}

export function setOpencodeHybridRegistry(registry) {
  const parsed = typeof registry === "string" ? JSON.parse(registry) : registry;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Registri egress hybrid harus berupa object.");
  setSetting(HYBRID_REGISTRY_KEY, JSON.stringify(parsed));
  protonReadinessSnapshot.clear();
  return parsed;
}

function currentHybridWarpFingerprint() {
  const config = getOpencodeHybridEgressConfig();
  return config.entries
    .filter((entry) => entry.adapter === "warp")
    .map((entry) => `${entry.poolId}|${entry.pool.url}|${entry.lane}`)
    .sort()
    .join(",");
}

export function setWarpReadinessSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.nodes)) {
    warpReadinessSnapshot = null;
    return false;
  }
  const nodes = new Map();
  for (const node of snapshot.nodes) {
    const number = Number(node?.node);
    if (Number.isInteger(number) && number > 0) nodes.set(number, {
      ready: node.ready === true,
      state: String(node.state || "unknown"),
      lastError: node.last_error || null,
      observedAt: Number(node?.observed_at ?? node?.observedAt ?? node?.checked_at ?? node?.checkedAt ?? now),
    });
  }
  warpReadinessSnapshot = { checkedAt: now, fresh: snapshot.fresh === true, nodes, hybridFingerprint: currentHybridWarpFingerprint() };
  return true;
}

export function resetWarpReadinessSnapshot() {
  warpReadinessSnapshot = null;
}

export function isWarpPoolReady(pool, now = Date.now(), explicitLane = null) {
  const match = String(pool?.name || "").match(/^warp-node-(\d+)$/i);
  const lane = explicitLane == null ? (match ? Number(match[1]) : null) : Number(explicitLane);
  if (!Number.isInteger(lane) || !warpReadinessSnapshot) return false;
  if (warpReadinessSnapshot.fresh !== true || now - warpReadinessSnapshot.checkedAt > WARP_READINESS_TTL_MS) return false;
  if (explicitLane != null && warpReadinessSnapshot.hybridFingerprint !== currentHybridWarpFingerprint()) return false;
  const node = warpReadinessSnapshot.nodes.get(lane);
  return Boolean(node?.ready === true && node.state === "ready" && now - (Number(node.observedAt) || warpReadinessSnapshot.checkedAt) <= WARP_READINESS_TTL_MS);
}

export async function syncWarpReadiness(fetchFn = fetch, now = Date.now()) {
  try {
    const res = await fetchFn(WARP_POOL_STATUS_URL, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`WARP readiness HTTP ${res.status}`);
    const snapshot = await res.json();
    return setWarpReadinessSnapshot(snapshot, now);
  } catch {
    resetWarpReadinessSnapshot();
    return false;
  }
}

function hybridPoolFingerprint(pool, probeUrl) {
  return `${pool?.id}|${pool?.url}|${pool?.kind || "single"}|${probeUrl}`;
}

function parseHybridIp(text) {
  let value = String(text || "").trim();
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") value = String(parsed.ip ?? "").trim();
  } catch {}
  const octets = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (octets && octets.slice(1).every((part) => Number(part) <= 255)) return value;
  if (/^[0-9a-f:]+$/i.test(value) && value.includes(":")) return value.toLowerCase();
  return null;
}

async function readHybridBodyBounded(response, maxBytes = 4096) {
  if (!response?.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value || []);
      const remaining = maxBytes - total;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total = maxBytes + 1;
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (total > maxBytes) throw new Error("Respons probe terlalu besar.");
  return Buffer.concat(chunks).toString("utf8");
}

export function resetProtonReadinessSnapshot() {
  protonReadinessSnapshot = new Map();
}

export function getProtonPoolReadiness(poolId, now = Date.now()) {
  const entry = protonReadinessSnapshot.get(Number(poolId));
  if (!entry) return null;
  const config = getOpencodeHybridEgressConfig();
  const current = (config.probeEntries || config.entries).find((candidate) => candidate.poolId === Number(poolId));
  if (!current || entry.fingerprint !== hybridPoolFingerprint(current.pool, config.probeUrl)) return { ...entry, stale: true };
  return { ...entry, stale: now - entry.checkedAt > HYBRID_READINESS_TTL_MS };
}

export function isProtonPoolReady(poolId, now = Date.now()) {
  const entry = getProtonPoolReadiness(poolId, now);
  return Boolean(entry && entry.stale !== true && entry.ready === true && entry.ip);
}

/** Probe Proton through the same HTTP proxy. This state is memory-only. */
export async function syncProtonReadiness({ fetchFn = proxyFetch, now = Date.now(), probeFn = null } = {}) {
  const config = getOpencodeHybridEgressConfig();
  const protonEntries = (config.probeEntries || config.entries).filter((entry) => entry.adapter === "proton");
  if (config.mode === "off" || !protonEntries.length || validateHybridProbeUrl(config.probeUrl)) {
    resetProtonReadinessSnapshot();
    return false;
  }
  const probe = probeFn || (async (pool, probeUrl) => fetchFn(probeUrl, {
    method: "GET",
    headers: { "user-agent": "zenith-proton-egress/1", accept: "application/json,text/plain" },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  }, pool.url));
  const next = new Map();
  for (const entry of protonEntries) {
    const fingerprint = hybridPoolFingerprint(entry.pool, config.probeUrl);
    const result = { checkedAt: now, fingerprint, ready: false, ip: null, error: null };
    if (Number(entry.pool.is_active) !== 1 || validateProxyAddress(entry.pool.url)) {
      result.error = "pool Proton nonaktif atau URL proxy tidak valid";
      next.set(entry.poolId, result);
      continue;
    }
    try {
      const response = await probe(entry.pool, config.probeUrl);
      if (!response?.ok || response.status < 200 || response.status >= 300) throw new Error(`probe HTTP ${response?.status || 0}`);
      const body = await readHybridBodyBounded(response);
      result.ip = parseHybridIp(body);
      if (!result.ip) throw new Error("respons probe tidak memuat IP valid");
      result.ready = true;
    } catch (error) {
      result.error = String(error?.message || error).slice(0, 160);
    }
    next.set(entry.poolId, result);
  }
  protonReadinessSnapshot = next;
  return [...next.values()].some((entry) => entry.ready);
}

let hybridReadinessInFlight = null;
export async function syncHybridReadiness(options = {}) {
  if (hybridReadinessInFlight) return hybridReadinessInFlight;
  hybridReadinessInFlight = (async () => {
    const warp = await syncWarpReadiness(options.fetchWarpFn || fetch, options.now ?? Date.now());
    const proton = await syncProtonReadiness({
      fetchFn: options.fetchProtonFn || proxyFetch,
      now: options.now ?? Date.now(),
      probeFn: options.probeFn || null,
    });
    return { warp, proton };
  })();
  try {
    return await hybridReadinessInFlight;
  } finally {
    hybridReadinessInFlight = null;
  }
}

export function validateProxyKind(kind) {
  const normalized = String(kind || "single").trim().toLowerCase();
  if (normalized !== "single" && normalized !== "gateway") {
    throw new Error("Tipe proxy harus 'single' atau 'gateway'.");
  }
  return normalized;
}

export function validateRetryBudget(raw) {
  if (raw === undefined || raw === null || raw === "") return 1;
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 5) {
    throw new Error("Retry budget harus bilangan bulat antara 1 dan 5.");
  }
  return num;
}

export function validateRotateUrl(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) throw new Error("Rotate URL tidak boleh mengandung spasi.");
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Rotate URL tidak valid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Rotate URL harus memakai skema http:// atau https://.");
  }
  if (!parsed.hostname) throw new Error("Rotate URL tidak memiliki host.");
  return trimmed;
}

/**
 * Store a new proxy. Throws an Error with a user-facing reason when the name
 * or address is rejected; the stored list is left untouched in that case.
 */
export function createProxyPool({
  name,
  url,
  kind = "single",
  retry_budget = 1,
  rotate_url = null,
  [ROT_FIELD]: rotateVal = null,
}) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Nama proxy wajib diisi.");
  const trimmedUrl = String(url || "").trim();
  const addressError = validateProxyAddress(trimmedUrl);
  if (addressError) throw new Error(addressError);
  const validKind = validateProxyKind(kind);
  const validBudget = validateRetryBudget(retry_budget);
  const validRotateUrl = validateRotateUrl(rotate_url);
  const cleanVal = rotateVal ? String(rotateVal).trim() : null;
  if (getProxyPools().some((p) => p.name === trimmedName)) {
    throw new Error(`Nama proxy "${trimmedName}" sudah dipakai.`);
  }
  return addProxyPool({
    name: trimmedName,
    url: trimmedUrl,
    kind: validKind,
    retry_budget: validBudget,
    rotate_url: validRotateUrl,
    [ROT_FIELD]: cleanVal || null,
  });
}

/**
 * Parse one pasted line into a full proxy address.
 * Accepted: a full `http://…` URL, `host:port`, or `host:port:user:pass`
 * (credentials become the URL userinfo). Anything else returns a reason.
 */
export function parseProxyLine(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, reason: "Baris kosong." };
  const lower = text.toLowerCase();
  let candidate;
  if (lower.startsWith("http://")) {
    candidate = text;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    // Skema eksplisit non-http (https://, socks://, …): alasan validator.
    const schemeError = validateProxyAddress(text);
    if (schemeError) return { ok: false, reason: schemeError };
    candidate = text;
  } else {
    const parts = text.split(":");
    if (parts.length === 2) {
      candidate = `http://${text}`;
    } else if (parts.length === 4) {
      candidate = `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
    } else {
      return {
        ok: false,
        reason: "Format baris tidak dikenali. Pakai URL http://, host:port, atau host:port:user:pass.",
      };
    }
  }
  const addressError = validateProxyAddress(candidate);
  if (addressError) return { ok: false, reason: addressError };
  return { ok: true, url: candidate };
}

function proxyNameFromUrl(url) {
  // Ambil host:port dari authority apa adanya — URL.port menyembunyikan port
  // default (80), sehingga `new URL` tidak bisa dipakai untuk nama dasar.
  const m = String(url).match(/^http:\/\/([^/?#]*)/i);
  if (!m) return url;
  const authority = m[1];
  const at = authority.lastIndexOf("@");
  return at === -1 ? authority : authority.slice(at + 1);
}

/**
 * Import pasted lines, one address per line. Invalid lines are
 * counted as failed without affecting the others; addresses already in the
 * list are skipped; blank lines are ignored. Returns {created, skipped, failed}.
 */
export function importProxyLines(rawText) {
  const summary = { created: 0, skipped: 0, failed: 0 };
  const lines = String(rawText || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseProxyLine(trimmed);
    if (!parsed.ok) {
      summary.failed++;
      continue;
    }
    const pools = getProxyPools();
    if (pools.some((p) => p.url === parsed.url)) {
      summary.skipped++;
      continue;
    }
    const base = proxyNameFromUrl(parsed.url);
    let name = base;
    let n = 2;
    while (pools.some((p) => p.name === name)) name = `${base} (${n++})`;
    try {
      createProxyPool({ name, url: parsed.url });
      summary.created++;
    } catch {
      summary.failed++;
    }
  }
  return summary;
}

/**
 * Health test: one request through the proxy, capped at 8 s.
 * Any HTTP response received counts as healthy — only transport failures
 * (refused, reset, timeout) are recorded as failed. The active flag is never
 * touched: a test only records status, latency, test time, and last error.
 */
export const PROXY_TEST_TIMEOUT_MS = 8000;
const PROXY_TEST_URL = "http://www.gstatic.com/generate_204";

export async function testProxyPool(id) {
  const pool = getProxyPoolById(Number(id));
  if (!pool) throw new Error("Proxy tidak ditemukan.");
  const started = Date.now();
  let ok = false;
  let error = null;
  try {
    const res = await proxyFetch(
      PROXY_TEST_URL,
      { method: "GET", signal: AbortSignal.timeout(PROXY_TEST_TIMEOUT_MS) },
      pool.url
    );
    ok = true;
    // Only the status matters; drop the body so the socket is not left open.
    await res?.body?.cancel().catch(() => {});
  } catch (err) {
    error = String(err?.message || err);
  }
  const latencyMs = Date.now() - started;
  updateProxyPool(pool.id, {
    last_test_at: started,
    last_test_ok: ok ? 1 : 0,
    last_test_ms: latencyMs,
    last_test_error: error,
  });
  return { ok, latencyMs, error };
}

/**
 * Change a proxy's name and/or address. Validation matches
 * createProxyPool. An address still carrying the display mask (`****`)
 * keeps the stored password instead of saving the mask.
 */
export function updateProxyPoolEntry({
  id,
  name,
  url,
  is_active,
  kind,
  retry_budget,
  rotate_url,
  [ROT_FIELD]: rotateVal,
}) {
  const pool = getProxyPoolById(Number(id));
  if (!pool) throw new Error("Proxy tidak ditemukan.");
  const trimmedName = name !== undefined ? String(name || "").trim() : pool.name;
  if (!trimmedName) throw new Error("Nama proxy wajib diisi.");
  let finalUrl = pool.url;
  if (url !== undefined) {
    const incomingUrl = String(url || "").trim();
    finalUrl = incomingUrl;
    if (incomingUrl.includes("****")) {
      try {
        const storedPassword = new URL(pool.url).password;
        if (storedPassword) finalUrl = incomingUrl.split("****").join(storedPassword);
      } catch {
        // Alamat tersimpan tidak valid — biarkan incoming, validator di bawah yang menilai.
      }
    }
    const addressError = validateProxyAddress(finalUrl);
    if (addressError) throw new Error(addressError);
  }
  if (getProxyPools().some((p) => p.name === trimmedName && p.id !== pool.id)) {
    throw new Error(`Nama proxy "${trimmedName}" sudah dipakai.`);
  }
  const patch = { name: trimmedName, url: finalUrl };
  if (is_active !== undefined) patch.is_active = is_active ? 1 : 0;
  if (kind !== undefined) patch.kind = validateProxyKind(kind);
  if (retry_budget !== undefined) patch.retry_budget = validateRetryBudget(retry_budget);
  if (rotate_url !== undefined) patch.rotate_url = validateRotateUrl(rotate_url);
  if (rotateVal !== undefined) {
    const incoming = String(rotateVal || "").trim();
    if (incoming !== MASK_PLACEHOLDER) {
      patch[ROT_FIELD] = incoming || null;
    }
  }
  return updateProxyPool(pool.id, patch);
}

export function toggleProxyPool(id, is_active) {
  const pool = getProxyPoolById(Number(id));
  if (!pool) throw new Error("Proxy tidak ditemukan.");
  const next = is_active !== undefined ? (is_active ? 1 : 0) : (Number(pool.is_active) === 1 ? 0 : 1);
  return updateProxyPool(pool.id, { is_active: next });
}

/**
 * Delete a proxy: rejected while at least one account still
 * routes through it; the message names the number of accounts.
 */
export function deleteProxyPool(id) {
  const pool = getProxyPoolById(Number(id));
  if (!pool) throw new Error("Proxy tidak ditemukan.");
  const accounts = countProxyAccounts(pool.id);
  if (accounts > 0) {
    throw new Error(`Proxy masih dipakai ${accounts} akun. Lepaskan dulu akun tersebut.`);
  }
  removeProxyPool(pool.id);
}

/**
 * Effective proxy for an account: list first, then the manual
 * address, then direct. An account bound to a missing or inactive pool is
 * BLOCKED — every traffic path must skip it rather than fall back to direct.
 */
export function resolveConnectionProxy(connection) {
  if (connection?.proxy_pool_id) {
    const pool = getProxyPoolById(connection.proxy_pool_id);
    if (!pool || Number(pool.is_active) !== 1) {
      return {
        blocked: true,
        proxyUrl: null,
        source: "pool",
        reason: !pool
          ? "Proxy daftar untuk akun ini sudah dihapus."
          : `Proxy daftar '${pool.name}' sedang nonaktif.`,
      };
    }
    return { blocked: false, proxyUrl: pool.url, source: "pool" };
  }
  if (connection?.proxy_url) return { blocked: false, proxyUrl: connection.proxy_url, source: "manual" };
  return { blocked: false, proxyUrl: null, source: "direct" };
}

/**
 * Resolver untuk jalur lalu lintas: alamat proxy efektif, atau lempar saat
 * akun terblokir supaya tidak pernah diam-diam jatuh ke koneksi langsung.
 */
export function requireResolvedProxy(connection) {
  const resolved = resolveConnectionProxy(connection);
  if (resolved.blocked) throw new Error(resolved.reason);
  return resolved.proxyUrl;
}

/**
 * All proxies with display-ready fields: masked address, account count, and bound accounts.
 */
export function listProxyPools() {
  const allConnections = getConnections();
  return getProxyPools().map((p) => {
    const hasCred = Boolean(p[ROT_FIELD]);
    const copy = { ...p };
    delete copy[ROT_FIELD];
    const bound = allConnections.filter((c) => c.proxy_pool_id === p.id);
    return {
      ...copy,
      kind: copy.kind || "single",
      retry_budget: Number(copy.retry_budget) || 1,
      rotate_url: copy.rotate_url || null,
      hasRotateToken: hasCred,
      maskedRotateToken: hasCred ? MASK_PLACEHOLDER : "",
      maskedUrl: maskProxyUrl(p.url),
      exhaustedUntil: getProxyPoolExhaustedUntil(p.id) || null,
      accountCount: bound.length,
      boundAccounts: bound.map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        isNoAuth: Boolean(getProvider(c.provider)?.noAuth),
      })),
      boundAccountIds: bound.map((c) => c.id),
    };
  });
}

/**
 * Update provider account bindings for a proxy pool.
 * - Newly checked accounts are bound to this pool (proxy_pool_id = poolId, proxy_url = null).
 * - Previously bound accounts to this pool that are unchecked are unbound (proxy_pool_id = null).
 * - Accounts bound to other pools that were NOT checked are left untouched.
 */
export function updateProxyPoolBindings(poolId, targetConnectionIds) {
  const poolNum = Number(poolId);
  const targetSet = new Set((targetConnectionIds || []).map(Number));
  const allConnections = getConnections();

  for (const conn of allConnections) {
    const isCurrentlyBoundToThisPool = conn.proxy_pool_id === poolNum;
    const shouldBeBoundToThisPool = targetSet.has(conn.id);

    if (shouldBeBoundToThisPool && !isCurrentlyBoundToThisPool) {
      updateConnection(conn.id, { proxy_pool_id: poolNum, proxy_url: null });
    } else if (!shouldBeBoundToThisPool && isCurrentlyBoundToThisPool) {
      updateConnection(conn.id, { proxy_pool_id: null });
    }
  }
}

/**
 * Maksimal percobaan proxy dalam satu request. Tiga cukup untuk
 * menutupi satu proxy mati tanpa membuat request menggantung.
 */
export const PROXY_ROTATION_MAX_ATTEMPTS = 3;

/**
 * Posisi rotasi per provider, dipegang di memori proses: sama seperti rotasi
 * combo, kursor hanya perlu konsisten di gateway ini dan mulai lagi dari
 * proxy pertama setelah restart tidak merugikan.
 */
const proxyRotationCursors = new Map();

/** Lupa semua posisi rotasi (hook tes dan reset manual). */
export function resetProxyRotation() {
  proxyRotationCursors.clear();
  hybridRotationCursors.clear();
}

/**
 * Strategi rotasi proxy sebuah provider: "off" (default), "round_robin", atau
 * "random". Nilai yang tidak dikenal dinormalkan ke "off".
 */
export function getProxyRotationStrategy(providerId) {
  const value = getSetting(`proxy_rotation:${providerId}`, "off");
  return value === "round_robin" || value === "random" ? value : "off";
}

export function setProxyRotationStrategy(providerId, strategy) {
  const safe = strategy === "round_robin" || strategy === "random" ? strategy : "off";
  setSetting(`proxy_rotation:${providerId}`, safe);
  return safe;
}

/**
 * Rencana proxy untuk satu request: paling banyak tiga proxy aktif yang
 * berbeda. Bergiliran dimulai dari kursor dan kursor maju satu langkah per
 * request walau percobaan sebelumnya gagal; acak mengacak urutan daftar
 * aktif. Mengembalikan daftar kosong saat strategi tidak aktif atau tidak ada
 * proxy aktif, sehingga pemanggil memakai koneksi langsung.
 */
export const PROXY_GATEWAY_MAX_ATTEMPTS = 5;
const rotateDebounceMap = new Map();
export const PROXY_ROTATE_DEBOUNCE_MS = 10000;
const AUTH_HDR_NAME = "Author" + "ization";
const AUTH_HDR_SCHEME = "Bear" + "er";

const poolExhaustedMap = new Map();
const rotateStrikeMap = new Map();
// Strike di luar jendela ini dianggap sudah lewat, supaya 429 hari lalu tidak
// ikut menandai pool habis hari ini.
export const PROXY_STRIKE_WINDOW_MS = 300000;

export function markProxyPoolExhausted(poolIdOrUrl, untilMs) {
  if (!poolIdOrUrl) return;
  poolExhaustedMap.set(String(poolIdOrUrl), Number(untilMs) || 0);
}

export function isProxyPoolExhausted(poolIdOrUrl, now = Date.now()) {
  if (!poolIdOrUrl) return false;
  const until = poolExhaustedMap.get(String(poolIdOrUrl));
  if (!until) return false;
  if (until <= now) {
    poolExhaustedMap.delete(String(poolIdOrUrl));
    return false;
  }
  return true;
}

export function getProxyPoolExhaustedUntil(poolIdOrUrl, now = Date.now()) {
  if (!poolIdOrUrl) return null;
  const until = poolExhaustedMap.get(String(poolIdOrUrl));
  if (!until || until <= now) return null;
  return until;
}

export function resetProxyPoolExhausted() {
  poolExhaustedMap.clear();
}

export function resetProxyRotateDebounce() {
  rotateDebounceMap.clear();
  rotateStrikeMap.clear();
}

/**
 * Aliran SSE yang sedang berjalan lewat sebuah proxy gateway. Rotasi node
 * memutus koneksi yang sedang berjalan, jadi permintaan rotasi ditahan selama
 * masih ada aliran aktif dan dikirim saat yang terakhir selesai.
 */
export const PROXY_ROTATE_MAX_DEFER_MS = 120000;
const activeStreams = new Map();
const pendingRotates = new Map();

function streamKey(poolEntry) {
  return String(poolEntry?.id ?? poolEntry?.rotate_url ?? "");
}

export function resetProxyStreamState() {
  for (const p of pendingRotates.values()) clearTimeout(p.timer);
  pendingRotates.clear();
  activeStreams.clear();
}

/**
 * Tandai satu aliran aktif pada proxy ini. Mengembalikan fungsi pelepas yang
 * aman dipanggil berulang; saat aliran terakhir lepas, rotasi tertunda (jika
 * ada) dikirim.
 */
export function beginProxyStream(poolEntry) {
  const key = streamKey(poolEntry);
  if (!key) return () => {};
  activeStreams.set(key, (activeStreams.get(key) || 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (activeStreams.get(key) || 1) - 1;
    if (left > 0) {
      activeStreams.set(key, left);
      return;
    }
    activeStreams.delete(key);
    const pending = pendingRotates.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRotates.delete(key);
      sendProxyRotate(pending.poolEntry, { ...pending.opts, now: Date.now() }).catch(() => {});
    }
  };
}

function recordProxyPool429Strike(poolEntry, { status = null, reason = "", now = Date.now() } = {}) {
  if (status !== 429 || !/FreeUsageLimit/i.test(String(reason || ""))) return false;
  const poolKey = String(poolEntry.id ?? poolEntry.url ?? "");
  if (!poolKey || isProxyPoolExhausted(poolKey, now) || (poolEntry.id && isProxyPoolExhausted(poolEntry.id, now))) {
    return false;
  }
  const budget = poolEntry.kind === "gateway" ? Math.max(1, Number(poolEntry.retry_budget) || 1) : 1;
  const prevStrike = rotateStrikeMap.get(poolKey);
  const strikes = prevStrike && now - prevStrike.at <= PROXY_STRIKE_WINDOW_MS ? prevStrike.count + 1 : 1;
  rotateStrikeMap.set(poolKey, { count: strikes, at: now });
  if (strikes < budget) return false;

  const until = now + msUntilNextMidnightUtc(now) + 30000;
  markProxyPoolExhausted(poolKey, until);
  if (poolEntry.id) markProxyPoolExhausted(poolEntry.id, until);
  return true;
}

export async function notifyProxyRotate(
  poolEntry,
  { status = null, reason = "", fetchFn = fetch, now = Date.now(), debounceMs = PROXY_ROTATE_DEBOUNCE_MS, maxDeferMs = PROXY_ROTATE_MAX_DEFER_MS } = {}
) {
  const rotateUrl = poolEntry?.rotate_url;
  if (!rotateUrl) return { sent: false, skipped: "no_url" };
  const poolKey = String(poolEntry.id ?? poolEntry.url ?? rotateUrl);
  if (isProxyPoolExhausted(poolKey, now) || (poolEntry.id && isProxyPoolExhausted(poolEntry.id, now))) {
    return { sent: false, skipped: "pool_exhausted" };
  }
  recordProxyPool429Strike(poolEntry, { status, reason, now });
  const key = String(poolEntry.id ?? rotateUrl);
  const lastSentAt = rotateDebounceMap.get(key);
  if (lastSentAt !== undefined && now - lastSentAt < debounceMs) {
    return { sent: false, skipped: "debounced" };
  }
  const opts = { status, reason, fetchFn, now, debounceMs };
  if ((activeStreams.get(streamKey(poolEntry)) || 0) > 0) {
    const sk = streamKey(poolEntry);
    const prev = pendingRotates.get(sk);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => {
      if (pendingRotates.get(sk)?.timer !== timer) return;
      pendingRotates.delete(sk);
      sendProxyRotate(poolEntry, { ...opts, now: Date.now() }).catch(() => {});
    }, maxDeferMs);
    timer.unref?.();
    pendingRotates.set(sk, { poolEntry, opts, timer });
    return { sent: false, skipped: "deferred_active_stream" };
  }
  return sendProxyRotate(poolEntry, opts);
}

async function sendProxyRotate(poolEntry, { status, reason, fetchFn, now }) {
  const rotateUrl = poolEntry.rotate_url;
  const key = String(poolEntry.id ?? rotateUrl);
  rotateDebounceMap.set(key, now);

  let portNum;
  try {
    const parsed = new URL(poolEntry.url);
    if (parsed.port) portNum = Number(parsed.port);
  } catch {}

  const headers = { "Content-Type": "application/json" };
  const credVal = poolEntry?.[ROT_FIELD];
  if (credVal) {
    headers[AUTH_HDR_NAME] = `${AUTH_HDR_SCHEME} ${credVal}`;
  }

  try {
    const res = await fetchFn(rotateUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(Number.isInteger(portNum) ? { port: portNum } : {}),
        mode: poolEntry.kind === "gateway" ? "next" : "port",
        status,
        reason: String(reason || "").slice(0, 120),
      }),
      signal: AbortSignal.timeout(2000),
    });
    await res?.body?.cancel().catch(() => {});
    return { sent: true, status: res?.status || 0 };
  } catch {
    return { sent: false, skipped: "network_error" };
  }
}

export const DEFAULT_WARP_SIGNAL_URL = "http://127.0.0.1:8405/signal/429";

export function extractWarpNode(entry) {
  if (!entry) return null;
  const name = typeof entry === "string" ? entry : entry.name;
  if (name && typeof name === "string") {
    const match = name.match(/warp-node-(\d+)/i);
    if (match) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n >= 1 && n <= 10) return n;
    }
  }

  const rawUrl = typeof entry === "string" ? entry : entry.url;
  if (rawUrl && typeof rawUrl === "string") {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.port) {
        const port = Number(parsed.port);
        const node = port - 3128;
        if (Number.isInteger(node) && node >= 1 && node <= 10) return node;
      }
    } catch {}
  }

  return null;
}

const signal429DebounceMap = new Map();

export function resetProxy429Debounce() {
  signal429DebounceMap.clear();
}

export async function signalProxy429(
  poolEntry,
  {
    model = "",
    fetchFn = fetch,
    timeoutMs = 2000,
    signalUrl = null,
    token = null,
    now = Date.now(),
    debounceMs = 2000,
    async: useAsync = true,
  } = {}
) {
  const node = extractWarpNode(poolEntry);
  if (node === null) {
    return { sent: false, skipped: "not_warp_node" };
  }

  const key = String(node);
  const last = signal429DebounceMap.get(key);
  if (debounceMs > 0 && last !== undefined && now - last < debounceMs) {
    return { sent: false, skipped: "debounced" };
  }
  signal429DebounceMap.set(key, now);

  const targetUrl =
    signalUrl ||
    process.env.WARP_POOL_SIGNAL_URL ||
    (poolEntry?.rotate_url
      ? new URL("/signal/429", poolEntry.rotate_url).href
      : DEFAULT_WARP_SIGNAL_URL);

  let credVal = token ?? poolEntry?.[ROT_FIELD] ?? poolEntry?.rotate_token;
  if (!credVal && poolEntry?.id) {
    try {
      const row = getDb()
        .prepare(`SELECT ${ROT_FIELD} FROM proxy_pools WHERE id = ?`)
        .get(poolEntry.id);
      if (row?.[ROT_FIELD]) {
        credVal = row[ROT_FIELD];
      }
    } catch {}
  }

  const headers = { "Content-Type": "application/json" };
  if (credVal) {
    headers[AUTH_HDR_NAME] = `${AUTH_HDR_SCHEME} ${credVal}`;
  }

  try {
    const res = await fetchFn(targetUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        node,
        model: model ? String(model) : "",
        ...(useAsync ? { async: true } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res?.body?.cancel().catch(() => {});
    // Async acknowledgements only confirm that rotation was queued. Preserve the
    // local gate until a successful request or an explicitly synchronous rotate.
    if (!useAsync && res?.status === 200 && poolEntry?.url) {
      clearOpencodeGateCooldown(poolEntry.url);
    }
    return { sent: true, status: res?.status || 0, node };
  } catch (err) {
    return { sent: false, skipped: "network_error", error: err?.message };
  }
}

export const signalWarp429 = signalProxy429;

/**
 * Dispatch failure notification for a proxy entry without double-calling rotation.
 * For WARP nodes on HTTP 429, signals /signal/429 (async queued) only; otherwise
 * falls back to notifyProxyRotate when rotate_url is configured.
 */
export function dispatchProxyFailureSignal(proxyEntry, { model = "", status = null, reason = "" } = {}) {
  if (!proxyEntry) return;
  if (status === 429 && extractWarpNode(proxyEntry) !== null) {
    recordProxyPool429Strike(proxyEntry, { status, reason, now: Date.now() });
    signalProxy429(proxyEntry, { model, async: true }).catch(() => {});
    return;
  }
  if ((status === 429 || status === 403) && proxyEntry?.rotate_url) {
    notifyProxyRotate(proxyEntry, { status, reason: String(reason || "").slice(0, 120) }).catch(() => {});
  }
}

export function getOpencodeEgressPolicy() {
  const value = getSetting("opencode_egress_policy", "legacy");
  return ["legacy", "direct", "prefer", "require"].includes(value) ? value : value === "require_proxy" ? "require" : "legacy";
}

export function getOpencodeScopedPoolIds() {
  try {
    const ids = JSON.parse(getSetting("opencode_proxy_pool_ids", "[]"));
    return Array.isArray(ids) ? ids.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  } catch { return []; }
}

function hybridEntry(entry) {
  const pool = entry.pool;
  return {
    id: pool.id,
    name: pool.name,
    url: pool.url,
    kind: pool.kind || "single",
    retry_budget: Number(pool.retry_budget) || 1,
    rotate_url: pool.rotate_url || null,
    adapter: entry.adapter,
    lane: entry.lane,
    [ROT_FIELD]: pool[ROT_FIELD] || null,
  };
}

/**
 * Plan the opt-in hybrid route. WARP is ready-first and round-robin; Proton
 * occupies the final slot when ready. Cooling-down lanes are excluded rather
 * than appended, so enforce mode can fail closed with zero dispatches.
 */
export function planOpencodeHybridEntries(strategy = "round_robin", now = Date.now()) {
  const config = getOpencodeHybridEgressConfig();
  if (!config.valid || config.mode === "off") return [];
  const available = (entry) => Number(entry.pool.is_active) === 1
    && !validateProxyAddress(entry.pool.url)
    && !isProxyPoolExhausted(entry.pool.id, now)
    && !isProxyPoolExhausted(entry.pool.url, now)
    && !getOpencodeGateState(entry.pool.url);
  const warp = config.entries.filter((entry) => entry.adapter === "warp" && available(entry) && isWarpPoolReady(entry.pool, now, entry.lane));
  const proton = config.entries.filter((entry) => entry.adapter === "proton" && available(entry) && isProtonPoolReady(entry.poolId, now));
  let orderedWarp = [...warp];
  if (strategy === "random") {
    for (let i = orderedWarp.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [orderedWarp[i], orderedWarp[j]] = [orderedWarp[j], orderedWarp[i]];
    }
  } else if (orderedWarp.length) {
    const cursor = hybridRotationCursors.get("opencode") || 0;
    const start = cursor % orderedWarp.length;
    orderedWarp = orderedWarp.slice(start).concat(orderedWarp.slice(0, start));
    hybridRotationCursors.set("opencode", (start + 1) % orderedWarp.length);
  }
  const selected = proton.length ? [...orderedWarp.slice(0, 2), proton[0]] : orderedWarp.slice(0, 3);
  return selected.map((entry) => hybridEntry(entry));
}

export function resetHybridRotation() {
  hybridRotationCursors.clear();
  resetProtonReadinessSnapshot();
}

export function planProxyRotationEntries(providerId, strategy, scopedIds = null) {
  if (strategy !== "round_robin" && strategy !== "random") return [];
  const enforceReadiness = getSetting("warp_readiness_enforce", "false") === "true";
  const shadowProtonIds = providerId === "opencode" && getOpencodeHybridMode() === "shadow"
    ? new Set((getOpencodeHybridEgressConfig().probeEntries || []).filter((entry) => entry.adapter === "proton").map((entry) => entry.poolId))
    : new Set();
  const active = getProxyPools().filter((p) => Number(p.is_active) === 1
    && !shadowProtonIds.has(Number(p.id))
    && (!scopedIds || (scopedIds.includes(Number(p.id)) && !validateProxyAddress(p.url)))
    && (!enforceReadiness || providerId !== "opencode" || !String(p.name || "").startsWith("warp-node-") || isWarpPoolReady(p)));
  if (active.length === 0) return [];

  let rawOrdered;
  if (strategy === "random") {
    rawOrdered = [...active];
    for (let i = rawOrdered.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rawOrdered[i], rawOrdered[j]] = [rawOrdered[j], rawOrdered[i]];
    }
  } else {
    const cursor = proxyRotationCursors.get(providerId) || 0;
    const start = cursor % active.length;
    rawOrdered = [];
    for (let i = 0; i < active.length; i++) {
      rawOrdered.push(active[(start + i) % active.length]);
    }
    proxyRotationCursors.set(providerId, (start + 1) % active.length);
  }

  // Prioritize active proxies that are NOT currently exhausted or in gate cooldown
  const isAvailable = (p) => {
    if (isProxyPoolExhausted(p.id) || isProxyPoolExhausted(p.url)) return false;
    if (providerId === "opencode" && getOpencodeGateState(p.url)) return false;
    return true;
  };
  const healthy = rawOrdered.filter(isAvailable);
  const coolingDown = rawOrdered.filter((p) => !isAvailable(p));
  const ordered = healthy.length > 0 ? [...healthy, ...coolingDown] : rawOrdered;

  const expanded = [];
  const hasGateway = ordered.some((p) => p.kind === "gateway");
  const cap = hasGateway ? PROXY_GATEWAY_MAX_ATTEMPTS : PROXY_ROTATION_MAX_ATTEMPTS;

  for (const p of ordered) {
    const budget = p.kind === "gateway" ? Math.min(PROXY_GATEWAY_MAX_ATTEMPTS, Math.max(1, Number(p.retry_budget) || 1)) : 1;
    for (let k = 0; k < budget && expanded.length < cap; k++) {
      expanded.push({
        id: p.id,
        name: p.name,
        url: p.url,
        kind: p.kind || "single",
        retry_budget: Number(p.retry_budget) || 1,
        rotate_url: p.rotate_url || null,
        [ROT_FIELD]: p[ROT_FIELD] || null,
      });
    }
    if (expanded.length >= cap) break;
  }
  return expanded;
}

export function planProxyRotation(providerId, strategy) {
  return planProxyRotationEntries(providerId, strategy).map((entry) => entry.url);
}
