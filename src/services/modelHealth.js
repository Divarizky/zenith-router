/**
 * Evaluasi Live Pre-test Tri-State untuk model (active | quota | dead).
 *
 * Mengadopsi arsitektur dari 9router-auto-free untuk mengevaluasi kesehatan
 * model secara terukur sebelum atau saat digunakan:
 * - active: model responsif, prompt micro-test sukses, latensi tercatat.
 * - quota: model mengalami rate limit (HTTP 429) atau kuota habis, diparkir
 *   dengan penanda latensi sentinel (QUOTA_LATENCY_SENTINEL = 999998).
 * - dead: model mengembalikan HTTP 404, deprecated, atau 401 token invalid/unauthorized.
 */

/**
 * Latensi sentinel untuk menandai model yang terkena rate limit / kuota habis
 * dan diparkir di urutan terbawah tanpa dihapus permanen.
 */
export const QUOTA_LATENCY_SENTINEL = 999998;

const QUOTA_PATTERN =
  /rate[_\s-]?limit|quota|resource_exhausted|too many requests|insufficient_quota|credits?[_\s-]?(?:exhausted|limit)|tokens?[_\s-]?(?:exhausted|limit)|limit[_\s-]?reached|overloaded|exceeded your current quota|capacity/i;

const DEAD_PATTERN =
  /model[_\s-]?not[_\s-]?found|not[_\s-]?found|deprecated|decommissioned|does not exist|invalid[_\s-]?api[_\s-]?key|unauthorized|invalid[_\s-]?token|account[_\s-]?suspended|access[_\s-]?denied|revoked/i;

/**
 * Memeriksa apakah nilai latensi merupakan penanda status quota parkir.
 *
 * @param {number|unknown} latencyMs
 * @returns {boolean}
 */
export function isParkedLatency(latencyMs) {
  return typeof latencyMs === "number" && latencyMs >= QUOTA_LATENCY_SENTINEL;
}

/**
 * Mengklasifikasikan hasil pengujian model ke dalam status tri-state:
 * 'active' | 'quota' | 'dead'.
 *
 * @param {object} [result]
 * @param {number} [result.status] HTTP status code
 * @param {string|Error|object} [result.error] Pesan error atau objek error
 * @param {boolean} [result.ok] Apakah pemanggilan sukses
 * @param {number} [result.latencyMs] Latensi yang terukur
 * @returns {'active' | 'quota' | 'dead'}
 */
export function classifyTestResult({ status, error, ok, latencyMs } = {}) {
  // 1. Jika latensi sudah merupakan nilai sentinel parkir
  if (isParkedLatency(latencyMs)) {
    return "quota";
  }

  const statusCode = typeof status === "number" ? status : Number.parseInt(status, 10);
  const errText = typeof error === "string"
    ? error
    : (error?.message || error?.error?.message || error?.details || "");

  // 2. HTTP 429 atau pesan mengindikasikan rate limit / kuota habis
  if (statusCode === 429 || QUOTA_PATTERN.test(errText)) {
    return "quota";
  }

  // 3. HTTP 404 (model tidak ditemukan / deprecated)
  if (statusCode === 404) {
    return "dead";
  }

  // 4. HTTP 401 (token tidak valid / unauthorized)
  if (statusCode === 401) {
    return "dead";
  }

  // 5. Pesan error mengindikasikan model mati / deprecated / token revoked
  if (DEAD_PATTERN.test(errText)) {
    return "dead";
  }

  // 6. Jika pemanggilan sukses tanpa error fatal
  if ((ok === true || (statusCode >= 200 && statusCode < 300)) && !errText) {
    return "active";
  }

  // 7. Jika ok bernilai true dan tidak ada pesan quota/dead
  if (ok === true) {
    return "active";
  }

  // 8. Default fallback jika terjadi error lain (HTTP 4xx/5xx selain 429, network failure, dll)
  return "dead";
}

/**
 * Mengeksekusi prompt mini (1 token / ping) melalui router lokal untuk mengukur
 * latensi dan status kesehatan model secara terukur.
 *
 * @param {string} fullModelId - ID model lengkap, misal 'openai/gpt-4o'
 * @param {object} [options]
 * @param {string} [options.baseUrl] - Base URL router (default http://127.0.0.1:20120)
 * @param {number} [options.port] - Port router (default 20120 atau process.env.PORT)
 * @param {string} [options.apiKey] - API key untuk otentikasi ke router lokal jika dibutuhkan
 * @param {number} [options.timeoutMs] - Batas waktu pengujian dalam milidetik (default 10000)
 * @param {Function} [options.fetch] - Custom fetch implementation (untuk mocking/testing)
 * @param {object} [options.headers] - Header tambahan
 * @param {object} [options.payload] - Payload tambahan untuk request body
 * @returns {Promise<{
 *   status: 'active' | 'quota' | 'dead',
 *   ok: boolean,
 *   latencyMs: number,
 *   httpStatus: number | null,
 *   error: string | null,
 *   rawLatencyMs: number
 * }>}
 */
export async function testModelHealth(fullModelId, options = {}) {
  if (!fullModelId || typeof fullModelId !== "string") {
    return {
      status: "dead",
      ok: false,
      latencyMs: 0,
      httpStatus: 400,
      error: "Model ID wajib diisi",
      rawLatencyMs: 0,
    };
  }

  const fetchFn = options.fetch || globalThis.fetch;
  const port = options.port || process.env.PORT || 20120;
  const baseUrl = options.baseUrl || `http://127.0.0.1:${port}`;
  const url = options.url || `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 10000;

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (options.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`;
  }

  const body = {
    model: fullModelId,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
    ...(options.payload || {}),
  };

  const start = Date.now();
  let rawLatencyMs = 0;

  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    rawLatencyMs = Math.max(1, Date.now() - start);

    let parsedBody = null;
    let errorMsg = null;

    try {
      parsedBody = await res.json();
      if (parsedBody?.error) {
        errorMsg = parsedBody.error?.message || String(parsedBody.error);
      }
    } catch {
      // Body bukan JSON
    }

    if (!res.ok && !errorMsg) {
      errorMsg = `HTTP ${res.status}`;
    }

    const isOk = res.ok && !parsedBody?.error;
    const verdict = classifyTestResult({
      status: res.status,
      ok: isOk,
      error: errorMsg,
      latencyMs: rawLatencyMs,
    });

    const latencyMs = verdict === "quota" ? QUOTA_LATENCY_SENTINEL : rawLatencyMs;

    return {
      status: verdict,
      ok: verdict === "active",
      latencyMs,
      httpStatus: res.status,
      error: errorMsg || null,
      rawLatencyMs,
    };
  } catch (err) {
    rawLatencyMs = Math.max(1, Date.now() - start);
    const isTimeout =
      err?.name === "TimeoutError" || String(err?.message || "").toLowerCase().includes("timeout");
    const errorMsg = isTimeout ? "Request timeout" : (err?.message || "Network error");

    const verdict = classifyTestResult({
      status: isTimeout ? 408 : 0,
      ok: false,
      error: errorMsg,
      latencyMs: rawLatencyMs,
    });

    return {
      status: verdict,
      ok: false,
      latencyMs: verdict === "quota" ? QUOTA_LATENCY_SENTINEL : rawLatencyMs,
      httpStatus: isTimeout ? 408 : null,
      error: errorMsg,
      rawLatencyMs,
    };
  }
}
