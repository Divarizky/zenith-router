import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { oauthFetch } from "../oauth/providers.js";
import { requireResolvedProxy } from "../proxyPools.js";

// Endpoint kuota PaaS (API key coding plan). Endpoint lama /api/paas/v4/user/quota
// sudah mati (HTTP 404); monitor/usage/quota/limit adalah endpoint pemakaian yang
// dipakai konsol Z.ai dan menerima API key maupun token OAuth.
const GLM_PAAS_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

// Endpoint kuota ZCode Start-Plan (desktop), diautentikasi dengan plan_token JWT.
const GLM_PLAN_BALANCE_URL = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
// Atribut klien yang dikirim ZCode desktop asli. Endpoint billing menolak request
// tanpa query app_version dan header X-Device-Mid (HTTP 400 code 3001 "parameter error").
// Device Mid dibaca dari instalasi ZCode desktop (~/.zcode/v2/telemetry-state.json).
const ZCODE_DESKTOP_APP_VERSION = "3.17.2";

const PLAN_QUOTA_HEADERS = {
  "http-referer": "https://zcode.z.ai",
  "x-title": "Z Code@electron",
  "user-agent": `ZCode/${ZCODE_DESKTOP_APP_VERSION}`,
};

/**
 * URL endpoint billing balance dengan query app_version — persis seperti
 * buildZaiStartPlanBalanceUrl di ZCode desktop: tanpa param ini server
 * membalas 400 code 3001 "parameter error".
 */
function buildZcodePlanBalanceUrl() {
  const url = new URL(GLM_PLAN_BALANCE_URL);
  url.searchParams.set("app_version", ZCODE_DESKTOP_APP_VERSION);
  return url.toString();
}

/**
 * Baca Device Mid instalasi ZCode desktop. Nilai ini UUID per-instalasi yang
 * dibuat ZCode sendiri; endpoint billing menolak request tanpa header X-Device-Mid.
 * Lokasi kandidat mengikuti struktur data ZCode (v2 = layout terbaru).
 */
export function readZcodeDeviceMid(homeDir = os.homedir()) {
  const home = homeDir;
  for (const rel of [".zcode/v2/telemetry-state.json", ".zcode/cli/telemetry-state.json"]) {
    try {
      const raw = fs.readFileSync(path.join(home, rel), "utf8");
      const mid = JSON.parse(raw)?.deviceMid?.trim();
      if (mid) return mid;
    } catch {}
  }
  return null;
}

/**
 * Parse `data.limits` dari endpoint kuota PaaS Z.ai.
 * unit 3 = jendela 5 jam (session), unit 6 = jendela 7 hari (mingguan).
 */
export function parseGlmLimits(json) {
  const data = json?.data || json || {};
  const limits = Array.isArray(data.limits) ? data.limits : [];

  let sessionLimit = null;
  let weeklyLimit = null;
  let isExhausted = false;

  for (const l of limits) {
    const used = Number(l.percentage) || 0;
    if (used >= 100) isExhausted = true;
    if (l.unit === 3) sessionLimit = { used_percent: used, reset_time: l.nextResetTime };
    if (l.unit === 6) weeklyLimit = { used_percent: used, reset_time: l.nextResetTime };
  }

  return { sessionLimit, weeklyLimit, isExhausted };
}

/**
 * Kuota PaaS (API key): jendela 5 jam dan mingguan dalam persen.
 * Dilempar sebagai error agar syncProviderQuota mencatat pesan yang jelas.
 */
export async function fetchGlmPaasQuota(connection) {
  const apiKey = connection.credentials?.api_key || connection.credentials?.access_token;
  if (!apiKey) return null;

  const res = await oauthFetch(
    GLM_PAAS_QUOTA_URL,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
    { proxyUrl: requireResolvedProxy(connection) },
  );
  if (!res.ok) {
    throw new Error(`GLM quota API returned HTTP ${res.status}`);
  }

  const { sessionLimit, weeklyLimit, isExhausted } = parseGlmLimits(await res.json());

  return {
    provider: "glm",
    session_quota: sessionLimit,
    weekly_quota: weeklyLimit,
    is_exhausted: isExhausted,
    unit: "coding_plan",
  };
}

/**
 * Parse respons `billing/balance` Start-Plan: `{ code, data: { balances: [...] } }`.
 * Setiap saldo adalah jatah harian per model (remaining_units / total_units).
 */
export function parseGlmPlanBalance(json) {
  const data = json?.data || {};
  const balances = Array.isArray(data.balances) ? data.balances : [];
  const planQuota = [];
  let total = 0;
  let remaining = 0;

  for (const b of balances) {
    const totalUnits = Number(b.total_units);
    const remainingUnits = Number(b.remaining_units);
    const hasUnits = Number.isFinite(totalUnits) && totalUnits >= 0 && Number.isFinite(remainingUnits);
    const pct = hasUnits && totalUnits > 0 ? (remainingUnits / totalUnits) * 100 : null;
    if (hasUnits) {
      total += totalUnits;
      remaining += remainingUnits;
    }
    planQuota.push({
      name: b.show_name || "Daily Model Quota",
      remaining_units: hasUnits ? remainingUnits : null,
      total_units: hasUnits ? totalUnits : null,
      remaining_percent: pct != null ? Math.max(0, Math.min(100, pct)) : null,
      unit_type: b.unit_type || "tokens",
    });
  }

  return {
    balances: planQuota,
    remaining: total > 0 ? remaining : null,
    total: total > 0 ? total : null,
  };
}

