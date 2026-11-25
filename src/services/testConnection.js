import { getProvider } from "../providers/index.js";
import { listSyncedModels } from "./modelOverrides.js";
import { getConnections } from "../db/index.js";
import { applyConnectionAuth } from "./auth.js";
import { requireResolvedProxy } from "./proxyPools.js";
import { fetchLiveQuota, hasQuotaFetcher } from "./quota/index.js";
import { getImporter, fetchProviderModels } from "./modelImport.js";
import { proxyFetch } from "../executors/proxy.js";
import { getExecutor, BaseExecutor } from "../executors/base.js";

const TEST_TIMEOUT_MS = 10000;

/**
 * Test connectivity for a provider or a specific account.
 *
 * @param {string} providerId
 * @param {object} [options]
 * @param {object} [options.connection] Specific connection to test
 * @returns {Promise<{ ok: boolean, error?: string, details?: string }>}
 */
export async function testConnection(providerId, options = {}) {
  const provider = getProvider(providerId);
  if (!provider) {
    return { ok: false, error: `Provider "${providerId}" tidak ditemukan.` };
  }

  let connection = options.connection || null;
  if (!connection && !provider.noAuth) {
    const active = getConnections(provider.id).filter((c) => c.is_active === 1);
    connection = active[0] || null;
    if (!connection) {
      return {
        ok: false,
        error: "Belum ada akun aktif. Tambahkan atau aktifkan akun terlebih dahulu.",
      };
    }
  }

  try {
    // 2. Provider yang memiliki kuota live (Codex, Claude, GitHub, Kiro, Antigravity, GLM, OpenRouter, dll)
    if (hasQuotaFetcher(provider.id) && connection) {
      const quota = await fetchLiveQuota(connection);
      if (quota) {
        return { ok: true, details: "Koneksi dan autentikasi berhasil." };
      }
    }

    // 3. Provider Freebuff: uji perolehan instance session
    if (provider.id === "freebuff" && connection) {
      const creds = connection.credentials || {};
      const token = creds.api_key || creds.token || creds.access_token;
      if (!token) return { ok: false, error: "Kredensial token Freebuff tidak ditemukan." };
      const proxyUrl = requireResolvedProxy(connection);
      const headers = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-freebuff-model": "deepseek/deepseek-v4-flash",
      };
      const res = await (proxyUrl ? proxyFetch : fetch)(
        "https://www.codebuff.com/api/v1/freebuff/session",
        {
          method: "POST",
          headers,
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        },
        proxyUrl
      );
      if (res.ok) {
        return { ok: true, details: "Sesi Freebuff valid." };
      }
      const status = res.status;
      if (status === 429) {
        return { ok: true, details: "Terhubung ke Freebuff (kuota sesi harian habis)." };
      }
      return { ok: false, error: `HTTP ${status}: Gagal menguji sesi Freebuff` };
    }

    // 3b. Nous: GET /v1/models bersifat publik, jadi sukses di sana bukan bukti
    // akses. Uji dengan chat minimal ke model gratis.
    if (provider.id === "nous") return await probeNousChat(provider, connection);

    // 4. Provider yang memiliki importer model (OpenAI-compatible list, Ollama, OVHcloud, OpenCode, dll)
    const importer = getImporter(provider.id);
    if (importer) {
      if (connection) {
        // Uji dengan akun yang diminta
        const headers = {
          Accept: "application/json",
          ...(importer.useTransportHeaders ? provider.transport?.headers : {}),
          ...importer.headers,
          ...(connection.auth_type === "oauth" ? importer.oauthHeaders : {}),
        };
        delete headers["Content-Type"];
        applyConnectionAuth(headers, connection);

        const listExecutor = importer.rawTransport ? new BaseExecutor() : getExecutor(provider.id);
        const res = await listExecutor.execute({
          url: importer.url,
          method: "GET",
          headers,
          timeoutMs: TEST_TIMEOUT_MS,
          proxyUrl: requireResolvedProxy(connection),
        });

        if (res.ok) {
          return { ok: true, details: "Endpoint daftar model merespons sukses." };
        }
        return { ok: false, error: `HTTP ${res.status}` };
      }

      // Jika provider noAuth tanpa akun
      const fetchResult = await fetchProviderModels(provider);
      if (fetchResult.ok) {
        return { ok: true, details: "Endpoint publik merespons sukses." };
      }
      return { ok: false, error: fetchResult.code === "upstream_error" ? `HTTP ${fetchResult.status}` : fetchResult.code };
    }

    // 5. Fallback umum: uji endpoint baseUrl jika ada
    let testUrl = provider.transport?.baseUrl || (provider.transport?.baseUrls && provider.transport.baseUrls[0]);
    if (!testUrl) {
      return { ok: false, error: "Provider tidak memiliki endpoint untuk diuji." };
    }

    // Normalisasi url: pangkas /chat/completions atau /messages ke endpoint /v1/models bila memungkinkan
    try {
      const parsed = new URL(testUrl);
      if (parsed.pathname.endsWith("/chat/completions")) {
        parsed.pathname = parsed.pathname.replace(/\/chat\/completions$/, "/models");
        testUrl = parsed.toString();
      }
    } catch {}

    const headers = { Accept: "application/json" };
    if (connection) {
      applyConnectionAuth(headers, connection);
    }

    const executor = getExecutor(provider.id);
    const res = await executor.execute({
      url: testUrl,
      method: "GET",
      headers,
      timeoutMs: TEST_TIMEOUT_MS,
      proxyUrl: connection ? requireResolvedProxy(connection) : null,
    });

    if (res.ok || res.status === 400 || res.status === 404) {
      // 400/404 dari origin upstream menandakan server terjangkau secara jaringan
      return { ok: true, details: `Server upstream terjangkau (HTTP ${res.status}).` };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.message || "koneksi gagal" };
  }
}

const NOUS_PROBE_BODY = { messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false };

/** Minimal chat probe against a free Nous model; maps status codes to honest outcomes. */
async function probeNousChat(provider, connection) {
  let model = listSyncedModels(provider.id)[0]?.model_id;
  if (!model) {
    const fetched = await fetchProviderModels(provider);
    model = fetched.ok ? fetched.models.find((m) => m.isFree)?.id : null;
  }
  if (!model) return { ok: false, error: "Tidak ada model gratis Nous untuk diuji." };

  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  applyConnectionAuth(headers, connection);
  const res = await getExecutor(provider.id).execute({
    url: provider.transport.baseUrl,
    method: "POST",
    headers,
    body: JSON.stringify({ ...NOUS_PROBE_BODY, model }),
    timeoutMs: TEST_TIMEOUT_MS,
    proxyUrl: requireResolvedProxy(connection),
  });
  if (res.ok) return { ok: true, details: `Chat ke model gratis ${model} berhasil.` };
  switch (res.status) {
    case 401:
    case 403:
      return { ok: false, error: `HTTP ${res.status}: API key ditolak atau tidak punya akses.` };
    case 402:
      return { ok: false, error: "HTTP 402: kredit/pembayaran diperlukan." };
    case 404:
      return { ok: false, error: `HTTP 404: model ${model} tidak ditemukan.` };
    case 429:
      return {
        ok: false,
        error: `HTTP 429: API key valid, tetapi model uji '${model}' sedang terkena rate limit. Coba lagi setelah Retry-After.`,
      };
    default:
      return { ok: false, error: `HTTP ${res.status}` };
  }
}
