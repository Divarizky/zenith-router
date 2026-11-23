import { proxyFetch } from "../executors/proxy.js";
import { getProxyPoolById } from "../db/index.js";
import { listProxyPools } from "./proxyPools.js";
import { getSetting, setSetting } from "./settings.js";

// Hasil probe dianggap valid selama jendela ini. Lewat dari TTL atau config
// berubah = data kedaluwarsa dan harus dites ulang.
export const EGRESS_PROBE_TTL_MS = 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;
const RESULT_KEY = "proxy_egress_probe_results";
const URL_KEY = "proxy_egress_probe_url";

/** Endpoint probe harus HTTPS. Tanpa setting, probe tidak berjalan. */
export function getEgressProbeUrl() {
  return String(getSetting(URL_KEY, "") || "").trim();
}

export function validateEgressProbeUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "URL probe wajib diisi.";
  if (/\s/.test(value)) return "URL probe tidak boleh memuat spasi.";
  let parsed;
  try { parsed = new URL(value); } catch { return "URL probe tidak valid."; }
  if (parsed.protocol !== "https:") return "URL probe harus https://.";
  if (parsed.username || parsed.password) return "URL probe tidak boleh memuat kredensial.";
  return null;
}

export function setEgressProbeUrl(raw) {
  const error = validateEgressProbeUrl(raw);
  if (error) throw new Error(error);
  setSetting(URL_KEY, String(raw).trim());
}

/**
 * Fingerprint config pool. Mengganti URL proxy atau kind mengubah sidik
 * jari sehingga hasil lama tidak lagi dianggap berlaku.
 */
export function poolEgressFingerprint(pool) {
  return `${pool.url}|${pool.kind || "single"}|${getEgressProbeUrl()}`;
}

function readResults() {
  try {
    const parsed = JSON.parse(getSetting(RESULT_KEY, "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function writeResults(results) {
  setSetting(RESULT_KEY, JSON.stringify(results));
}

/** Ambil hasil probe pool bila masih berlaku, selain itu null. */
export function getPoolEgressIp(poolId, now = Date.now()) {
  const pool = getProxyPoolById(poolId);
  if (!pool) return null;
  const entry = readResults()[String(pool.id)];
  if (!entry) return null;
  const stale =
    entry.fingerprint !== poolEgressFingerprint(pool) ||
    now - entry.checkedAt > EGRESS_PROBE_TTL_MS;
  return { ...entry, stale };
}

/**
 * Probe IP keluar satu pool lewat transport pool yang sama dengan trafik.
 * Hanya dipanggil dari aksi operator. Tidak dipanggil dari jalur request.
 * Tidak mengirim kredensial OpenCode; header yang dikirim hanya User-Agent.
 */
export async function probePoolEgressIp(poolId, options = {}) {
  const pool = getProxyPoolById(poolId);
  if (!pool) throw new Error("Proxy tidak ditemukan.");
  const probeUrl = getEgressProbeUrl();
  const urlError = validateEgressProbeUrl(probeUrl);
  if (urlError) throw new Error(urlError);
  if (!pool.is_active) throw new Error("Proxy nonaktif, tidak diprobe.");

  const now = options.now ?? Date.now();
  let ip = null;
  let error = null;
  try {
    const res = await proxyFetch(
      probeUrl,
      {
        method: "GET",
        headers: { "user-agent": "zenith-egress-probe/1" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        ...(options.tlsCa ? { tlsCa: options.tlsCa } : {}),
      },
      pool.url
    );
    const text = (await res.text()).trim();
    ip = parseIpFromBody(text);
    if (!ip) error = "Respons probe tidak memuat IP yang valid.";
  } catch (err) {
    error = String(err?.message || err);
  }

  const results = readResults();
  results[String(pool.id)] = {
    ip,
    error,
    checkedAt: now,
    fingerprint: poolEgressFingerprint(pool),
  };
  writeResults(results);
  return { poolId: pool.id, ip, error, checkedAt: now };
}

/**
 * Terima teks IP polos atau JSON { ip } dari endpoint probe. Hanya IPv4 atau
 * IPv6 yang dianggap valid, supaya HTML atau pesan error tidak masuk tabel.
 */
export function parseIpFromBody(text) {
  let candidate = text;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") candidate = String(parsed.ip ?? "");
  } catch { /* bukan JSON, pakai teks mentah */ }
  candidate = String(candidate).trim();
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = candidate.match(ipv4);
  if (m) return m.slice(1).every((n) => Number(n) <= 255) ? candidate : null;
  if (/^[0-9a-f:]+$/i.test(candidate) && candidate.includes(":")) return candidate.toLowerCase();
  return null;
}

/**
 * Pool yang berbagi IP keluar yang sama (diagnosis, bukan blacklist).
 * Hanya hasil yang masih berlaku yang dihitung.
 */
export function findDuplicateEgressIps(now = Date.now()) {
  const byIp = new Map();
  for (const pool of listProxyPools()) {
    const entry = getPoolEgressIp(pool.id, now);
    if (!entry || entry.stale || !entry.ip) continue;
    if (!byIp.has(entry.ip)) byIp.set(entry.ip, []);
    byIp.get(entry.ip).push(pool.id);
  }
  return [...byIp.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([ip, poolIds]) => ({ ip, poolIds }));
}