/**
 * Kuota ZCode Start-Plan lewat plan_token. 401/403 berarti token plan mati:
 * dikembalikan sebagai error (bukan throw) agar chat tetap jalan dan UI
 * menandai koneksi perlu login ulang.
 * HTTP 400 dengan kode 3001 "parameter error" juga non-fatal: endpoint billing
 * menolak request kita karena parameter wajib yang dikirim ZCode desktop asli
 * belum diketahui. Melempar exception di sini membuat seluruh sync kuota glm
 * gagal (kuota PaaS ikut hilang) dan mengspam console log tiap siklus.
 */
// Backoff per koneksi: jangan mengulang endpoint bermasalah tiap siklus.
// Key = connection id, value = ms timestamp percobaan berikutnya yang boleh jalan.
const planQuotaRetryAt = new Map();
const PLAN_QUOTA_RETRY_MS = 30 * 60_000; // 30 menit

export function planQuotaBackoffActive(connection) {
  const next = planQuotaRetryAt.get(connection?.id);
  return Number.isFinite(next) && Date.now() < next;
}

export async function fetchGlmPlanQuota(connection) {
  const planToken = connection?.credentials?.plan_token;
  if (!planToken) return null;

  if (planQuotaBackoffActive(connection)) {
    return {
      provider: "glm",
      unit: "coding_plan",
      is_exhausted: false,
      error: "Kuota Start-Plan sementara tidak disinkron (endpoint billing menolak request, coba lagi nanti).",
      skipped: true,
    };
  }

  const deviceMid = readZcodeDeviceMid();

  const res = await oauthFetch(
    buildZcodePlanBalanceUrl(),
    {
      headers: {
        ...PLAN_QUOTA_HEADERS,
        "X-ZCode-App-Version": ZCODE_DESKTOP_APP_VERSION,
        "X-Platform": `linux-${os.arch()}`,
        "X-Os-Category": "linux",
        "X-Client-Language": "unknown",
        "X-Client-Timezone": "unknown",
        ...deviceMid ? { "X-Device-Mid": deviceMid } : {},
        Authorization: `Bearer ${planToken}`,
        Accept: "application/json",
      },
    },
    { proxyUrl: requireResolvedProxy(connection) },
  );

  if (res.status === 401 || res.status === 403) {
    return {
      provider: "glm",
      unit: "coding_plan",
      is_exhausted: false,
      error: `Kuota Start-Plan gagal (HTTP ${res.status}): plan_token ditolak, login ulang ZCode.`,
    };
  }
  if (!res.ok) {
    // Endpoint billing menolak request (400/3001 parameter error, dst.).
    // Catat sebagai error non-fatal + backoff 30 menit, jangan throw:
    // throw di sini menggagalkan seluruh fetchGlmQuota dan mengspam console.
    planQuotaRetryAt.set(connection?.id, Date.now() + PLAN_QUOTA_RETRY_MS);
    let detail = "";
    try {
      const body = await res.json();
      if (body?.msg) detail = ` (${body.msg})`;
    } catch {}
    return {
      provider: "glm",
      unit: "coding_plan",
      is_exhausted: false,
      error: `Kuota Start-Plan tidak tersinkron (HTTP ${res.status}${detail}). Sync diulang otomatis 30 menit lagi.`,
    };
  }

  const plan = parseGlmPlanBalance(await res.json());

  return {
    provider: "glm",
    plan_quota: plan.balances.length > 0 ? plan.balances : null,
    remaining: plan.remaining,
    total: plan.total,
    unit: "coding_plan",
    is_exhausted: false,
  };
}

/**
 * Fetch live quota for GLM (Z.ai).
 * Tanpa plan_token: hanya kuota PaaS seperti sebelumnya.
 * Dengan plan_token: kuota PaaS digabung kuota Start-Plan; kalau PaaS gagal
 * (mis. API key tidak punya coding plan) kuota Start-Plan tetap tampil.
 */
export async function fetchGlmQuota(connection) {
  const planToken = connection?.credentials?.plan_token;

  let paas = null;
  let paasError = null;
  try {
    paas = await fetchGlmPaasQuota(connection);
  } catch (err) {
    paasError = err;
  }

  if (!planToken) {
    if (paasError) throw paasError;
    return paas;
  }

  const plan = await fetchGlmPlanQuota(connection);

  if (!paas) {
    if (paasError) return { ...plan, paas_error: paasError.message };
    return plan;
  }
  const merged = { ...paas, ...plan, provider: "glm", unit: "coding_plan" };
  if (plan?.error) merged.error = plan.error;
  else delete merged.error;
  if (paasError) merged.paas_error = paasError.message;
  return merged;
}
