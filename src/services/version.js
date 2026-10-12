import pkg from "../../package.json" with { type: "json" };

const RELEASES_URL = "https://api.github.com/repos/Divarizky/zenith-router/releases/latest";
const CACHE_TTL_MS = 60 * 60 * 1000;

let customFetcher = null;
let cache = { value: null, fetchedAt: 0 };

/** Ganti pemanggilan GitHub dengan stub di test; memori cache ikut dikosongkan. */
export function setCustomVersionFetcher(fn) {
  customFetcher = fn;
  resetVersionCache();
}

export function resetVersionCache() {
  cache = { value: null, fetchedAt: 0 };
}

/**
 * Bandingkan dua versi sebagai angka per bagian, bukan teks: "10" lebih besar
 * dari "9" meski hurufnya kebalikan. Tanda "v" di depan diabaikan.
 */
export function compareVersions(a, b) {
  const pa = String(a ?? "")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b ?? "")
    .replace(/^v/i, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function fetchLatestRelease() {
  if (customFetcher) return customFetcher();
  const res = await fetch(RELEASES_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GitHub merespons ${res.status}`);
  return res.json();
}

function buildInfo(current, release) {
  const tag = String(release.tag_name);
  const latest = tag.replace(/^v/i, "");
  return {
    current,
    latest,
    tag,
    hasUpdate: compareVersions(latest, current) > 0,
    url: release.html_url || null,
    publishedAt: release.published_at || null,
  };
}

/**
 * Versi sekarang vs rilis terbaru di GitHub. Hasil sukses di-cache satu jam;
 * kegagalan jaringan maupun payload aneh melemah menjadi "tidak ada pembaruan"
 * supaya dashboard tidak pernah gagal hanya karena GitHub tidak terjangkau.
 */
export async function getVersionInfo() {
  const current = pkg.version;
  try {
    if (cache.value && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      return buildInfo(current, cache.value);
    }
    const release = await fetchLatestRelease();
    if (!release || typeof release.tag_name !== "string") {
      throw new Error("payload rilis tidak valid");
    }
    cache = { value: release, fetchedAt: Date.now() };
    return buildInfo(current, release);
  } catch {
    return { current, latest: null, hasUpdate: false, url: null, publishedAt: null };
  }
}

export async function handleGetVersion(c) {
  return c.json(await getVersionInfo());
}
