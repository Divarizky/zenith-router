import {
  addProxyPool,
  getProxyPools,
  getProxyPoolById,
  countProxyAccounts,
  updateProxyPool,
  removeProxyPool,
} from "../db/index.js";
import { proxyFetch } from "../executors/proxy.js";
import { getSetting, setSetting } from "./settings.js";

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

/**
 * Store a new proxy. Throws an Error with a user-facing reason when the name
 * or address is rejected; the stored list is left untouched in that case.
 */
export function createProxyPool({ name, url }) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) throw new Error("Nama proxy wajib diisi.");
  const trimmedUrl = String(url || "").trim();
  const addressError = validateProxyAddress(trimmedUrl);
  if (addressError) throw new Error(addressError);
  if (getProxyPools().some((p) => p.name === trimmedName)) {
    throw new Error(`Nama proxy "${trimmedName}" sudah dipakai.`);
  }
  return addProxyPool({ name: trimmedName, url: trimmedUrl });
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
export function updateProxyPoolEntry({ id, name, url, is_active }) {
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
 * All proxies with display-ready fields: masked address and account count.
 */
export function listProxyPools() {
  return getProxyPools().map((p) => ({
    ...p,
    maskedUrl: maskProxyUrl(p.url),
    accountCount: countProxyAccounts(p.id),
  }));
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
export function planProxyRotation(providerId, strategy) {
  if (strategy !== "round_robin" && strategy !== "random") return [];
  const active = getProxyPools().filter((p) => Number(p.is_active) === 1);
  if (active.length === 0) return [];
  const take = Math.min(PROXY_ROTATION_MAX_ATTEMPTS, active.length);
  if (strategy === "random") {
    const order = active.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order.slice(0, take).map((i) => active[i].url);
  }
  const cursor = proxyRotationCursors.get(providerId) || 0;
  const start = cursor % active.length;
  const picks = [];
  for (let i = 0; i < take; i++) picks.push(active[(start + i) % active.length].url);
  proxyRotationCursors.set(providerId, (start + 1) % active.length);
  return picks;
}
