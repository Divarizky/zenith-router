import {
  getConnections,
  addConnection,
  deleteConnection,
  moveConnection,
  getConnectionById,
  updateConnection,
  getProxyPoolById,
  createCustomProvider,
  deleteCustomProvider,
} from "../../db/index.js";
import { getAllProviders, getProvider, getProviderModels } from "../../providers/index.js";
import { isConnectionFullyCooledDown } from "../../services/auth.js";
import { getProviderTraffic, resolveProviderQueueTimeout } from "../../services/trafficGuard.js";
import { checkSessionHealth, forgetSessionHealth, getSessionHealth } from "../../services/deepseekWeb/turns.js";
import { findSessionAccount } from "../../services/deepseekWeb/browserLogin.js";
import { isConnectionExhausted } from "../../services/quota.js";
import {
  listCustomModels,
  addCustomModel,
  deleteCustomModel,
  disableModel,
  disableModels,
  enableModel,
  enableModels,
  isModelDisabled,
  listImportedModels,
  clearImportedModels,
  deleteImportedModels,
  getModelSyncState,
} from "../../services/modelOverrides.js";
import { getImportModes, importProviderModels } from "../../services/modelImport.js";
import { resolveCapabilities } from "../../providers/capabilities.js";
import { syncFreeModels, refreshProviderCatalog, getSyncIntervalMs } from "../../services/modelSync.js";
import { syncManagedCombos } from "../../services/managedCombos.js";
import { getOAuthFlow } from "../../services/oauth/providers.js";
import { hasLocalImport } from "../../services/oauth/flows.js";
import { FREE_TIER_BUDGETS, FREE_TIER_TOS } from "../../config/freeTierCatalog.js";
import { testConnection } from "../../services/testConnection.js";
import { renderLayout, capabilityIcons } from "../layout.js";
import { renderCombosContent } from "./combos.js";
import {
  maskProxyUrl,
  listProxyPools,
  validateProxyAddress,
  getProxyRotationStrategy,
  setProxyRotationStrategy,
  getOpencodeEgressPolicy,
  getOpencodeScopedPoolIds,
} from "../../services/proxyPools.js";
import { escapeHtml } from "../html.js";
import { getSetting, setSetting, deleteSetting } from "../../services/settings.js";
import { getProviderIconPath } from "../assets.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

const SECTIONS = [
  { category: "custom", title: "Custom Providers", hint: "Endpoint kustom OpenAI / Anthropic-compatible (Local LLM, LM Studio, vLLM, self-hosted, dll)." },
  { category: "session", title: "Session Providers", hint: "Butuh token sesi dari browser yang sudah login, bukan API key. Pemakaian tidak resmi berisiko pembatasan atau pemblokiran akun." },
  { category: "oauth", title: "OAuth Providers", hint: "Login dengan akun langganan, lalu tempel token di sini." },
  { category: "free", title: "Free Tier Providers", hint: "Provider gratis. Yang berlabel Siap bisa dipakai tanpa akun." },
  { category: "apikey", title: "API Key Providers", hint: "Butuh API key dari vendor." },
];

function primaryAlias(p) {
  return Array.isArray(p.alias) ? p.alias[0] : p.alias || p.id;
}

/** Link to the vendor page where an API key is created (only providers that declare keyUrl). */
function keyLink(p, label = "Buat API key") {
  if (!p.keyUrl) return "";
  return `<a class="key-link" href="${escapeHtml(p.keyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} di ${escapeHtml(p.name)} &#8599;</a>`;
}

function providerUrl(id) {
  return `/dashboard/providers/${encodeURIComponent(id)}`;
}

/** Redirect target after a form action; only known provider ids are echoed back. */
function backTo(providerId) {
  const p = getProvider(providerId);
  return p ? providerUrl(p.id) : "/dashboard/providers";
}

const IMPORT_MODE_LABELS = {
  all: "Semua model",
  free: "Hanya model gratis",
};

/** Fixed notice texts keyed by the result code in the redirect query; never echo raw input. */
function importNotice(query = {}, provider = null) {
  if (query.notice === "custom_provider_added") return { ok: true, text: "Custom provider berhasil ditambahkan." };
  if (query.notice === "custom_provider_deleted") return { ok: true, text: "Custom provider berhasil dihapus." };
  if (query.notice === "custom_provider_invalid") return { ok: false, text: "Gagal: Nama, Prefix unik, dan Base URL wajib diisi dengan benar." };
  if (query.notice === "custom_provider_conflict") return { ok: false, text: "Gagal: Prefix sudah dipakai oleh provider lain." };
  if (query.notice === "test_ok") {
    return { ok: true, text: query.msg ? `Koneksi berhasil: ${escapeHtml(String(query.msg))}` : "Koneksi berhasil." };
  }
  if (query.notice === "test_fail") {
    return { ok: false, text: "Koneksi gagal: " + escapeHtml(String(query.msg || "tidak diketahui")) };
  }
  if (query.notice === "test_no_base") {
    return { ok: false, text: "Provider ini tidak memiliki endpoint untuk diuji." };
  }
  if (query.notice === "account_added") return { ok: true, text: "Akun berhasil ditambahkan." };
  if (query.notice === "account_exists") {
    return { ok: true, text: "Sesi ini sudah terdaftar sebagai akun. Tidak ada akun baru yang ditambahkan." };
  }
  if (query.notice === "account_deleted") return { ok: true, text: "Akun berhasil dihapus." };
  if (query.notice === "account_moved") return { ok: true, text: "Urutan akun diperbarui." };
  if (query.notice === "proxy_invalid") {
    return { ok: false, text: "Alamat proxy tidak valid. Gunakan skema http:// — aturan yang sama dengan daftar proxy." };
  }
  if (query.notice === "proxy_updated") return { ok: true, text: "Proxy akun diperbarui." };
  if (query.notice === "rotation_updated") return { ok: true, text: "Strategi rotasi proxy diperbarui." };
  if (query.notice === "concurrency_updated") return { ok: true, text: "Batas sesi paralel diperbarui." };
  if (query.notice === "concurrency_invalid") {
    return { ok: false, text: "Batas sesi paralel harus bilangan bulat 1 sampai 10. Kosongkan untuk memakai nilai bawaan." };
  }
  if (query.notice === "session_token_missing") {
    return { ok: false, text: "User token wajib diisi. Ambil nilai userToken dari localStorage chat.deepseek.com setelah login." };
  }
  if (query.notice === "session_ok") return { ok: true, text: "Sesi masih aktif." };
  if (query.notice === "session_expired") {
    return { ok: false, text: "Sesi kedaluwarsa. Ambil user token baru dari chat.deepseek.com, lalu isi di form Perbarui sesi." };
  }
  if (query.notice === "session_error") {
    return { ok: false, text: "Health check gagal menghubungi DeepSeek. Periksa koneksi atau proxy akun, lalu coba lagi." };
  }
  if (query.notice === "session_updated") return { ok: true, text: "Token sesi diperbarui." };
  if (query.notice === "rotation_invalid") {
    return { ok: false, text: "Strategi rotasi tidak dikenal. Pilih Tidak aktif, Bergiliran, atau Acak." };
  }
  if (query.notice === "import_failed") {
    return { ok: false, text: "Import gagal: login tidak ditemukan di aplikasi lokal. Login dulu di CLI/IDE provider ini." };
  }
  if (query.notice === "custom_added") return { ok: true, text: "Custom model berhasil ditambahkan." };
  if (query.notice === "custom_deleted") return { ok: true, text: "Custom model berhasil dihapus." };
  if (query.notice === "model_disabled") {
    const count = Number.parseInt(query.count, 10);
    return { ok: true, text: count > 1 ? `${count} model dinonaktifkan.` : "Model dinonaktifkan." };
  }
  if (query.notice === "model_enabled") {
    const count = Number.parseInt(query.count, 10);
    return { ok: true, text: count > 1 ? `${count} model diaktifkan kembali.` : "Model diaktifkan kembali." };
  }

  const count = Number.parseInt(query.count, 10) || 0;
  const retired = Number.parseInt(query.retired, 10) || 0;
  const status = Number.parseInt(query.status, 10);
  const httpSuffix = Number.isFinite(status) ? ` (HTTP ${status})` : "";
  switch (query.sync) {
    case "synced":
      return {
        ok: true,
        text: `Sinkron selesai: ${count} model gratis.${retired > 0 ? ` ${retired} model bawaan disembunyikan karena sudah tidak ada di provider.` : ""}`,
      };
    case "refreshed":
      return {
        ok: true,
        text: count > 0 ? `Katalog diperbarui: ${count} model bawaan sudah tidak ada di provider.` : "Katalog sudah sesuai dengan provider.",
      };
    case "empty":
      return { ok: false, text: `Sinkron gagal: provider tidak mengembalikan daftar model. ${provider?.freeModelSync ? "Daftar gratis" : "Katalog"} sebelumnya tetap dipakai.` };
    case "no_account":
      return { ok: false, text: "Sinkron gagal: butuh akun untuk mengambil daftar model." };
    case "upstream_error":
      return { ok: false, text: `Sinkron gagal${httpSuffix}. Daftar sebelumnya tetap dipakai.` };
    case "unsupported":
      return { ok: false, text: "Provider ini tidak disinkron otomatis." };
  }
  switch (query.import) {
    case "imported":
      return { ok: true, text: `${count} model berhasil di-import.` };
    case "cleared":
      return { ok: true, text: "Model hasil import dihapus." };
    case "deleted":
      return { ok: true, text: `${count} model hasil import dihapus.` };
    case "empty":
      return { ok: false, text: "Tidak ada model yang cocok dengan pilihan import." };
    case "no_account":
      return { ok: false, text: "Tambahkan akun dulu. Daftar model provider ini butuh kredensial." };
    case "upstream_error":
      return {
        ok: false,
        text: `Gagal mengambil daftar model dari provider${Number.isFinite(status) ? ` (HTTP ${status})` : ""}.`,
      };
    case "unsupported":
      return { ok: false, text: "Provider ini belum mendukung import model." };
    default:
      return null;
  }
}

const WIB_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** DD-MM-YYYY HH:mm WIB */
function formatWib(ms) {
  const parts = Object.fromEntries(WIB_FORMAT.formatToParts(new Date(Number(ms))).map((x) => [x.type, x.value]));
  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute} WIB`;
}

/**
 * Rebuild the managed combos after a manual catalog change. Probes stay off: the
 * user asked for the list to be re-read, not for every top model to be hit
 * upstream. A combo failure never blocks the redirect the dashboard waits for.
 */
async function rebuildManagedCombos() {
  try {
    await syncManagedCombos({ probe: false });
  } catch {}
}

/** One-line sync status for providers with freeModelSync or catalogRefresh. */
function syncSummary(p) {
  const state = getModelSyncState(p.id);
  const hours = getSyncIntervalMs() / 3_600_000;
  const subject = p.freeModelSync ? "Model gratis" : "Katalog model";
  const schedule =
    hours > 0
      ? `${subject} disinkron otomatis tiap ${hours} jam.`
      : "Sinkron otomatis dimatikan (ZENITH_MODEL_SYNC_INTERVAL_HOURS=0).";
  const fallback = p.freeModelSync === "replace" ? "memakai daftar bawaan" : "hanya daftar bawaan yang tampil";

  let status;
  if (!state?.last_success_at) status = `Belum pernah berhasil sinkron, ${fallback}.`;
  else if (p.freeModelSync) status = `Terakhir sinkron ${formatWib(state.last_success_at)} (${state.count} model).`;
  else status = `Terakhir sinkron ${formatWib(state.last_success_at)}.`;

  const error =
    state && state.ok === 0 && state.error
      ? ` <span style="color: var(--danger);">Percobaan terakhir ${formatWib(state.last_attempt_at)} gagal: ${escapeHtml(state.error)}</span>`
      : "";
  return `<p class="hint" style="margin-bottom: 0.75rem;">${schedule} ${status}${error}</p>`;
}

/** Unique model ids a provider exposes: built-in (static or synced), imported, custom. */
function countProviderModels(p, imported, custom) {
  const ids = new Set(getProviderModels(p).map((m) => m.id));
  for (const m of imported) ids.add(m.model_id);
  for (const m of custom) ids.add(m.model_id);
  return ids.size;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Free tier budget and ToS verdict from the Omni-style catalog, if any. */
function freeTierPills(providerId) {
  const pills = [];
  const budget = FREE_TIER_BUDGETS[providerId];
  if (budget) pills.push(`<span class="pill">${formatTokens(budget)} token/bulan</span>`);
  const tos = FREE_TIER_TOS[providerId];
  if (tos === "avoid") pills.push(`<span class="pill pill-warning">ToS: hindari</span>`);
  else if (tos) pills.push(`<span class="pill">ToS: ${escapeHtml(tos)}</span>`);
  return pills.join("");
}

function accountStats(list) {
  const healthy = list.filter(
    (c) => c.is_active === 1 && !isConnectionFullyCooledDown(c) && !isConnectionExhausted(c)
  ).length;
  return { total: list.length, healthy };
}

/** Up to two initials used as the fallback badge when an icon file is missing. */
function providerInitials(name) {
  const letters = String(name || "?")
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, "")[0] || "")
    .filter(Boolean)
    .slice(0, 2)
    .join("");
  return (letters || "?").toUpperCase();
}

/**
 * Brand icon (public/providers/<id>.png) with an initials badge behind it, so a
 * missing file degrades to text instead of a broken image.
 */
function providerIconHtml(p, size = 32) {
  const src = getProviderIconPath(p?.id);
  const initials = escapeHtml(providerInitials(p?.name || p?.id));
  const badge = `<span class="provider-icon-fb"${src ? " style=\"display:none\"" : ""}>${initials}</span>`;
  if (!src) return `<span class="provider-icon" style="--pi:${size}px">${badge}</span>`;
  const img = `<img src="${escapeHtml(src)}" alt="" width="${size}" height="${size}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />`;
  return `<span class="provider-icon" style="--pi:${size}px">${img}${badge}</span>`;
}

function statusPill(p, stats, accounts = []) {
  // A cached expired verdict outranks the account count: the card must not
  // advertise "connected" while every web token is dead.
  if (p.category === "session") {
    const health = accounts.map((account) => getSessionHealth(account)).filter(Boolean);
    if (health.some((entry) => entry.status === "expired")) {
      return `<span class="pill pill-danger">Sesi kedaluwarsa</span>`;
    }
  }
  if (p.noAuth) {
    const rot = getProxyRotationStrategy(p.id);
    if (rot !== "off") {
      const label = rot === "round_robin" ? "Rotasi" : "Acak";
      return `<span class="pill pill-success">Siap</span> <span class="pill pill-accent" title="Terhubung ke Proxy Pool (${label})"><span class="dot dot-success"></span>Proxy Pool</span>`;
    }
    const hasBound = accounts.some((a) => a.proxy_pool_id || a.proxy_url);
    if (hasBound) {
      return `<span class="pill pill-success">Siap</span> <span class="pill pill-info" title="Terikat ke Proxy">Proxy</span>`;
    }
    return `<span class="pill pill-success">Siap</span>`;
  }
  if (stats.healthy > 0) return `<span class="pill pill-success">${stats.healthy} Terhubung</span>`;
  if (stats.total > 0) return `<span class="pill pill-warning">${stats.total} tidak aktif</span>`;
  return `<span class="pill pill-muted">Belum ada akun</span>`;
}

/** Live slot usage for one account, as captured when the page was rendered. */
function slotCell(traffic) {
  if (!traffic) return `<span class="hint">—</span>`;
  const queue = traffic.queue > 0 ? ` <span class="pill pill-warning">+${traffic.queue}</span>` : "";
  return `<span class="pill${traffic.inFlight >= traffic.cap ? " pill-warning" : ""}">${traffic.inFlight}/${traffic.cap}</span>${queue}`;
}

/** Badge for a browser-session account, from the cached health verdict. */
function sessionHealthCell(connection) {
  const entry = getSessionHealth(connection);
  if (!entry) return `<span class="pill pill-info">Belum dicek</span>`;
  if (entry.status === "ok") return `<span class="pill pill-success">Sesi OK</span>`;
  if (entry.status === "expired") {
    return `<span class="pill pill-danger" title="${escapeHtml(entry.message || "")}">Sesi kedaluwarsa</span>`;
  }
  return `<span class="pill pill-warning" title="${escapeHtml(entry.message || "")}">Gagal dicek</span>`;
}

/**
 * Providers list: cards grouped by category, each linking to its detail page.
 */
export function renderProvidersPage(port = 20120, query = {}, lang = DEFAULT_LANGUAGE) {
  const currentLang = lang || DEFAULT_LANGUAGE;
  const activeTab = query.tab === "combos" ? "combos" : "providers";
  const connections = getConnections();
  const byProvider = new Map();
  for (const c of connections) {
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
    byProvider.get(c.provider).push(c);
  }

  const allImported = listImportedModels();
  const allCustom = listCustomModels();

  const sections = SECTIONS.map((s) => {
    const providers = getAllProviders()
      .filter((p) => (p.category || "apikey") === s.category)
      // Ready (noAuth) first, then connected, then alphabetical.
      .sort((a, b) => {
        const ra = a.noAuth ? 0 : accountStats(byProvider.get(a.id) || []).healthy > 0 ? 1 : 2;
        const rb = b.noAuth ? 0 : accountStats(byProvider.get(b.id) || []).healthy > 0 ? 1 : 2;
        return ra - rb || a.name.localeCompare(b.name);
      });
    if (providers.length === 0) return "";

    const cards = providers
      .map((p) => {
        const stats = accountStats(byProvider.get(p.id) || []);
        const modelCount = countProviderModels(
          p,
          allImported.filter((m) => m.provider === p.id),
          allCustom.filter((m) => m.provider === p.id)
        );
        return `
      <a class="card provider-card" href="${providerUrl(p.id)}">
        <div class="provider-matrix-left">
          <div class="provider-logo-box">
            ${providerIconHtml(p, 36)}
          </div>
          <span class="provider-prefix-badge"><code>${escapeHtml(primaryAlias(p))}/</code></span>
        </div>
        <div class="provider-matrix-right">
          <div class="provider-matrix-head">
            <h3 class="provider-name">${escapeHtml(p.name)}</h3>
            <span class="provider-model-count">${modelCount} MODEL</span>
          </div>
          <div class="provider-matrix-meta">
            ${statusPill(p, stats, byProvider.get(p.id) || [])}
            ${freeTierPills(p.id)}
          </div>
          <span class="sr-only" style="display:none"><code>${escapeHtml(primaryAlias(p))}/</code> &middot; ${modelCount} model</span>
        </div>
      </a>`;
      })
      .join("");

    return `
    <section class="section">
      <div class="section-head">
        <h3>${s.title}</h3>
        <p class="hint">${s.hint}</p>
      </div>
      <div class="grid-3">${cards}</div>
    </section>`;
  }).join("");

  const tabBar = `
    <div class="page-tabs" style="display: flex; justify-content: space-between; align-items: center;">
      <div style="display: flex; gap: 8px;">
        <a class="page-tab ${activeTab === "providers" ? "active" : ""}" href="/dashboard/providers">Providers</a>
        <a class="page-tab ${activeTab === "combos" ? "active" : ""}" href="/dashboard/providers?tab=combos">Combos</a>
      </div>
      <div>
        <button type="button" class="btn btn-primary btn-sm" onclick="openModal('add-custom-provider-modal')">+ Custom Provider</button>
      </div>
    </div>`;

  const addCustomProviderModal = `
    <div class="modal-backdrop" id="add-custom-provider-modal">
      <div class="modal">
        <h3>Tambah Custom Provider</h3>
        <form action="/dashboard/providers/custom/add" method="POST">
          <div class="field">
            <label for="cp-name">${currentLang === "en" ? "Provider Name" : "Nama Provider"}</label>
            <input type="text" id="cp-name" name="name" placeholder="${escapeHtml(t("providers.form_name_placeholder", {}, currentLang))}" required />
          </div>
          <div class="field">
            <label for="cp-prefix">${currentLang === "en" ? "Model Prefix (Wire Syntax)" : "Prefix Model (Wire Syntax)"}</label>
            <input type="text" id="cp-prefix" name="prefix" placeholder="${escapeHtml(t("providers.form_prefix_placeholder", {}, currentLang))}" required pattern="[a-zA-Z0-9_-]+" />
            <p class="hint">${currentLang === "en" ? "Prefix to invoke models, e.g. " : "Prefix untuk memanggil model, misal "}<code>lms/&lt;model&gt;</code>.</p>
          </div>
          <div class="field">
            <label for="cp-base-url">Base URL</label>
            <input type="url" id="cp-base-url" name="base_url" placeholder="${escapeHtml(t("providers.form_base_url_placeholder", {}, currentLang))}" required />
            <p class="hint">${currentLang === "en" ? "Root API endpoint URL (e.g. " : "URL endpoint API root (misal "}<code>http://127.0.0.1:1234/v1</code>${currentLang === "en" ? " or " : " atau "}<code>https://api.mistral.ai/v1</code>).</p>
          </div>
          <div class="field">
            <label for="cp-api-type">${currentLang === "en" ? "API Protocol Type" : "Tipe Protokol API"}</label>
            <select id="cp-api-type" name="api_type">
              <option value="openai">OpenAI Compatible (/chat/completions)</option>
              <option value="claude">Anthropic Compatible (/messages)</option>
            </select>
          </div>
          <div class="field">
            <label for="cp-headers">${currentLang === "en" ? "Custom Headers (Optional, JSON format)" : "Custom Headers (Opsional, Format JSON)"}</label>
            <input type="text" id="cp-headers" name="custom_headers" placeholder='{"X-Custom-Header": "value"}' />
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" data-close-modal="add-custom-provider-modal">${escapeHtml(t("common.cancel", {}, currentLang))}</button>
            <button type="submit" class="btn btn-primary">${currentLang === "en" ? "Save Provider" : "Simpan Provider"}</button>
          </div>
        </form>
      </div>
    </div>`;

  const content =
    activeTab === "combos"
      ? tabBar + renderCombosContent(query, currentLang)
      : tabBar + sections + addCustomProviderModal;

  return renderLayout({
    title:
      activeTab === "combos"
        ? (currentLang === "en" ? "Model Combos" : "Combos")
        : activeTab === "proxy"
          ? (currentLang === "en" ? "Proxy Pools — Zenith Router" : "Proxy — Zenith Router")
          : (currentLang === "en" ? "Providers & Accounts" : "Providers"),
    activeTab: "providers",
    content,
    port,
    lang: currentLang,
  });
}

const LOGIN_LABELS = {
  claude: "Login dengan Claude",
  codex: "Login dengan ChatGPT",
  antigravity: "Login dengan Google",
  cline: "Login dengan Cline",
  github: "Login dengan GitHub",
  kilocode: "Login dengan Kilo",
  kiro: "Login dengan AWS Builder ID",
  glm: "Login dengan Z.ai",
};

const LOCAL_IMPORT = {
  kiro: { label: "Import dari Kiro IDE", hint: "Memakai login Kiro IDE (Google/GitHub/Builder ID) dari ~/.aws/sso/cache." },
  freebuff: {
    label: "Import dari Freebuff CLI",
    hint: "Memakai login CLI dari ~/.config/manicode/credentials.json. Belum login? Jalankan npm i -g freebuff, lalu freebuff.",
  },
  commandcode: {
    label: "Import dari Command Code CLI",
    hint: "Memakai API Key dari ~/.commandcode/auth.json. Belum login? Jalankan cmd login (atau cmdc login di Windows).",
  },
};

// What the manual-paste field holds, for providers whose login normally produces it.
const MANUAL_TOKEN_LABELS = {
  claude: "OAuth Token atau API Key (sk-ant-api...)",
  glm: "API Key (Coding Plan)",
  github: "GitHub Token (gho_/ghu_)",
  freebuff: "Auth Token",
  commandcode: "API Key (user_...)",
};

const REFRESHABLE = new Set(["claude", "codex", "antigravity", "cline", "kiro"]);

const OAUTH_SCOPE_NOTICES = {
  antigravity: "Login meminta izin <code>cloud-platform</code> penuh ke Google Cloud Platform untuk integrasi Gemini Code Assist.",
  claude: "Login memakai token Anthropic CLI yang memiliki scope <code>user:inference</code> dan <code>org:create_api_key</code>.",
};

/** Accounts for these providers come from a login, so they are stored as oauth. */
function usesLogin(p) {
  return Boolean(getOAuthFlow(p.id) || hasLocalImport(p.id) || p.category === "oauth");
}

/** Inline script for the login buttons: start a flow, open the provider page, poll until saved. */
export function formatManualOAuthError(msg, isManualOnly) {
  if (!isManualOnly) return msg || "Gagal.";
  if (!msg || /Tidak menemukan code/i.test(msg)) {
    return "Masukkan kode dari Claude terlebih dahulu.";
  }
  if (/URL callback tidak valid/i.test(msg)) {
    return "Kode tidak valid.";
  }
  if (/Pastikan URL/i.test(msg) || /State tidak cocok/i.test(msg)) {
    return "Kode tidak cocok. Pastikan kode berasal dari login yang sama.";
  }
  if (/Sesi login/i.test(msg)) {
    return "Sesi login kedaluwarsa atau sudah selesai. Ulangi login untuk mendapatkan kode baru.";
  }
  return msg;
}

const OAUTH_SCRIPT = `
<script>
(function () {
  var flowId = null, timer = null, pollMs = 2000, isManualOnly = false;
  var statusEl = document.getElementById('oauth-status');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function show(html, isError) { statusEl.hidden = false; statusEl.className = 'oauth-status' + (isError ? ' error' : ''); statusEl.innerHTML = html; }
  function post(url, data) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok && !j.error) j.error = 'HTTP ' + r.status; return j; }); });
  }
  function formatManualError(msg, manual) {
    if (!manual) return msg || 'Gagal.';
    if (!msg || /Tidak menemukan code/i.test(msg)) return 'Masukkan kode dari Claude terlebih dahulu.';
    if (/URL callback tidak valid/i.test(msg)) return 'Kode tidak valid.';
    if (/Pastikan URL/i.test(msg) || /State tidak cocok/i.test(msg)) return 'Kode tidak cocok. Pastikan kode berasal dari login yang sama.';
    if (/Sesi login/i.test(msg)) return 'Sesi login kedaluwarsa atau sudah selesai. Ulangi login untuk mendapatkan kode baru.';
    return msg;
  }
  function done() { location.href = location.pathname + '?notice=account_added'; }
  function schedule() { clearTimeout(timer); timer = setTimeout(tick, pollMs); }
  function tick() {
    if (!flowId) return;
    post('/dashboard/oauth/poll', { flowId: flowId }).then(function (r) {
      if (r.status === 'done') return done();
      if (r.status === 'error') { flowId = null; return show('Login gagal: ' + esc(r.error), true); }
      schedule();
    }).catch(schedule);
  }
  window.zrCopyAccount = function (form) { form.name.value = val('acct-name'); form.proxy_url.value = val('acct-proxy'); return true; };
  window.zrOAuthStart = function (provider) {
    window.zrOAuthCancel();
    // Open the tab inside the click so popup blockers allow it, then point it at the login page.
    var popup = window.open('about:blank', '_blank');
    show('Memulai login...');
    post('/dashboard/oauth/start', { provider: provider, name: val('acct-name'), proxy_url: val('acct-proxy') }).then(function (r) {
      if (r.error) { if (popup) popup.close(); return show(esc(r.error), true); }
      flowId = r.flowId;
      isManualOnly = r.manualOnly === true;
      var url = r.flowType === 'device_code' ? r.verificationUri : r.authUrl;
      if (popup) { popup.opener = null; popup.location.href = url; }
      var link = '<a href="' + esc(url) + '" target="_blank" rel="noopener">Buka halaman login</a>';
      if (r.flowType === 'device_code') {
        pollMs = Math.max(2, r.interval || 5) * 1000;
        show((r.userCode ? '<p>Masukkan kode ini di halaman login:</p><div class="device-code">' + esc(r.userCode) + '</div>' : '<p>Selesaikan login di tab yang terbuka.</p>') +
          '<p>' + link + '</p><p class="hint">Menunggu persetujuan...</p>');
      } else {
        pollMs = 2000;
        show((isManualOnly
            ? '<p>Buka tautan login di tab yang terbuka. ' + link + '</p><p>Setujui akses, salin kode yang ditampilkan Claude, tempelkan kode itu di kolom di bawah, lalu tekan Kirim.</p>'
            : '<p>Selesaikan login di tab yang terbuka. ' + link + '</p>' +
              (r.listening === false ? '<p>Port callback sedang dipakai aplikasi lain, jadi tempel URL callback secara manual.</p>'
                : '<p class="hint">Menunggu callback. Kalau browser tidak kembali ke Zenith Router, tempel URL callback atau kode di bawah.</p>')) +
          '<div class="field"><input id="oauth-manual" placeholder="' +
          (isManualOnly
            ? 'Tempel kode dari Claude di sini'
            : 'http://localhost:.../callback?code=... atau code#state') +
          '" autocomplete="off" /></div>' +
          '<button type="button" class="btn btn-sm" onclick="zrOAuthManual()">Kirim</button>' +
          '<p id="oauth-manual-error" class="hint" style="color: var(--danger); margin-top: 0.5rem;"></p>');
      }
      schedule();
    }).catch(function (e) { if (popup) popup.close(); show('Gagal memulai login: ' + esc(e.message), true); });
  };
  window.zrOAuthManual = function () {
    if (!flowId) return;
    var errEl = document.getElementById('oauth-manual-error');
    var raw = val('oauth-manual');
    if (isManualOnly && !raw) {
      errEl.textContent = formatManualError('', true);
      return;
    }
    post('/dashboard/oauth/manual', { flowId: flowId, input: raw }).then(function (r) {
      if (r.status === 'done') return done();
      errEl.textContent = formatManualError(r.error, isManualOnly);
    });
  };
  window.zrOAuthCancel = function () {
    if (flowId) post('/dashboard/oauth/cancel', { flowId: flowId });
    flowId = null;
    isManualOnly = false;
    clearTimeout(timer);
    statusEl.hidden = true;
  };
  // Alur login dibatalkan saat isi <main> diganti swap tanpa reload, karena
  // polling dan elemen status lama ikut terbuang.
  if (window.__zrSwapCleanups) {
    window.__zrSwapCleanups.push(function () { if (flowId) window.zrOAuthCancel(); });
  }
})();
</script>`;

// One-click login for session providers: the server opens a browser, this page
// polls until the token is captured, then reloads with the new account.
const SESSION_LOGIN_SCRIPT = `
<script>
(function () {
  var btn = document.getElementById('session-login-start');
  var statusEl = document.getElementById('oauth-status');
  if (!btn || !statusEl) return;
  var flowId = null, timer = null;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function show(html, isError) { statusEl.hidden = false; statusEl.className = 'oauth-status' + (isError ? ' error' : ''); statusEl.innerHTML = html; }
  function post(url, data) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok && !j.error) j.error = 'HTTP ' + r.status; return j; }); });
  }
  function done(existing) { location.href = location.pathname + '?notice=' + (existing ? 'account_exists' : 'account_added'); }
  function stop() { clearTimeout(timer); timer = null; flowId = null; btn.disabled = false; }
  var PHASES = {
    launching: 'Membuka browser...',
    profile: 'Memuat sesi dari profil browser Anda...',
    attaching: 'Membuka tab di browser yang sudah berjalan...',
    verifying: 'Memeriksa sesi login...',
    waiting: 'Selesaikan login di jendela browser. Jendela ditutup otomatis setelah sesi terverifikasi.'
  };
  function tick() {
    if (!flowId) return;
    post('/dashboard/providers/accounts/login/poll', { flowId: flowId }).then(function (r) {
      if (r.status === 'done') return done(r.existing);
      if (r.status === 'error') { stop(); return show('Login gagal: ' + esc(r.error || 'tidak diketahui'), true); }
      show('<p>' + esc(PHASES[r.phase] || PHASES.waiting) + '</p><p class="hint">Captcha dan OTP tetap Anda isi sendiri.</p>');
      timer = setTimeout(tick, 2000);
    }).catch(function () { timer = setTimeout(tick, 2500); });
  }
  function start() {
    stop();
    btn.disabled = true;
    show('Memulai login...');
    post('/dashboard/providers/accounts/login/start', {
      provider: btn.getAttribute('data-provider'),
      name: val('acct-name'),
      proxy_url: val('acct-proxy')
    }).then(function (r) {
      if (r.error) { stop(); return show(esc(r.error), true); }
      flowId = r.flowId;
      show('<p>' + esc(PHASES.launching) + '</p>');
      tick();
    }).catch(function (err) { stop(); show('Gagal memulai login: ' + esc(err.message), true); });
  }
  window.zrCopyAccount = function (form) { form.name.value = val('acct-name'); form.proxy_url.value = val('acct-proxy'); return true; };
  btn.addEventListener('click', start);
  window.zrSessionLoginCancel = function () {
    if (flowId) post('/dashboard/providers/accounts/login/cancel', { flowId: flowId });
    stop();
    statusEl.hidden = true;
  };
  // Same reason as the OAuth script: a swap replaces the dialog, so the poll goes too.
  if (window.__zrSwapCleanups) {
    window.__zrSwapCleanups.push(function () { if (flowId) window.zrSessionLoginCancel(); });
  }
})();
</script>`;

function renderAddAccountModal(p) {
  const id = escapeHtml(p.id);
  const title = `<h3>Add ${escapeHtml(p.name)} Account</h3>`;

  // Session providers follow the same dialog shape as the OAuth ones: one primary
  // login button, one status area that reports progress, and manual entry folded
  // away underneath. Only the work behind the button differs.
  if ((p.authMethods || []).includes("session")) {
    return `
    <div class="modal-backdrop" id="add-account-modal">
      <div class="modal">
        ${title}
        <div class="field">
          <label for="acct-name">Label Akun (Opsional)</label>
          <input type="text" id="acct-name" placeholder="Default: email akun" />
        </div>
        <div class="field">
          <label for="acct-proxy">URL Proxy (Opsional)</label>
          <input type="text" id="acct-proxy" placeholder="http://127.0.0.1:7890" />
        </div>
        <div class="notice" style="background: var(--bg-hover, #d4d4d4); border-left: 3px solid var(--warning, #fbbf24); padding: 0.5rem 0.75rem; font-size: 0.8rem; margin-bottom: 1rem; line-height: 1.4;">
          <span style="color: var(--text-muted, #2a2a2a);">Token ini setara akses penuh ke akun DeepSeek kamu dan tersimpan plaintext di database gateway. Gunakan akun khusus, jangan bagikan token, dan pahami risiko pemblokiran akun karena pemakaian di luar klien resmi.</span>
        </div>
        <div class="oauth-actions">
          <button type="button" class="btn btn-primary" id="session-login-start" data-provider="${id}">Login di browser</button>
        </div>
        <div id="oauth-status" class="oauth-status" hidden></div>
        <details class="manual">
          <summary>Tempel token manual</summary>
          <form action="/dashboard/providers/accounts/add" method="POST" onsubmit="return zrCopyAccount(this)">
            <input type="hidden" name="provider" value="${id}" />
            <input type="hidden" name="name" />
            <input type="hidden" name="proxy_url" />
            <div class="field">
              <label for="token">User Token</label>
              <input type="password" id="token" name="token" placeholder="token eyJ... (isi field value dari userToken)" required />
              <p class="hint" style="margin-bottom: 4px;">Cara mengambil token (sekitar satu menit):</p>
              <ol class="hint" style="margin: 0 0 10px 1.1rem; padding: 0; line-height: 1.55;">
                <li>Buka <code>chat.deepseek.com</code> dan login seperti biasa.</li>
                <li>Tekan <kbd>F12</kbd>, lalu pilih tab <strong>Application</strong> (Chrome/Edge) atau <strong>Storage</strong> (Firefox).</li>
                <li>Buka <strong>Local Storage</strong> &rarr; <code>https://chat.deepseek.com</code>, cari baris <code>userToken</code>.</li>
                <li>Salin nilainya. Kalau bentuknya <code>{"value":"...","__version":"0"}</code>, ambil bagian <code>value</code> saja.</li>
                <li>Tempel di kolom di atas. Cookies hanya perlu diisi kalau sesi diminta verifikasi tambahan.</li>
              </ol>
              <p class="hint">Token berlaku selama sesi di browser itu hidup; logout atau ganti akun membuat token lama tidak berlaku lagi.</p>
            </div>
            <div class="field">
              <label for="cookies">Cookies (opsional)</label>
              <input type="text" id="cookies" name="cookies" placeholder="a=1; b=2" />
            </div>
            <button type="submit" class="btn btn-sm">Simpan Token</button>
          </form>
        </details>
        <div class="modal-actions">
          <button type="button" class="btn" data-close-modal="add-account-modal" onclick="zrSessionLoginCancel()">Tutup</button>
        </div>
      </div>
    </div>
    ${SESSION_LOGIN_SCRIPT}`;
  }

  if (!usesLogin(p)) {
    return `
    <div class="modal-backdrop" id="add-account-modal">
      <div class="modal">
        ${title}
        <form action="/dashboard/providers/accounts/add" method="POST">
          <input type="hidden" name="provider" value="${id}" />
          <div class="field">
            <label for="name">Label Akun</label>
            <input type="text" id="name" name="name" placeholder="mis. Akun utama" required />
          </div>
          <div class="field">
            <label for="api_key">API Key</label>
            <input type="password" id="api_key" name="api_key" placeholder="Tempel API key..." required />
            ${p.keyUrl ? `<p class="hint">Belum punya key? ${keyLink(p)}</p>` : ""}
          </div>
          <div class="field">
            <label for="proxy_choice">Proxy</label>
            <select id="proxy_choice" name="proxy_choice">
              <option value="">Koneksi langsung</option>
              ${listProxyPools()
                .map((p) => `<option value="pool:${p.id}">${escapeHtml(p.name)}</option>`)
                .join("")}
              <option value="manual">Alamat manual…</option>
            </select>
            <input type="text" name="proxy_url" placeholder="http://user:pass@host:port" style="margin-top: 0.4rem;" />
            <p class="hint">Pilih proxy daftar, isi alamat manual, atau biarkan kosong untuk koneksi langsung. Daftar diprioritaskan di atas alamat manual.</p>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" data-close-modal="add-account-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Tambah Akun</button>
          </div>
        </form>
      </div>
    </div>`;
  }

  const login = getOAuthFlow(p.id)
    ? `<button type="button" class="btn btn-primary" onclick="zrOAuthStart('${id}')">${escapeHtml(LOGIN_LABELS[p.id] || "Masuk")}</button>`
    : "";
  const local = LOCAL_IMPORT[p.id];
  const importForm = local
    ? `<form action="/dashboard/providers/accounts/import-local" method="POST" onsubmit="return zrCopyAccount(this)">
            <input type="hidden" name="provider" value="${id}" />
            <input type="hidden" name="name" />
            <input type="hidden" name="proxy_url" />
            <button type="submit" class="btn">${escapeHtml(local.label)}</button>
          </form>
          <p class="hint">${escapeHtml(local.hint)}</p>`
    : "";
  const tokenLabel = MANUAL_TOKEN_LABELS[p.id] || "Access Token";

  return `
    <div class="modal-backdrop" id="add-account-modal">
      <div class="modal">
        ${title}
        <div class="field">
          <label for="acct-name">Label Akun (Opsional)</label>
          <input type="text" id="acct-name" placeholder="Default: email akun" />
        </div>
        <div class="field">
          <label for="acct-proxy">URL Proxy (Opsional)</label>
          <input type="text" id="acct-proxy" placeholder="http://127.0.0.1:7890" />
        </div>
        ${
          OAUTH_SCOPE_NOTICES[p.id]
            ? `<div class="notice" style="background: var(--bg-hover, #d4d4d4); border-left: 3px solid var(--warning, #fbbf24); padding: 0.5rem 0.75rem; font-size: 0.8rem; margin-bottom: 1rem; line-height: 1.4;">
                <span style="color: var(--text-muted, #2a2a2a);">${OAUTH_SCOPE_NOTICES[p.id]}</span>
              </div>`
            : ""
        }
        <div class="oauth-actions">
          ${login}
          ${importForm}
        </div>
        <div id="oauth-status" class="oauth-status" hidden></div>
        <details class="manual">
          <summary>Tempel token manual</summary>
          <form action="/dashboard/providers/accounts/add" method="POST" onsubmit="return zrCopyAccount(this)">
            <input type="hidden" name="provider" value="${id}" />
            <input type="hidden" name="name" />
            <input type="hidden" name="proxy_url" />
            <div class="field">
              <label for="api_key">${escapeHtml(tokenLabel)}</label>
              <input type="password" id="api_key" name="api_key" placeholder="Tempel token..." required />
              ${p.keyUrl ? `<p class="hint">Belum punya key? ${keyLink(p)}</p>` : ""}
            </div>
            ${
              REFRESHABLE.has(p.id)
                ? `<div class="field">
              <label for="refresh_token">Refresh Token (Opsional)</label>
              <input type="password" id="refresh_token" name="refresh_token" placeholder="Agar token diperpanjang otomatis" />
            </div>`
                : ""
            }
            <button type="submit" class="btn btn-sm">Simpan Token</button>
          </form>
        </details>
        <div class="modal-actions">
          <button type="button" class="btn" data-close-modal="add-account-modal" onclick="zrOAuthCancel()">Tutup</button>
        </div>
      </div>
    </div>
    ${OAUTH_SCRIPT}`;
}

/**
 * Account row priority cell: the #n badge plus up/down controls, matching
 * the neobrutalist hardware stepper style. A lone account has nothing to reorder against.
 */
function accountOrderCell(c, id, index, total) {
  const badge = `<div class="stamp-priority-index" title="Prioritas #${index + 1}">${index + 1}</div>`;
  if (total < 2) return `<div class="priority-controls" style="box-shadow:none;">${badge}</div>`;
  return `
    <div style="display: flex; align-items: center; gap: 8px;">
      <form action="/dashboard/providers/accounts/move" method="POST" class="priority-controls" style="margin: 0;">
        <input type="hidden" name="id" value="${escapeHtml(c.id)}" />
        <input type="hidden" name="provider" value="${id}" />
        <button type="submit" name="direction" value="up" class="p-arrow-btn" title="Naikkan prioritas" ${
          index === 0 ? "disabled" : ""
        }>&blacktriangle;</button>
        <button type="submit" name="direction" value="down" class="p-arrow-btn" title="Turunkan prioritas" ${
          index === total - 1 ? "disabled" : ""
        }>&blacktriangledown;</button>
      </form>
      ${badge}
    </div>`;
}

/**
 * Account row proxy cell: shows the effective binding plus an inline
 * form to rebind it at any time in a compact neobrutalist dropdown jack.
 */
function accountProxyCell(c, id, pools) {
  const poolById = new Map(pools.map((p) => [p.id, p]));
  let labelText = "Langsung (Tanpa Proxy)";
  let isPool = false;
  if (c.proxy_pool_id) {
    const pool = poolById.get(c.proxy_pool_id);
    if (!pool) labelText = "Proxy Dihapus";
    else if (!pool.is_active) labelText = `Daftar: ${escapeHtml(pool.name)}`;
    else {
      labelText = `Daftar: ${escapeHtml(pool.name)}`;
      isPool = true;
    }
  } else if (c.proxy_url) {
    labelText = escapeHtml(maskProxyUrl(c.proxy_url));
  }

  return `
    <div class="strip-proxy-cell">
      <details class="proxy-jack-details">
        <summary class="proxy-jack-badge" title="Klik untuk mengganti proxy">
          <span class="proxy-jack-icon ${isPool ? "is-pool" : c.proxy_url ? "is-manual" : "is-direct"}">&#11041;</span>
          <span>${labelText}</span>
          <span style="font-size: 9px; margin-left: 2px;">&#9662;</span>
        </summary>
        <div class="proxy-jack-menu">
          <form action="/dashboard/providers/accounts/set-proxy" method="POST" class="account-proxy-form" style="margin: 0;">
            <input type="hidden" name="id" value="${escapeHtml(c.id)}" />
            <input type="hidden" name="provider" value="${id}" />
            <div class="proxy-jack-menu-title">Konfigurasi Proxy Jack</div>
            <select name="proxy_choice" class="search-cli-input" style="width: 100%; margin-bottom: 6px; font-size: 12px; padding: 5px 8px;">
              <option value="" ${!c.proxy_pool_id && !c.proxy_url ? "selected" : ""}>Langsung (Tanpa Proxy)</option>
              ${pools
                .map(
                  (p) =>
                    `<option value="pool:${p.id}" ${c.proxy_pool_id === p.id ? "selected" : ""}>Daftar: ${escapeHtml(p.name)}</option>`
                )
                .join("")}
              <option value="manual" ${!c.proxy_pool_id && c.proxy_url ? "selected" : ""}>Alamat manual…</option>
            </select>
            <input type="text" name="proxy_url" placeholder="http://user:pass@host:port" class="search-cli-input" style="width: 100%; margin-bottom: 8px; font-size: 12px; padding: 5px 8px;" value="${c.proxy_url ? escapeHtml(maskProxyUrl(c.proxy_url)) : ""}" />
            <button type="submit" class="btn-nb btn-nb-primary" style="width: 100%; justify-content: center; padding: 5px 10px; font-size: 11px;">Simpan Proxy</button>
          </form>
        </div>
      </details>
    </div>`;
}

/**
 * The identity the provider reported for this account at login time, so a
 * multi-account provider shows which Claude account is which.
 */
function accountIdentityCell(c) {
  const creds = c.credentials || {};
  const parts = [];
  if (creds.account_email) parts.push(escapeHtml(creds.account_email));
  if (creds.organization_name) parts.push(escapeHtml(creds.organization_name));
  if (creds.organization_rate_limit_tier) parts.push(`tier ${escapeHtml(creds.organization_rate_limit_tier)}`);
  if (parts.length === 0) return "";
  return `<div class="hint" style="font-size: 11.5px; font-family: ui-monospace, monospace; margin-top: 2px;">${parts.join(" · ")}</div>`;
}

function accountStatusTag(c) {
  if (c.is_active !== 1) return `<span class="tag-status tag-status-inactive">Nonaktif</span>`;
  if (isConnectionFullyCooledDown(c)) return `<span class="tag-status tag-status-cooldown">Cooldown</span>`;
  if (isConnectionExhausted(c)) return `<span class="tag-status tag-status-exhausted">Habis Kuota</span>`;
  return `<span class="tag-status tag-status-operational">Aktif</span>`;
}

function renderSlotMeter(trafficAccount, cap) {
  const inFlight = trafficAccount?.inFlight || 0;
  const effectiveCap = trafficAccount?.cap || cap || 1;
  const displayUnits = Math.min(Math.max(effectiveCap, 1), 8);
  const units = [];
  for (let i = 0; i < displayUnits; i++) {
    units.push(`<span class="meter-unit ${i < inFlight ? "on" : ""}"></span>`);
  }
  const queueBadge = trafficAccount?.queue > 0 ? ` <span class="tag-fusion" style="background:#facc15;color:#000;margin-left:4px;">+${trafficAccount.queue}</span>` : "";
  return `
    <div class="strip-slot-meter" title="Request berjalan ${inFlight} dari batas ${effectiveCap}">
      <span>SLOT</span> <span class="slot-count">${inFlight}/${effectiveCap}</span>
      <div class="slot-meter-units">
        ${units.join("")}
      </div>
      ${queueBadge}
    </div>`;
}

function renderAccountChannelStrip(c, index, total, id, p, proxyPools, trafficAccount, effectiveConcurrency) {
  const isSession = p.category === "session";
  const hidden = `<input type="hidden" name="id" value="${escapeHtml(c.id)}" /><input type="hidden" name="provider" value="${id}" />`;
  
  let keySnippet = "";
  if (c.credentials?.api_key) {
    const raw = String(c.credentials.api_key);
    keySnippet = raw.length > 12 ? `${escapeHtml(raw.slice(0, 8))}...${escapeHtml(raw.slice(-4))}` : "api_key";
  } else if (c.credentials?.token) {
    keySnippet = "session_token";
  } else if (c.credentials?.access_token) {
    keySnippet = "access_token";
  } else {
    keySnippet = escapeHtml(c.auth_type || "auth");
  }

  const sessionForms = isSession
    ? `
      <form action="/dashboard/providers/accounts/check-session" method="POST" style="margin:0;display:inline;">
        ${hidden}
        <button type="submit" class="btn-nb" style="padding: 5px 12px; font-size: 11px;">Periksa sesi</button>
      </form>
      <details style="display:inline-block;position:relative;">
        <summary class="btn-nb" style="padding: 5px 12px; font-size: 11px; cursor:pointer;">Perbarui sesi</summary>
        <div class="proxy-jack-menu" style="right:0;left:auto;">
          <form action="/dashboard/providers/accounts/update-session" method="POST" class="account-session-form" style="margin:0;">
            ${hidden}
            <div style="font-family: ui-monospace, monospace; font-size: 11px; font-weight: 800; margin-bottom: 6px; text-transform: uppercase;">Perbarui Token Sesi</div>
            <input type="password" name="token" placeholder="token baru" required autocomplete="off" class="search-cli-input" style="width: 100%; margin-bottom: 4px; font-size: 12px; padding: 5px 8px;" />
            <input type="text" name="cookies" placeholder="cookies (opsional)" autocomplete="off" class="search-cli-input" style="width: 100%; margin-bottom: 6px; font-size: 12px; padding: 5px 8px;" />
            <button type="submit" class="btn-nb btn-nb-primary" style="width: 100%; justify-content: center; padding: 5px 10px; font-size: 11px;">Simpan Sesi</button>
          </form>
        </div>
      </details>`
    : `
      <form action="/dashboard/providers/test-connection" method="POST" style="margin:0;display:inline;">
        ${hidden}
        <button type="submit" class="btn-nb" style="padding: 5px 12px; font-size: 11px;" title="Uji koneksi dan otentikasi akun ini">UJI</button>
      </form>`;

  const deleteForm = `
    <form action="/dashboard/providers/accounts/delete" method="POST" style="margin:0;display:inline;" data-confirm="Hapus akun ini dari daftar?">
      ${hidden}
      <button type="submit" class="btn-nb btn-nb-danger" style="padding: 5px 12px; font-size: 11px;">HAPUS</button>
    </form>`;

  return `
    <div class="account-channel-strip">
      <div class="strip-identity-left">
        ${accountOrderCell(c, id, index, total)}
        <div class="account-name-block">
          <h4 style="font-size: 14.5px; font-weight: 800; margin: 0;">${escapeHtml(c.name)}</h4>
          <div class="account-sub-key">
            <span>${keySnippet}</span> &middot; <span style="text-transform: uppercase;">${escapeHtml(c.auth_type)}</span>
            ${accountIdentityCell(c)}
          </div>
        </div>
      </div>

      ${accountProxyCell(c, id, proxyPools)}

      ${renderSlotMeter(trafficAccount, effectiveConcurrency)}

      <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
        ${accountStatusTag(c)}
        ${isSession ? `<span style="font-size: 11px;">${sessionHealthCell(c)}</span>` : ""}
      </div>

      <div class="strip-actions-group">
        ${sessionForms}
        ${deleteForm}
      </div>
    </div>`;
}

/**
 * Provider detail: accounts, models (built-in + custom) with enable/disable.
 * Returns null when the provider id is unknown.
 */
export function renderProviderDetailPage(port, idOrAlias, query = {}, lang = DEFAULT_LANGUAGE) {
  const currentLang = lang || DEFAULT_LANGUAGE;
  const p = getProvider(idOrAlias);
  if (!p) return null;
  const importModes = getImportModes(p);
  const notice = importNotice(query, p);

  const alias = primaryAlias(p);
  const accounts = getConnections(p.id);
  const stats = accountStats(accounts);
  const isSession = p.category === "session";
  // Snapshot at render time; the dashboard has no polling loop.
  const traffic = getProviderTraffic(p.id);
  const trafficByAccount = new Map(traffic.accounts.map((account) => [account.id, account]));
  const id = escapeHtml(p.id);
  const proxyPools = listProxyPools();
  const proxyRotationStrategy = getProxyRotationStrategy(p.id);
  const activePoolCount = proxyPools.filter((pool) => pool.is_active).length;
  const boundPools = accounts
    .map((c) => (c.proxy_pool_id ? proxyPools.find((pool) => pool.id === c.proxy_pool_id) : null))
    .filter(Boolean);
  let noAuthProxyBadge = "";
  if (p.noAuth) {
    if (proxyRotationStrategy !== "off") {
      const stratLabel = proxyRotationStrategy === "round_robin" ? "Bergiliran" : "Acak";
      noAuthProxyBadge = `<span class="pill pill-accent" title="Provider noAuth ini terhubung ke Proxy Pool dengan rotasi ${stratLabel} (${activePoolCount} proxy aktif)"><span class="dot dot-success"></span>Proxy Pool: ${stratLabel} (${activePoolCount} aktif)</span>`;
    } else if (boundPools.length > 0) {
      noAuthProxyBadge = `<span class="pill pill-info" title="Provider noAuth ini terikat ke proxy: ${escapeHtml(boundPools.map((b) => b.name).join(', '))}"><span class="dot dot-success"></span>Proxy: ${escapeHtml(boundPools[0].name)}</span>`;
    } else {
      noAuthProxyBadge = `<span class="pill pill-muted" title="Provider noAuth ini memakai koneksi langsung (tanpa proxy)">Langsung (Tanpa Proxy)</span>`;
    }
  }
  const trafficUpdated = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  // Explicit setting first, then the provider's own default, then the global cap.
  const concurrencySetting = getSetting(`provider_concurrency:${p.id}`, "");
  const declaredConcurrency = Number(p.concurrency) > 0 ? Number(p.concurrency) : 0;
  const globalConcurrency = Number(getSetting("max_account_concurrency", "2")) || 2;
  const effectiveConcurrency = Number(concurrencySetting) || declaredConcurrency || globalConcurrency;
  const concurrencyPlaceholder = declaredConcurrency || globalConcurrency;
  // A provider that holds its slot for a whole turn declares its own ceiling,
  // so the hint must not promise the generic 30s it no longer uses.
  const queueTimeoutMs = resolveProviderQueueTimeout(p.id);

  const channelStripsHtml = accounts
    .map((c, index) =>
      renderAccountChannelStrip(c, index, accounts.length, id, p, proxyPools, trafficByAccount.get(c.id), effectiveConcurrency)
    )
    .join("");

  let accountsBody;
  if (p.noAuth) {
    accountsBody = `
      <div class="channel-strips-wrapper">
        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
            ${noAuthProxyBadge}
            <span class="hint" style="margin: 0;">Provider noAuth ini tidak memerlukan akun autentikasi token/kunci.</span>
          </div>
          <p class="hint" style="margin: 0; line-height: 1.5;">
            ${
              proxyRotationStrategy !== "off"
                ? `Request otomatis dirotasikan secara <strong>${proxyRotationStrategy === "round_robin" ? "bergiliran (round-robin)" : "acak"}</strong> ke <strong>${activePoolCount} proxy aktif</strong> di Proxy Pool saat melayani request ${escapeHtml(p.name)}.`
                : `Saat ini rotasi proxy tidak aktif. Request diteruskan langsung atau melalui proxy yang terikat.`
            }
          </p>
          ${channelStripsHtml}
        </div>
      </div>`;
  } else if (accounts.length === 0) {
    accountsBody = `
      <div class="channel-strips-wrapper">
        <div class="empty" style="padding: 24px; text-align: center;">
          <p class="big"><span class="pill pill-muted">Belum ada akun</span></p>
          <p class="empty-sub-hint">Tambahkan akun agar model ${escapeHtml(p.name)} bisa di-route.</p>
        </div>
      </div>`;
  } else {
    accountsBody = `
      <div class="channel-strips-wrapper">
        ${channelStripsHtml}
        ${
          isSession
            ? `<p class="hint" style="margin-top: 10px;">Status sesi berasal dari health check <code>create_pow_challenge</code> (tanpa memulai percakapan). Token diambil dari <code>localStorage.userToken</code> di chat.deepseek.com dan disimpan sebagai teks biasa di database lokal.</p>`
            : ""
        }
      </div>`;
  }

  const builtInModels = getProviderModels(p);
  const builtInIds = new Set(builtInModels.map((m) => m.id));
  const importedModels = listImportedModels(p.id).filter((m) => !builtInIds.has(m.model_id));
  const importedIds = new Set(importedModels.map((m) => m.model_id));
  const customModels = listCustomModels().filter(
    (m) => m.provider === p.id && !builtInIds.has(m.model_id) && !importedIds.has(m.model_id)
  );
  // The selection column only exists when there are imported rows to delete.
  const hasImported = importedModels.length > 0;

  const SOURCE_CELL = {
    builtin: `<span class="source-builtin">Bawaan</span>`,
    synced: `<span class="tag-fusion tag-synced">Sinkron</span>`,
    custom: `<span class="tag-fusion tag-custom">Kustom</span>`,
    imported: `<span class="tag-fusion tag-imported">Impor</span>`,
  };

  const modelRow = (modelId, name, source, customId, isFree = false, capabilities = null) => {
    const custom = source === "custom";
    const disabled = isModelDisabled(p.id, modelId);
    const toggleAction = disabled ? "enable" : "disable";
    const selectCell = `<input type="checkbox" name="model_ids" value="${escapeHtml(
      modelId
    )}" form="models-bulk-form" data-select-group="models" autocomplete="off" aria-label="Pilih ${escapeHtml(
      modelId
    )}" class="nb-check row-check" />`;

    const categories = ["all"];
    if (isFree) categories.push("free");
    if (capabilities?.thinking || capabilities?.reasoning) categories.push("thinking");
    if (capabilities?.vision) categories.push("vision");
    if (custom) categories.push("custom");

    const capBadges = [];
    if (isFree) capBadges.push(`<span class="tag-fusion tag-free">Gratis</span>`);
    if (capabilities?.thinking || capabilities?.reasoning) capBadges.push(`<span class="tag-fusion tag-thinking">THINKING</span>`);
    if (capabilities?.vision) capBadges.push(`<span class="tag-fusion tag-vision">VISION</span>`);
    if (custom) capBadges.push(`<span class="tag-fusion tag-custom">KUSTOM</span>`);

    return `
        <tr class="model-row${disabled ? ` muted` : ""}" data-sync-row="models" data-cat="${categories.join(" ")}">
          <td class="select-cell" style="width: 32px;">${selectCell}</td>
          <td><code>${escapeHtml(alias)}/${escapeHtml(modelId)}</code>${capabilityIcons(capabilities)}${capBadges.join("")}</td>
          <td>${escapeHtml(name || modelId)}${isFree ? ` <span class="tag-fusion tag-free">Gratis</span>` : ""}</td>
          <td>${SOURCE_CELL[source]}</td>
          <td>${disabled ? `<span class="tag-status tag-status-cooldown">NONAKTIF</span>` : `<span class="tag-status tag-status-operational">AKTIF</span>`}</td>
          <td style="text-align: right;">
            <div style="display: inline-flex; align-items: center; gap: 8px;">
              <form action="/dashboard/providers/models/${toggleAction}" method="POST" style="margin: 0; display: inline;">
                <input type="hidden" name="provider" value="${id}" />
                <input type="hidden" name="model_id" value="${escapeHtml(modelId)}" />
                <button type="submit" class="rocker-toggle" title="${disabled ? "Aktifkan model ini" : "Nonaktifkan model ini"}">
                  <span class="rocker-opt ${!disabled ? "active" : ""}">ON</span>
                  <span class="rocker-opt ${disabled ? "active" : ""}">OFF</span>
                </button>
              </form>
              ${
                custom
                  ? `<form action="/dashboard/providers/models/custom/delete" method="POST" style="margin: 0; display: inline;" data-confirm="Hapus model kustom ini?">
                <input type="hidden" name="id" value="${escapeHtml(customId)}" />
                <input type="hidden" name="provider" value="${id}" />
                <button type="submit" class="btn-nb btn-nb-danger" style="padding: 3px 8px; font-size: 10.5px;">Hapus</button>
              </form>`
                  : ""
              }
            </div>
          </td>
        </tr>`;
  };

  const modelRows = [
    ...builtInModels.map((m) => modelRow(m.id, m.name, m.source, null, m.source === "synced", m.capabilities)),
    ...importedModels.map((m) => modelRow(m.model_id, m.name, "imported", null, m.is_free === 1, resolveCapabilities(m.model_id))),
    ...customModels.map((m) => modelRow(m.model_id, m.name, "custom", m.id, false, resolveCapabilities(m.model_id))),
  ].join("");
  const totalModels = builtInModels.length + importedModels.length + customModels.length;

  const allModelsList = [
    ...builtInModels.map((m) => ({ id: m.id, isFree: m.source === "synced", caps: m.capabilities, custom: false })),
    ...importedModels.map((m) => ({ id: m.model_id, isFree: m.is_free === 1, caps: resolveCapabilities(m.model_id), custom: false })),
    ...customModels.map((m) => ({ id: m.model_id, isFree: false, caps: resolveCapabilities(m.model_id), custom: true })),
  ];
  const freeCount = allModelsList.filter((m) => m.isFree).length;
  const thinkingCount = allModelsList.filter((m) => m.caps?.thinking || m.caps?.reasoning).length;
  const visionCount = allModelsList.filter((m) => m.caps?.vision).length;
  const customCount = allModelsList.filter((m) => m.custom).length;

  const importModal = importModes.length > 0
    ? `
    <div class="modal-backdrop" id="import-models-modal">
      <div class="modal">
        <h3>Import Models</h3>
        <form action="/dashboard/providers/models/import" method="POST">
          <input type="hidden" name="provider" value="${id}" />
          ${importModes
            .map(
              (mode, i) => `
          <label class="radio-row">
            <input type="radio" name="mode" value="${mode}"${i === 0 ? " checked" : ""} />
            <span>${IMPORT_MODE_LABELS[mode]}</span>
          </label>`
            )
            .join("")}
          <p class="hint" style="margin-top: 0.75rem;">Daftar model diambil langsung dari provider. Import ulang akan mengganti hasil import sebelumnya. Model built-in, hasil sinkron, dan custom tidak tersentuh.${
            p.freeModelSync ? " Model gratis provider ini sudah disinkron otomatis, jadi tidak perlu di-import." : ""
          }</p>
          <div class="modal-actions">
            <button type="button" class="btn" data-close-modal="import-models-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Impor</button>
          </div>
        </form>
      </div>
    </div>`
    : "";

  const content = `
    <style>
      :root, [data-theme="light"] {
        --pd-card-bg: #ffffff;
        --pd-text: #09090b;
        --pd-label: #52525b;
        --pd-border: #000000;
        --pd-border-subtle: #e4e4e7;
        --pd-surface-2: #f4f4f5;
        --pd-surface-3: #e4e4e7;
        --pd-shadow-ink: #000000;
      }
      [data-theme="dark"] {
        --pd-card-bg: #15161a;
        --pd-text: #f4f4f6;
        --pd-label: #a1a1aa;
        --pd-border: #71717a;
        --pd-border-subtle: #383842;
        --pd-surface-2: #1e2026;
        --pd-surface-3: #282a33;
        --pd-shadow-ink: #000000;
      }

      /* Reset Card Radius & Frame Neobrutalist */
      .main .provider-chassis-card,
      .main .rack-control-module,
      .main .channel-strips-card,
      .main .model-fleet-card {
        border-radius: 0 !important;
        border: 2.5px solid var(--pd-border, #71717a) !important;
        box-shadow: 4px 4px 0 var(--pd-shadow-ink, #000000) !important;
        background: var(--pd-card-bg, #15161a) !important;
        position: relative !important;
        margin-bottom: 20px !important;
      }
      .main .provider-chassis-card,
      .main .channel-strips-card,
      .main .model-fleet-card {
        padding: 0 !important;
      }
      .fusion-bento-grid > .provider-chassis-card,
      .fusion-bento-grid > .rack-control-module {
        margin-bottom: 0 !important;
      }

      [data-theme="light"] .main .provider-chassis-card,
      [data-theme="light"] .main .rack-control-module,
      [data-theme="light"] .main .channel-strips-card,
      [data-theme="light"] .main .model-fleet-card,
      [data-theme="light"] .main .subnav-bar {
        background: #ffffff !important;
        border: 2.5px solid #000000 !important;
        box-shadow: 4px 4px 0 #000000 !important;
      }

      /* Universal Neobrutalist Hardware Screw */
      .hw-screw {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1px solid var(--pd-border, #71717a);
        background: var(--pd-surface-3, #282a33);
        position: absolute;
        box-shadow: inset 0 0 1px #000;
        pointer-events: none;
        z-index: 5;
      }
      .hw-screw::after {
        content: "";
        position: absolute;
        width: 6px;
        height: 1px;
        background: var(--pd-border, #71717a);
        top: 2.5px;
        left: 0;
      }
      [data-theme="light"] .hw-screw {
        background: #e4e4e7;
        border: 1px solid #000000;
        box-shadow: none;
      }
      [data-theme="light"] .hw-screw::after {
        background: #000000;
      }
      .screw-tl { top: 6px; left: 6px; }
      .screw-tr { top: 6px; right: 6px; }
      .screw-bl { bottom: 6px; left: 6px; }
      .screw-br { bottom: 6px; right: 6px; }

      /* BENTO MASTER GRID (2fr : 1.15fr) */
      .fusion-bento-grid {
        display: grid;
        grid-template-columns: 2fr 1.15fr;
        gap: 16px;
        margin-bottom: 20px;
        align-items: stretch;
      }
      @media (max-width: 960px) {
        .fusion-bento-grid { grid-template-columns: 1fr; }
      }

      /* CHASSIS HEADER */
      .chassis-header-top {
        padding: 18px 20px 14px;
        border-bottom: 2px dashed var(--pd-border, #71717a);
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 14px;
        flex-wrap: wrap;
      }
      [data-theme="light"] .chassis-header-top {
        border-bottom-color: #000000;
      }
      .chassis-id-block {
        display: flex;
        align-items: center;
        gap: 14px;
        min-width: 0;
      }
      .chassis-avatar-bezel {
        width: 48px;
        height: 48px;
        border: 2.5px solid var(--pd-border, #71717a);
        background: var(--pd-surface-2, #1e2026);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        font-weight: 900;
        box-shadow: 2.5px 2.5px 0 var(--pd-shadow-ink, #000);
        flex-shrink: 0;
      }
      [data-theme="light"] .chassis-avatar-bezel {
        background: #f4f4f5;
        border-color: #000000;
        box-shadow: 2.5px 2.5px 0 #000000;
      }
      .chassis-title h1, .chassis-title h2 {
        font-size: 20px;
        font-weight: 900;
        letter-spacing: -0.02em;
        line-height: 1.2;
        margin: 0;
        color: var(--pd-text, #f4f4f6);
      }
      [data-theme="light"] .chassis-title h1,
      [data-theme="light"] .chassis-title h2 {
        color: #09090b !important;
      }
      .chassis-meta-line {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        color: var(--pd-label, #a1a1aa);
        margin-top: 4px;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .chassis-meta-line code {
        font-size: 12px;
        padding: 1px 6px;
      }
      [data-theme="light"] .chassis-meta-line {
        color: #52525b !important;
      }
      .chassis-node-status {
        color: #6ee7b7;
        font-weight: 900;
      }
      [data-theme="light"] .chassis-node-status {
        color: #065f46 !important;
      }

      /* 4-CELL TELEMETRY LEDGER STRIP */
      .chassis-telemetry-strip {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        background: var(--pd-surface-2, #1e2026);
      }
      [data-theme="light"] .chassis-telemetry-strip {
        background: #f4f4f5 !important;
        border-top: 1.5px solid #000000 !important;
      }
      @media (max-width: 640px) {
        .chassis-telemetry-strip { grid-template-columns: repeat(2, 1fr); }
      }
      .telemetry-cell {
        padding: 12px 16px 14px;
        border-right: 1.5px solid var(--pd-border, #71717a);
        position: relative;
        min-width: 0;
      }
      .telemetry-cell:last-child {
        border-right: none;
      }
      [data-theme="light"] .telemetry-cell {
        border-right: 1.5px solid #000000 !important;
      }
      [data-theme="light"] .telemetry-cell:last-child {
        border-right: none !important;
      }
      @media (max-width: 640px) {
        .telemetry-cell:nth-child(2n) { border-right: none !important; }
        .telemetry-cell:nth-child(-n+2) { border-bottom: 1.5px solid var(--pd-border, #71717a); }
        [data-theme="light"] .telemetry-cell:nth-child(-n+2) { border-bottom: 1.5px solid #000000 !important; }
      }
      .telemetry-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--pd-label, #a1a1aa);
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      [data-theme="light"] .telemetry-label {
        color: #52525b !important;
      }
      .telemetry-value {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 16px;
        font-weight: 900;
        letter-spacing: -0.01em;
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--pd-text, #f4f4f6);
      }
      [data-theme="light"] .telemetry-value {
        color: #09090b !important;
      }
      .telemetry-load-pct,
      .telemetry-load-value {
        color: #6ee7b7;
      }
      [data-theme="light"] .telemetry-load-pct,
      [data-theme="light"] .telemetry-value.telemetry-load-value {
        color: #065f46 !important;
      }

      .led-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #6ee7b7;
        box-shadow: 0 0 6px #6ee7b7;
        display: inline-block;
        flex-shrink: 0;
      }
      [data-theme="light"] .led-dot {
        background: #6ee7b7;
        border: 1px solid #000000;
        box-shadow: none;
      }
      .led-dot.is-down {
        background: var(--danger, #ef4444) !important;
        box-shadow: 0 0 6px var(--danger, #ef4444) !important;
      }

      /* HARDWARE CONCURRENCY MODULE */
      .rack-control-module {
        padding: 18px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      .module-title-bar {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding-bottom: 8px;
        border-bottom: 2px solid var(--pd-border, #71717a);
        margin-bottom: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        color: var(--pd-text, #f4f4f6);
      }
      [data-theme="light"] .module-title-bar {
        color: #09090b !important;
        border-bottom-color: #000000;
      }
      .badge-tag {
        font-size: 10.5px;
        padding: 3px 7px;
        background: var(--pd-card-bg, #15161a);
        border: 1px solid var(--pd-border, #71717a);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-weight: 900;
        color: var(--pd-text, #f4f4f6);
      }
      [data-theme="light"] .badge-tag {
        background: #f4f4f5;
        border: 1.5px solid #000000;
        color: #09090b;
      }
      .stepper-control-box {
        background: var(--pd-card-bg, #15161a);
        border: 2px solid var(--pd-border, #71717a);
        padding: 12px;
        box-shadow: 2px 2px 0 var(--pd-shadow-ink, #000);
        margin-bottom: 12px;
      }
      [data-theme="light"] .stepper-control-box {
        background: #fafafa;
        border-color: #000000;
      }
      .stepper-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        color: var(--pd-label, #a1a1aa);
      }
      [data-theme="light"] .stepper-label {
        color: #52525b !important;
      }
      .arcade-stepper-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 8px;
      }
      .arcade-btn {
        width: 38px;
        height: 38px;
        border: 2px solid var(--pd-border, #71717a);
        background: var(--pd-surface-2, #1e2026);
        color: var(--pd-text, #f4f4f6);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-weight: 900;
        font-size: 19px;
        cursor: pointer;
        box-shadow: 2px 2px 0 var(--pd-shadow-ink, #000);
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
        transition: transform 0.08s ease;
      }
      [data-theme="light"] .arcade-btn {
        background: #ffffff;
        color: #09090b;
        border-color: #000000;
      }
      .arcade-btn:hover {
        background: #ccff00;
        color: #000000;
        border-color: #000000;
        transform: translate(-1px, -1px);
      }
      .arcade-display-number {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 28px;
        font-weight: 900;
        color: #ccff00;
        text-shadow: 0 0 8px rgba(204, 255, 0, 0.35);
        user-select: none;
      }
      [data-theme="light"] .arcade-display-number {
        color: #0a0a0a !important;
        text-shadow: none !important;
      }

      .queue-info-card {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11.5px;
        color: var(--pd-label, #a1a1aa);
        line-height: 1.45;
        background: var(--pd-card-bg, #15161a);
        border: 1.5px solid var(--pd-border-subtle, #383842);
        padding: 8px 10px;
        margin-bottom: 12px;
      }
      .queue-info-card strong {
        color: var(--pd-text, #f4f4f6);
      }
      [data-theme="light"] .queue-info-card {
        background: #f4f4f5;
        border-color: #000000;
        color: #52525b !important;
      }
      [data-theme="light"] .queue-info-card strong {
        color: #09090b !important;
      }

      /* BUTTONS NEOBRUTALISM */
      .btn-nb {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11.5px;
        font-weight: 800;
        text-transform: uppercase;
        padding: 6px 12px;
        border: 2px solid var(--pd-border, #71717a);
        background: var(--pd-surface-2, #1e2026);
        color: var(--pd-text, #f4f4f6);
        box-shadow: 2px 2px 0 var(--pd-shadow-ink, #000);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        text-decoration: none;
        transition: transform 0.08s ease, box-shadow 0.08s ease;
      }
      [data-theme="light"] .btn-nb {
        background: #ffffff;
        color: #09090b;
        border-color: #000000;
      }
      .btn-nb:hover {
        transform: translate(-1px, -1px);
        box-shadow: 3px 3px 0 var(--pd-shadow-ink, #000);
        background: var(--pd-surface-3, #282a33);
      }
      [data-theme="light"] .btn-nb:hover {
        background: #f4f4f5;
        color: #09090b;
      }
      .btn-nb:disabled {
        opacity: 0.45;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }
      .btn-nb-primary {
        background: #6ee7b7 !important;
        color: #000000 !important;
        border: 2px solid #000000 !important;
      }
      .btn-nb-primary:hover {
        background: #a7f3d0 !important;
        color: #000000 !important;
      }
      .btn-nb-concurrency,
      .btn-nb-neon {
        background: #ccff00 !important;
        color: #000000 !important;
        border: 2px solid #000000 !important;
      }
      .btn-nb-concurrency:hover,
      .btn-nb-neon:hover {
        background: #d9ff33 !important;
        color: #000000 !important;
      }
      .btn-nb-danger {
        background: #ef4444 !important;
        color: #ffffff !important;
        border-color: #000000 !important;
      }
      .btn-nb-danger:hover {
        background: #dc2626 !important;
        color: #ffffff !important;
      }

      /* WATERFALL CHANNEL STRIPS */
      .block-header-strip {
        background: var(--pd-surface-2, #1e2026);
        border-bottom: 2px solid var(--pd-border, #71717a);
        padding: 12px 20px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
      }
      [data-theme="light"] .block-header-strip {
        background: #f4f4f5 !important;
        border-bottom: 1.5px solid #000000 !important;
      }
      .block-header-title {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 13px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        color: var(--pd-text, #f4f4f6);
      }
      [data-theme="light"] .block-header-title {
        color: #09090b !important;
      }
      .block-header-sub {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        color: var(--pd-label, #a1a1aa);
      }
      [data-theme="light"] .block-header-sub {
        color: #52525b !important;
      }
      .channel-strips-wrapper {
        padding: 16px 20px 18px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .empty-sub-hint {
        margin-top: 8px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        color: var(--pd-label, #a1a1aa);
      }
      [data-theme="light"] .empty-sub-hint {
        color: #52525b !important;
      }
      .account-channel-strip {
        border: 2px solid var(--pd-border, #71717a);
        background: var(--pd-surface-2, #1e2026);
        padding: 10px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px 14px;
        box-shadow: 2.5px 2.5px 0 var(--pd-shadow-ink, #000);
        position: relative;
        transition: transform 0.08s ease, box-shadow 0.08s ease;
      }
      [data-theme="light"] .account-channel-strip {
        background: #fafafa;
        border-color: #000000;
      }
      .account-channel-strip:hover {
        transform: translate(-1px, -1px);
        box-shadow: 4px 4px 0 var(--pd-shadow-ink, #000);
      }
      .strip-identity-left {
        display: flex;
        align-items: center;
        gap: 10px;
        flex: 1 1 220px;
        min-width: 0;
      }
      .priority-controls {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .p-arrow-btn {
        width: 16px;
        height: 12px;
        border: 1px solid var(--pd-border, #71717a);
        background: var(--pd-card-bg, #15161a);
        color: var(--pd-text, #f4f4f6);
        font-size: 8px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
      }
      [data-theme="light"] .p-arrow-btn {
        background: #ffffff;
        color: #09090b;
        border-color: #000000;
      }
      .p-arrow-btn:hover:not(:disabled) {
        background: #6ee7b7;
        color: #000000;
        border-color: #000000;
      }
      .p-arrow-btn:disabled { opacity: 0.3; cursor: not-allowed; }

      .stamp-priority-index {
        width: 28px;
        height: 28px;
        background: var(--pd-surface-3, #282a33);
        color: var(--pd-text, #f4f4f6);
        border: 1.5px solid var(--pd-border, #71717a);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-weight: 900;
        font-size: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 1.5px 1.5px 0 var(--pd-shadow-ink, #000);
        flex-shrink: 0;
      }
      [data-theme="light"] .stamp-priority-index {
        background: #000000;
        color: #ffffff;
        border-color: #000000;
      }
      .stamp-priority-index::before {
        content: "#";
      }
      .account-name-block {
        min-width: 0;
      }
      .account-name-block h4 {
        font-size: 14.5px;
        font-weight: 800;
        margin: 0;
        color: var(--pd-text, #f4f4f6);
        overflow-wrap: anywhere;
      }
      [data-theme="light"] .account-name-block h4 {
        color: #09090b !important;
      }
      .account-sub-key {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11.5px;
        color: var(--pd-label, #a1a1aa);
        margin-top: 2px;
      }
      [data-theme="light"] .account-sub-key,
      [data-theme="light"] .account-sub-key .hint {
        color: #52525b !important;
      }

      /* PROXY JACK COMPACT DROPDOWN */
      .strip-proxy-cell {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .proxy-jack-details {
        position: relative;
        display: inline-block;
      }
      .proxy-jack-badge {
        padding: 5px 10px;
        border: 1.5px solid var(--pd-border, #71717a);
        background: var(--pd-card-bg, #15161a);
        color: var(--pd-text, #f4f4f6);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        font-weight: 800;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        box-shadow: 1.5px 1.5px 0 var(--pd-shadow-ink, #000);
        cursor: pointer;
        user-select: none;
        list-style: none;
      }
      [data-theme="light"] .proxy-jack-badge {
        background: #ffffff;
        color: #09090b;
        border-color: #000000;
      }
      .proxy-jack-icon {
        font-weight: 900;
      }
      .proxy-jack-icon.is-pool { color: #6ee7b7; }
      [data-theme="light"] .proxy-jack-icon.is-pool { color: #065f46; }
      .proxy-jack-icon.is-manual { color: #3b82f6; }
      [data-theme="light"] .proxy-jack-icon.is-manual { color: #2563eb; }
      .proxy-jack-icon.is-direct { color: var(--pd-label, #a1a1aa); }
      [data-theme="light"] .proxy-jack-icon.is-direct { color: #52525b; }
      .proxy-jack-badge::-webkit-details-marker { display: none; }
      .proxy-jack-menu {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        z-index: 50;
        background: var(--pd-card-bg, #15161a);
        border: 2px solid var(--pd-border, #71717a);
        box-shadow: 4px 4px 0 var(--pd-shadow-ink, #000);
        padding: 10px;
        min-width: 260px;
        max-width: calc(100vw - 48px);
      }
      [data-theme="light"] .proxy-jack-menu {
        background: #ffffff;
        border-color: #000000;
        color: #09090b;
      }
      .proxy-jack-menu-title {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        font-weight: 800;
        margin-bottom: 6px;
        text-transform: uppercase;
        color: var(--pd-label, #a1a1aa);
      }
      [data-theme="light"] .proxy-jack-menu-title {
        color: #52525b;
      }

      /* SLOT METER */
      .strip-slot-meter {
        background: var(--pd-card-bg, #15161a);
        border: 1.5px solid var(--pd-border, #71717a);
        color: var(--pd-text, #f4f4f6);
        padding: 5px 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        font-weight: 800;
        box-shadow: 1.5px 1.5px 0 var(--pd-shadow-ink, #000);
        flex-shrink: 0;
      }
      [data-theme="light"] .strip-slot-meter {
        background: #ffffff;
        border-color: #000000;
        color: #09090b !important;
      }
      .slot-meter-units {
        display: inline-flex;
        gap: 3px;
      }
      .meter-unit {
        width: 7px;
        height: 14px;
        background: var(--pd-surface-3, #282a33);
        border: 1px solid var(--pd-border, #71717a);
      }
      [data-theme="light"] .meter-unit {
        background: #f4f4f5;
        border: 1px solid #000000;
      }
      .meter-unit.on {
        background: #6ee7b7 !important;
        border-color: #000000 !important;
        box-shadow: 0 0 3px #6ee7b7;
      }
      [data-theme="light"] .meter-unit.on {
        background: #6ee7b7 !important;
        border-color: #000000 !important;
        box-shadow: none !important;
      }

      .strip-actions-group {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-wrap: wrap;
      }

      /* STATUS TAGS */
      .tag-status {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10.5px;
        font-weight: 900;
        text-transform: uppercase;
        padding: 4px 8px;
        border: 1.5px solid;
        box-shadow: 1.5px 1.5px 0 var(--pd-shadow-ink, #000);
        display: inline-block;
        flex-shrink: 0;
      }
      .tag-status-operational {
        background: #6ee7b7 !important;
        color: #000000 !important;
        border: 1.5px solid #000000 !important;
        font-weight: 900;
      }
      .tag-status-cooldown {
        background: #facc15 !important;
        color: #000000 !important;
        border: 1.5px solid #000000 !important;
        font-weight: 900;
      }
      .tag-status-exhausted {
        background: #7f1d1d;
        color: #f87171;
        border-color: #dc2626;
      }
      .tag-status-inactive {
        background: var(--pd-surface-3, #282a33);
        color: var(--pd-label, #a1a1aa);
        border-color: var(--pd-border, #71717a);
      }
      [data-theme="light"] .tag-status-operational {
        background: #6ee7b7 !important;
        color: #000000 !important;
        border: 1.5px solid #000000 !important;
        font-weight: 900;
      }
      [data-theme="light"] .tag-status-cooldown {
        background: #facc15 !important;
        color: #000000 !important;
        border: 1.5px solid #000000 !important;
        font-weight: 900;
      }
      [data-theme="light"] .tag-status-exhausted {
        background: #fee2e2 !important;
        color: #991b1b !important;
        border-color: #dc2626 !important;
      }
      [data-theme="light"] .tag-status-inactive {
        background: #f4f4f5 !important;
        color: #71717a !important;
        border-color: #d4d4d8 !important;
      }

      /* MODEL FLEET CATALOG */
      .model-sync-strip {
        padding: 10px 20px;
        border-bottom: 1.5px solid var(--pd-border-subtle, #383842);
        background: var(--pd-card-bg, #15161a);
      }
      .model-sync-strip .hint {
        margin-bottom: 0 !important;
      }
      [data-theme="light"] .model-sync-strip {
        background: #ffffff;
        border-bottom-color: #e4e4e7;
      }
      [data-theme="light"] .model-sync-strip .hint {
        color: #52525b !important;
      }
      .models-toolbar {
        padding: 12px 20px;
        background: var(--pd-card-bg, #15161a);
        border-bottom: 2px solid var(--pd-border, #71717a);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px 12px;
        flex-wrap: wrap;
      }
      [data-theme="light"] .models-toolbar {
        background: #ffffff;
        border-bottom-color: #000000;
      }
      .models-search-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 1 1 200px;
        max-width: 320px;
      }
      @media (max-width: 640px) {
        .models-search-wrap { max-width: 100%; flex: 1 1 100%; }
      }
      .search-cli-input {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        padding: 7px 12px;
        background: var(--pd-surface-2, #1e2026);
        border: 2px solid var(--pd-border, #71717a);
        color: var(--pd-text, #f4f4f6);
        box-shadow: 2px 2px 0 var(--pd-shadow-ink, #000);
        outline: none;
      }
      [data-theme="light"] .search-cli-input {
        background: #ffffff;
        color: #09090b;
        border-color: #000000;
      }
      .filter-pills-row {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .filter-pill {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        padding: 5px 10px;
        border: 1.5px solid var(--pd-border, #71717a);
        background: var(--pd-surface-2, #1e2026);
        color: var(--pd-text, #f4f4f6);
        cursor: pointer;
        box-shadow: 1.5px 1.5px 0 var(--pd-shadow-ink, #000);
      }
      .filter-pill:hover {
        background: var(--pd-surface-3, #282a33);
      }
      .filter-pill.active {
        background: #6ee7b7;
        color: #000000;
        border-color: #000000;
        font-weight: 900;
      }
      [data-theme="light"] .filter-pill {
        background: #ffffff;
        color: #09090b;
        border: 1.5px solid #000000;
      }
      [data-theme="light"] .filter-pill:hover {
        background: #f4f4f5;
      }
      [data-theme="light"] .filter-pill.active {
        background: #6ee7b7;
        color: #000000;
        border: 1.5px solid #000000;
      }

      /* CATALOG TABLE */
      .rack-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13.5px;
        border: none;
        background: transparent;
      }
      .rack-table th {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        text-align: left;
        padding: 12px 14px;
        text-wrap: balance;
        background: var(--pd-surface-2, #1e2026);
        color: var(--pd-label, #a1a1aa);
        border-bottom: 2px solid var(--pd-border, #71717a);
      }
      [data-theme="light"] .rack-table th {
        background: #f4f4f5 !important;
        border-bottom: 1.5px solid #000000 !important;
        color: #52525b !important;
      }
      .rack-table td {
        padding: 11px 14px;
        line-height: 1.45;
        border-bottom: 1.5px solid var(--pd-border-subtle, #383842);
        vertical-align: middle;
        color: var(--pd-text, #f4f4f6);
      }
      .rack-table td code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 13px;
        padding: 3px 7px;
      }
      [data-theme="light"] .rack-table td {
        border-bottom: 1.5px solid #e4e4e7;
        color: #09090b;
      }
      [data-theme="light"] .rack-table tr.muted td {
        color: #71717a;
      }
      .rack-table tbody tr:hover {
        background: var(--pd-surface-2, #1e2026);
      }
      [data-theme="light"] .rack-table tbody tr:hover {
        background: #f8fafc;
      }
      .rack-table tbody tr:last-child td {
        border-bottom: none;
      }

      /* Netralkan ikon capability reasoning agar tidak berwarna pink/merah di samping model ID */
      .rack-table .cap-icon.is-reasoning {
        color: #a1a1aa;
      }
      [data-theme="light"] .rack-table .cap-icon.is-reasoning {
        color: #52525b;
      }
      .rack-table .cap-icon.is-vision {
        color: #38bdf8;
      }
      [data-theme="light"] .rack-table .cap-icon.is-vision {
        color: #0284c7;
      }

      .source-builtin {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        color: var(--pd-label, #a1a1aa);
      }
      [data-theme="light"] .source-builtin {
        color: #52525b !important;
      }

      /* HARDWARE ROCKER TOGGLE SWITCH */
      .rocker-toggle {
        display: inline-flex;
        border: 2px solid #71717a;
        box-shadow: 2px 2px 0 #000000;
        cursor: pointer;
        padding: 0;
        background: none;
      }
      [data-theme="light"] .rocker-toggle {
        border: 2px solid #000000;
        box-shadow: 2px 2px 0 #000000;
      }
      .rocker-opt {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        font-weight: 900;
        text-transform: uppercase;
        padding: 4px 10px;
        background: #282a33;
        color: #a1a1aa;
      }
      [data-theme="light"] .rocker-opt {
        background: #f4f4f5;
        color: #71717a;
      }
      .rocker-opt.active {
        background: #ffffff !important;
        color: #000000 !important;
      }
      [data-theme="light"] .rocker-opt.active {
        background: #000000 !important;
        color: #ffffff !important;
      }

      /* CAPABILITY BADGES */
      .tag-fusion {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 10.5px;
        font-weight: 900;
        text-transform: uppercase;
        padding: 3px 7px;
        border: 1.5px solid #000000;
        box-shadow: 1.5px 1.5px 0 #000000;
        margin-left: 6px;
        display: inline-block;
        vertical-align: middle;
      }
      .tag-vision { background: #3b82f6; color: #ffffff; }
      .tag-thinking { background: #ffb3d9; color: #000000; }
      .tag-free { background: #ccff00 !important; color: #000000 !important; border: 1.5px solid #000000 !important; }
      .tag-custom { background: #fde047 !important; color: #000000 !important; border: 1.5px solid #000000 !important; }
      [data-theme="light"] .tag-custom { background: #fde047 !important; color: #000000 !important; border: 1.5px solid #000000 !important; }
      .tag-synced { background: var(--pd-surface-3, #282a33); color: var(--pd-text, #f4f4f6); border-color: var(--pd-border, #71717a); margin-left: 0; }
      [data-theme="light"] .tag-synced { background: #f4f4f5; color: #09090b; border-color: #000000; }
      .tag-imported { background: #facc15 !important; color: #000000 !important; border: 1.5px solid #000000 !important; margin-left: 0; }
      [data-theme="light"] .tag-imported { background: #facc15 !important; color: #000000 !important; border: 1.5px solid #000000 !important; }

      /* CUSTOM CHECKBOX 18x18 NEOBRUTALIST */
      .nb-check {
        -webkit-appearance: none !important;
        appearance: none !important;
        width: 18px !important;
        height: 18px !important;
        border: 2px solid var(--pd-border, #71717a) !important;
        background: var(--pd-card-bg, #15161a) !important;
        cursor: pointer !important;
        box-shadow: 1.5px 1.5px 0 var(--pd-shadow-ink, #000) !important;
        margin: 0 !important;
        padding: 0 !important;
        position: relative !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        outline: none !important;
        vertical-align: middle !important;
      }
      [data-theme="light"] .nb-check {
        border-color: #000000 !important;
        background: #ffffff !important;
      }
      .nb-check:checked {
        background: #6ee7b7 !important;
        border-color: #000000 !important;
      }
      .nb-check:checked::after {
        content: "" !important;
        display: block !important;
        width: 5px !important;
        height: 9px !important;
        border: solid #000000 !important;
        border-width: 0 2px 2px 0 !important;
        transform: rotate(45deg) !important;
        margin-top: -2px !important;
      }

      /* SUBNAV & HIGHLIGHTS */
      .subnav-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: var(--pd-surface-2, #1e2026);
        border: 2px solid var(--pd-border, #71717a);
        box-shadow: 3px 3px 0 var(--pd-shadow-ink, #000);
        margin-bottom: 20px;
        flex-wrap: wrap;
        gap: 10px;
      }
      .subnav-bar .detail-subnav {
        position: static;
        margin-bottom: 0;
        padding: 0;
        background: transparent;
        border: none;
        box-shadow: none;
      }
      .subnav-bar .back-link {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        font-weight: 800;
        color: var(--pd-text, #f4f4f6);
        text-decoration: none;
        text-transform: uppercase;
        background: transparent;
        border: none;
        box-shadow: none;
        padding: 2px 4px;
      }
      .subnav-bar .back-link:hover {
        color: #6ee7b7;
        background: transparent;
        transform: none;
        box-shadow: none;
      }
      [data-theme="light"] .subnav-bar .back-link {
        color: #09090b !important;
      }
      [data-theme="light"] .subnav-bar .back-link:hover {
        color: #09090b !important;
        text-decoration: underline;
      }
      .subnav-bar .anchor-pill,
      .anchor-pill {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
        padding: 4px 10px;
        border: 1.5px solid var(--pd-border, #71717a);
        background: var(--pd-card-bg, #15161a);
        color: var(--pd-text, #f4f4f6);
        text-decoration: none;
        box-shadow: 1.5px 1.5px 0 var(--pd-shadow-ink, #000);
      }
      [data-theme="light"] .subnav-bar .anchor-pill,
      [data-theme="light"] .anchor-pill {
        background: #f4f4f5;
        color: #09090b !important;
        border: 1.5px solid #000000;
      }
      .subnav-bar .anchor-pill:hover,
      .anchor-pill:hover {
        background: #6ee7b7;
        color: #000000 !important;
        border-color: #000000;
      }

      @media (max-width: 768px) {
        .chassis-header-top { padding: 16px; }
        .chassis-title h1, .chassis-title h2 { font-size: 18px; }
        .block-header-strip { padding: 10px 14px; }
        .channel-strips-wrapper { padding: 12px 14px; }
        .models-toolbar { padding: 10px 14px; }
        .rack-table th, .rack-table td { padding: 10px 12px; }
        .account-channel-strip { align-items: flex-start; }
        .strip-identity-left { flex: 1 1 100%; }
      }
    </style>

    <div class="subnav-bar">
      <a href="/dashboard/providers" class="back-link">&larr; Back to Providers Overview</a>
      <nav class="detail-subnav section-anchors" aria-label="Navigasi section" style="display: flex; gap: 6px; flex-wrap: wrap;">
        <a href="#ringkasan" class="anchor-pill">Chassis</a>
        <a href="#akun" class="anchor-pill">Auth Channels (${p.noAuth ? "0" : accounts.length})</a>
        <a href="#batas" class="anchor-pill">Batas &amp; Rotasi</a>
        <a href="#model" class="anchor-pill">Model Fleet (${totalModels})</a>
      </nav>
    </div>

    ${
      notice
        ? `<div class="notice ${notice.ok ? "notice-ok" : "notice-error"}" style="margin-bottom: 16px;"><span>${escapeHtml(
            notice.text
          )}</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : ""
    }

    ${
      isSession
        ? `<div class="notice notice-warning" style="margin-bottom: 16px;"><span>Akses ini memakai antarmuka web DeepSeek, bukan API resmi. Pemakaian di luar klien resmi bisa melanggar ketentuan layanan mereka dan berisiko pembatasan atau pemblokiran akun. Token setara akses penuh ke akun dan tersimpan sebagai teks biasa di database lokal. Gateway tidak menyediakan akun bersama: provider ini nonaktif sampai Anda menambahkan token sendiri, dan Anda memakai akun tersebut dengan risiko sendiri.</span></div>`
        : ""
    }

    <!-- BENTO 1 & 2 FUSION (CHASSIS + CONCURRENCY / EGRESS CONTROL) -->
    <div class="fusion-bento-grid" id="ringkasan">
      <!-- LEFT BENTO: HARDWARE CHASSIS HEADER -->
      <div class="card provider-chassis-card rack-chassis-card">
        <div class="hw-screw screw-tl"></div>
        <div class="hw-screw screw-tr"></div>
        <div class="hw-screw screw-bl"></div>
        <div class="hw-screw screw-br"></div>

        <div class="chassis-header-top">
          <div class="chassis-id-block">
            <div class="chassis-avatar-bezel">
              ${providerIconHtml(p, 36)}
            </div>
            <div class="chassis-title">
              <h2>${escapeHtml(p.name)}</h2>
              <div class="chassis-meta-line">
                <span>PREFIX: <code>${escapeHtml(alias)}/</code></span>
                <span>&middot;</span>
                <span>CATEGORY: ${p.category === "custom" ? "CUSTOM" : p.category === "free" ? "GRATIS" : p.category === "oauth" ? "OAUTH" : p.category === "session" ? "SESI BROWSER" : "API KEY"}</span>
                <span>&middot;</span>
                <span class="chassis-node-status">NODE: ${p.noAuth ? "NO-AUTH READY" : `${stats.healthy}/${stats.total} ACTIVE`}</span>
              </div>
            </div>
          </div>

          <div class="chassis-actions-top" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            ${
              !p.noAuth
                ? `<form action="/dashboard/providers/test-connection" method="POST" style="display:inline;margin:0;">
                  <input type="hidden" name="provider" value="${id}" />
                  <button type="submit" class="btn-nb">&#9889; Uji Koneksi</button>
                </form>`
                : ""
            }
            ${p.noAuth ? "" : `<button type="button" class="btn-nb btn-nb-primary" onclick="openModal('add-account-modal')">+ Tambah Akun</button>`}
            ${
              p.isCustom
                ? `<form action="/dashboard/providers/custom/delete" method="POST" style="display:inline;margin:0;" data-confirm="Hapus custom provider ini beserta semua akun dan modelnya?">
                  <input type="hidden" name="provider" value="${id}" />
                  <button type="submit" class="btn-nb btn-nb-danger">Hapus Custom Provider</button>
                </form>`
                : ""
            }
            ${p.keyUrl ? `<a class="btn-nb" href="${escapeHtml(p.keyUrl)}" target="_blank" rel="noopener noreferrer">${p.noAuth ? "API KEY (OPSIONAL)" : "BUAT API KEY"} &#8599;</a>` : ""}
          </div>
        </div>

        <!-- 4-CELL TELEMETRY STRIP -->
        <div class="chassis-telemetry-strip">
          <div class="telemetry-cell">
            <div class="telemetry-label">
              <span>AUTH CHANNELS</span>
              <span class="led-dot${stats.healthy > 0 || p.noAuth ? "" : " is-down"}"></span>
            </div>
            <div class="telemetry-value">
              ${p.noAuth ? "Siap (No-Auth)" : `${stats.healthy} / ${stats.total} Akun Aktif`}
            </div>
          </div>

          <div class="telemetry-cell">
            <div class="telemetry-label">
              <span>CONCURRENCY LOAD</span>
              <span class="telemetry-load-pct">${traffic.cap > 0 ? Math.round((traffic.inFlight / traffic.cap) * 100) : 0}%</span>
            </div>
            <div class="telemetry-value telemetry-load-value">
              ${traffic.inFlight}/${traffic.cap || effectiveConcurrency} dipakai
            </div>
          </div>

          <div class="telemetry-cell">
            <div class="telemetry-label">
              <span>EGRESS TOPOLOGY</span>
              <span>${activePoolCount > 0 ? `${activePoolCount} POOLS` : "DIRECT"}</span>
            </div>
            <div class="telemetry-value">
              ${
                p.noAuth
                  ? (proxyRotationStrategy !== "off"
                      ? `Rotasi (${proxyRotationStrategy === "round_robin" ? "Bergiliran" : "Acak"})`
                      : (boundPools.length > 0 ? `Bound (${escapeHtml(boundPools[0].name)})` : "Direct"))
                  : (activePoolCount > 0 ? `${activePoolCount} Pools` : "Direct (Tanpa Proxy)")
              }
            </div>
          </div>

          <div class="telemetry-cell">
            <div class="telemetry-label">
              <span>MODEL DIRECTORY</span>
              <span>${p.freeModelSync || p.catalogRefresh ? "SYNCED" : "STATIC"}</span>
            </div>
            <div class="telemetry-value">${totalModels} Model</div>
          </div>
        </div>
      </div>

      <!-- RIGHT BENTO: RACK CONCURRENCY & LIMITS MODULE -->
      <div class="card rack-control-module" id="batas">
        <div class="hw-screw screw-tl"></div>
        <div class="hw-screw screw-tr"></div>
        <div class="hw-screw screw-bl"></div>
        <div class="hw-screw screw-br"></div>

        ${
          !p.noAuth
            ? `
        <div>
          <div class="module-title-bar">
            <span>Batas Sesi Paralel</span>
            <div style="display: flex; gap: 4px; align-items: center;">
              <span class="badge-tag">${escapeHtml(String(effectiveConcurrency))} per akun</span>
              ${traffic.accounts.length > 0 ? `<span class="badge-tag">${traffic.inFlight}/${traffic.cap} dipakai</span>${traffic.queue > 0 ? ` <span class="badge-tag" style="background:#facc15;color:#000;">${traffic.queue} antre</span>` : ""}` : ""}
            </div>
          </div>

          <form action="/dashboard/providers/concurrency" method="POST" id="concurrency-form" style="margin: 0;">
            <input type="hidden" name="provider" value="${id}" />
            <div class="stepper-control-box">
              <div class="stepper-label">Maksimal request serentak per akun</div>
              <div class="arcade-stepper-row">
                <button type="button" class="arcade-btn" onclick="stepDownConcurrency()">-</button>
                <span class="arcade-display-number" id="stepper-val">${effectiveConcurrency}</span>
                <button type="button" class="arcade-btn" onclick="stepUpConcurrency()">+</button>
              </div>
              <input type="number" id="provider-concurrency" name="concurrency" min="1" max="10" step="1" value="${escapeHtml(String(concurrencySetting || effectiveConcurrency))}" placeholder="${escapeHtml(String(concurrencyPlaceholder))}" style="display:none;" />
            </div>

            <div class="queue-info-card">
              <strong>FAILOVER TIMEOUT:</strong> ${Math.round((queueTimeoutMs ?? 30000) / 1000)}.00s queue limit. Request di atas batas menunggu antrean router.
              ${traffic.serialTurns ? "<br/><em>Turn serial: 1 turn bergiliran per akun.</em>" : ""}
            </div>

            <button type="submit" class="btn-nb btn-nb-concurrency" style="width: 100%; justify-content: center; font-size: 12px; font-weight: 800; text-transform: uppercase; padding: 8px 14px;">
              SIMPAN BATAS CONCURRENCY
            </button>
          </form>
        </div>`
            : `
        <div>
          <div class="module-title-bar">
            <span>Rotasi Proxy</span>
            <span class="badge-tag">NO-AUTH</span>
          </div>

          ${p.id === "opencode" ? `
          <form action="/dashboard/providers/proxy-rotation" method="POST" style="margin-bottom: 12px;">
            <input type="hidden" name="provider" value="opencode" />
            <div class="stepper-label" style="margin-bottom: 4px;">Kebijakan Egress OpenCode</div>
            <select id="opencode-egress-policy" name="egress_policy" class="search-cli-input" style="width: 100%; margin-bottom: 6px;">
              ${["legacy", "direct", "prefer", "require"].map((mode) => `<option value="${mode}" ${getOpencodeEgressPolicy() === mode ? "selected" : ""}>${mode}</option>`).join("")}
            </select>
            <div class="stepper-label" style="margin-bottom: 4px;">ID Proxy Pool (Koma)</div>
            <input id="opencode-pool-ids" name="pool_ids" class="search-cli-input" style="width: 100%; margin-bottom: 8px;" value="${escapeHtml(getOpencodeScopedPoolIds().join(","))}" />
            <button type="submit" class="btn-nb btn-nb-concurrency" style="width: 100%; justify-content: center; margin-bottom: 8px; font-size: 12px; font-weight: 800; text-transform: uppercase; padding: 8px 14px;">SIMPAN KEBIJAKAN</button>
          </form>` : ""}

          <form action="/dashboard/providers/proxy-rotation" method="POST" style="margin: 0;">
            <input type="hidden" name="provider" value="${id}" />
            <div class="stepper-control-box">
              <div class="stepper-label" style="margin-bottom: 6px;">Strategi Rotasi Proxy Pool</div>
              <select id="proxy-rotation-strategy" name="strategy" class="search-cli-input" style="width: 100%;">
                <option value="off" ${proxyRotationStrategy === "off" ? "selected" : ""}>Tidak aktif</option>
                <option value="round_robin" ${proxyRotationStrategy === "round_robin" ? "selected" : ""}>Bergiliran</option>
                <option value="random" ${proxyRotationStrategy === "random" ? "selected" : ""}>Acak</option>
              </select>
            </div>

            <div class="queue-info-card">
              <strong>EGRESS ROUTING:</strong> Saat aktif, setiap request ke provider ini memakai proxy aktif dari Proxy Pool dan failover maksimal 3x per request.
            </div>

            <button type="submit" class="btn-nb btn-nb-concurrency" style="width: 100%; justify-content: center; font-size: 12px; font-weight: 800; text-transform: uppercase; padding: 8px 14px;">
              SIMPAN STRATEGI
            </button>
          </form>
        </div>`
        }
      </div>
    </div>

    <!-- SECTION 2: ACCOUNTS ROSTER (CHANNEL STRIPS) -->
    <div class="card channel-strips-card" id="akun">
      <div class="hw-screw screw-tl"></div>
      <div class="hw-screw screw-tr"></div>
      <div class="hw-screw screw-bl"></div>
      <div class="hw-screw screw-br"></div>

      <div class="block-header-strip">
        <div class="block-header-title">
          <span>AUTHENTICATION ROSTER${p.noAuth ? "" : ` (${accounts.length})`}</span>
          <span class="badge-tag">PRIORITY STACK</span>
        </div>
        <div class="block-header-sub">
          Prioritas dari atas ke bawah saat jenuh atau cooldown.
        </div>
      </div>

      <!-- Hidden accessibility table header for tests and screen readers -->
      <table class="sr-only" style="display:none;" aria-hidden="true">
        <thead>
          <tr>
            <th>Urutan</th>
            <th>Nama</th>
            <th>Auth</th>
            <th>Proxy</th>
            <th>Status</th>
            <th>Slot</th>
            ${isSession ? "<th>Sesi</th>" : ""}
            <th></th>
          </tr>
        </thead>
      </table>

      ${accountsBody}
    </div>

    <!-- SECTION 3: MODEL FLEET DIRECTORY -->
    <div class="card model-fleet-card" id="model">
      <div class="hw-screw screw-tl"></div>
      <div class="hw-screw screw-tr"></div>
      <div class="hw-screw screw-bl"></div>
      <div class="hw-screw screw-br"></div>

      <div class="block-header-strip">
        <div class="block-header-title">
          <span>MODEL DIRECTORY (${totalModels} MODELS)</span>
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          ${
            hasImported
              ? `<form action="/dashboard/providers/models/import/clear" method="POST" style="margin: 0;" data-confirm="Hapus semua model hasil import?">
            <input type="hidden" name="provider" value="${id}" />
            <button type="submit" class="btn-nb btn-nb-danger" style="padding: 5px 12px; font-size: 11px;">Bersihkan Impor</button>
          </form>`
              : ""
          }
          ${
            p.freeModelSync || p.catalogRefresh
              ? `<form action="/dashboard/providers/models/sync" method="POST" style="margin: 0;">
            <input type="hidden" name="provider" value="${id}" />
            <button type="submit" class="btn-nb" style="padding: 5px 12px; font-size: 11px;">&#8635; Sinkron Sekarang</button>
          </form>`
              : ""
          }
          ${importModes.length > 0 ? `<button type="button" class="btn-nb" style="padding: 5px 12px; font-size: 11px;" onclick="openModal('import-models-modal')">Import Models</button>` : ""}
          <button type="button" class="btn-nb btn-nb-neon" style="padding: 5px 12px; font-size: 11px;" onclick="openModal('add-model-modal')">+ Add Custom Model</button>
        </div>
      </div>

      ${
        p.freeModelSync || p.catalogRefresh
          ? `<div class="model-sync-strip">
              ${syncSummary(p)}
              <p class="hint" style="margin-top: 0.25rem; font-size: 0.8rem;">${
                p.catalogRefresh
                  ? "Sinkron mencocokkan daftar model dengan katalog provider dan menyembunyikan model bawaan yang sudah tidak ada di sana."
                  : "Sinkron mengambil daftar model gratis resmi dari provider."
              }${importModes.length > 0 ? " Import menambahkan model live dari akun Anda." : ""}</p>
            </div>`
          : ""
      }

      <!-- Live Search & Filter Bar -->
      <div class="models-toolbar">
        <div class="models-search-wrap">
          <input type="text" id="model-filter-input" placeholder="$ filter model route..." class="search-cli-input" style="width: 100%;" oninput="filterModelsTable()" />
        </div>
        <div class="filter-pills-row">
          <button type="button" class="filter-pill active" data-cat-filter="all" onclick="setCategoryFilter('all', this)">Semua (${totalModels})</button>
          ${freeCount > 0 ? `<button type="button" class="filter-pill" data-cat-filter="free" onclick="setCategoryFilter('free', this)">Gratis (${freeCount})</button>` : ""}
          ${thinkingCount > 0 ? `<button type="button" class="filter-pill" data-cat-filter="thinking" onclick="setCategoryFilter('thinking', this)">Reasoning (${thinkingCount})</button>` : ""}
          ${visionCount > 0 ? `<button type="button" class="filter-pill" data-cat-filter="vision" onclick="setCategoryFilter('vision', this)">Vision (${visionCount})</button>` : ""}
          ${customCount > 0 ? `<button type="button" class="filter-pill" data-cat-filter="custom" onclick="setCategoryFilter('custom', this)">Kustom (${customCount})</button>` : ""}
        </div>
        <div style="display: flex; gap: 6px; align-items: center; margin-left: auto; flex-wrap: wrap;">
          <button type="button" class="btn-nb" data-select-mode-toggle="models" style="padding: 5px 12px; font-size: 11px;">Pilih Model</button>
          <button type="submit" class="btn-nb" form="models-bulk-form" formaction="/dashboard/providers/models/enable" data-requires-selection="models" disabled style="padding: 5px 12px; font-size: 11px;">Aktifkan Terpilih (<span data-selected-count="models">0</span>)</button>
          <button type="submit" class="btn-nb" form="models-bulk-form" formaction="/dashboard/providers/models/disable" data-requires-selection="models" disabled style="padding: 5px 12px; font-size: 11px;">Nonaktifkan Terpilih (<span data-selected-count="models">0</span>)</button>
          ${
            hasImported
              ? `<button type="submit" class="btn-nb btn-nb-danger" form="models-bulk-form" formaction="/dashboard/providers/models/import/delete" data-requires-selection="models" disabled data-confirm-selected="model_ids" data-confirm-noun="model hasil import" style="padding: 5px 12px; font-size: 11px;">Hapus Terpilih (<span data-selected-count="models">0</span>)</button>`
              : ""
          }
        </div>
      </div>

      <form id="models-bulk-form" method="POST">
        <input type="hidden" name="provider" value="${id}" />
      </form>

      <div style="overflow-x: auto;">
        <table class="rack-table" data-sync-row="models">
          <thead>
            <tr>
              <th style="width: 32px;" class="select-cell">
                <input type="checkbox" data-select-all="models" autocomplete="off" aria-label="Pilih semua model" title="Pilih semua model" class="nb-check" onchange="toggleAllModels(this)" />
              </th>
              <th>MODEL ID &amp; CAPABILITIES</th>
              <th>NAMA RESMI</th>
              <th>SUMBER</th>
              <th>STATUS</th>
              <th style="text-align: right;">SWITCH OPERASIONAL</th>
            </tr>
          </thead>
          <tbody id="models-tbody">${modelRows}</tbody>
        </table>
      </div>
    </div>

    ${p.noAuth ? "" : renderAddAccountModal(p)}

    ${importModal}

    <div class="modal-backdrop" id="add-model-modal">
      <div class="modal">
        <h3>Add Custom Model</h3>
        <form action="/dashboard/providers/models/custom/add" method="POST">
          <input type="hidden" name="provider" value="${id}" />
          <div class="field">
            <label for="model_id">Model ID</label>
            <input type="text" id="model_id" name="model_id" placeholder="contoh: deepseek-chat, claude-3-5-sonnet" required />
          </div>
          <div class="field">
            <label for="model_name">Display Name (Optional)</label>
            <input type="text" id="model_name" name="name" />
          </div>
          <p class="hint">Pastikan Model ID valid di upstream provider. Dipanggil lewat <code>${escapeHtml(alias)}/&lt;model-id&gt;</code>.</p>
          <div class="modal-actions">
            <button type="button" class="btn" data-close-modal="add-model-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Add Model</button>
          </div>
        </form>
      </div>
    </div>

    <script>
      var currentConcurrency = ${effectiveConcurrency};
      function stepUpConcurrency() {
        if (currentConcurrency < 10) {
          currentConcurrency++;
          updateConcurrencyUI();
        }
      }
      function stepDownConcurrency() {
        if (currentConcurrency > 1) {
          currentConcurrency--;
          updateConcurrencyUI();
        }
      }
      function updateConcurrencyUI() {
        var disp = document.getElementById("stepper-val");
        var input = document.getElementById("provider-concurrency");
        if (disp) disp.textContent = currentConcurrency;
        if (input) input.value = currentConcurrency;
      }

      function filterModelsTable() {
        var input = document.getElementById("model-filter-input");
        var q = (input ? input.value : "").toLowerCase();
        var activePill = document.querySelector(".filter-pills-row .filter-pill.active");
        var cat = activePill ? (activePill.getAttribute("data-cat-filter") || "all") : "all";
        var rows = document.querySelectorAll('table[data-sync-row="models"] tbody tr.model-row');
        rows.forEach(function(r) {
          var textMatch = r.textContent.toLowerCase().includes(q);
          var rowCats = (r.getAttribute("data-cat") || "").split(" ");
          var catMatch = (cat === "all") || rowCats.includes(cat);
          r.style.display = (textMatch && catMatch) ? "" : "none";
        });
      }

      function setCategoryFilter(cat, btn) {
        document.querySelectorAll(".filter-pills-row .filter-pill").forEach(function(p) { p.classList.remove("active"); });
        if (btn) btn.classList.add("active");
        filterModelsTable();
      }

      function toggleAllModels(master) {
        document.querySelectorAll('input[data-select-group="models"]').forEach(function(c) {
          c.checked = master.checked;
          c.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
    </script>
  `;

  return renderLayout({ title: p.name, activeTab: "providers", content, port, lang: currentLang });
}

/** Manual paste: an API key, or a token the provider's login would normally produce. */
export async function handleAddAccount(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || "").trim());
  const name = String(body.name || "").trim() || `${provider?.name || "Provider"} Account`;
  const secret = String(body.api_key || "").trim();
  const refreshToken = String(body.refresh_token || "").trim();
  const proxy_url = body.proxy_url ? String(body.proxy_url).trim() : "";
  // Form baru memakai proxy_choice; form lama (zrCopyAccount) hanya mengirim proxy_url.
  const choice = body.proxy_choice !== undefined ? String(body.proxy_choice) : null;
  let proxy_pool_id = null;
  let manualUrl = "";
  if (choice === null || choice === "manual") {
    manualUrl = proxy_url;
  } else if (choice.startsWith("pool:")) {
    proxy_pool_id = Number(choice.slice(5)) || null;
  }
  // choice "" (koneksi langsung) mengabaikan proxy_url yang ikut terkirim.
  const proxyError = manualUrl ? validateProxyAddress(manualUrl) : null;
  const poolMissing = proxy_pool_id && !getProxyPoolById(proxy_pool_id);

  if (proxyError || poolMissing) return c.redirect(`${backTo(body.provider)}?notice=proxy_invalid`);

  // Browser-session providers store the web token and cookies; they never get an
  // api_key, and they have no OAuth refresh flow.
  if (provider && (provider.authMethods || []).includes("session")) {
    const token = String(body.token || "").trim();
    if (!token) return c.redirect(`${backTo(body.provider)}?notice=session_token_missing`);
    if (findSessionAccount(provider.id, token)) return c.redirect(`${backTo(body.provider)}?notice=account_exists`);
    addConnection({
      provider: provider.id,
      name,
      auth_type: "session",
      credentials: { token, cookies: String(body.cookies || "").trim() },
      proxy_url: manualUrl || null,
      proxy_pool_id,
    });
    return c.redirect(`${backTo(body.provider)}?notice=account_added`);
  }

  if (provider && !provider.noAuth && secret) {
    // Anthropic console keys are plain API keys (x-api-key), not OAuth tokens.
    const oauth = usesLogin(provider) && !(provider.id === "claude" && secret.startsWith("sk-ant-api"));
    let credentials = { api_key: secret };
    if (oauth && provider.id === "github" && /^gh[oup]_/.test(secret)) {
      // A GitHub token only mints Copilot tokens; expiry 1 makes the gateway mint one before the first request.
      credentials = { github_token: secret, access_token: "", expires_at: 1 };
    } else if (oauth) {
      credentials = { access_token: secret };
      if (refreshToken && REFRESHABLE.has(provider.id)) credentials.refresh_token = refreshToken;
    }
    addConnection({
      provider: provider.id,
      name,
      auth_type: oauth ? "oauth" : "apikey",
      credentials,
      proxy_url: manualUrl || null,
      proxy_pool_id,
    });
    return c.redirect(`${backTo(body.provider)}?notice=account_added`);
  }
  return c.redirect(backTo(body.provider));
}

export async function handleSetAccountProxy(c) {
  const body = await c.req.parseBody();
  const id = Number(body.id);
  const provider = String(body.provider || "");
  if (!getConnectionById(id)) return c.redirect(backTo(provider));

  const choice = String(body.proxy_choice || "");
  if (choice.startsWith("pool:")) {
    const pool = getProxyPoolById(Number(choice.slice(5)));
    if (!pool) return c.redirect(`${backTo(provider)}?notice=proxy_invalid`);
    // Alamat manual dipertahankan; prioritas daftar membuatnya tidak berpengaruh.
    updateConnection(id, { proxy_pool_id: pool.id });
    return c.redirect(`${backTo(provider)}?notice=proxy_updated`);
  }
  if (choice === "manual") {
    const manual = String(body.proxy_url || "").trim();
    if (validateProxyAddress(manual)) return c.redirect(`${backTo(provider)}?notice=proxy_invalid`);
    updateConnection(id, { proxy_pool_id: null, proxy_url: manual });
    return c.redirect(`${backTo(provider)}?notice=proxy_updated`);
  }
  updateConnection(id, { proxy_pool_id: null, proxy_url: null });
  return c.redirect(`${backTo(provider)}?notice=proxy_updated`);
}

export async function handleSetProxyRotation(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || "").trim());
  if (!provider || !provider.noAuth) return c.redirect("/dashboard/providers");

  if (provider.id === "opencode" && body.egress_policy !== undefined) {
    const policy = String(body.egress_policy);
    const raw = String(body.pool_ids || "").trim();
    const ids = raw ? raw.split(",").map((part) => Number(part.trim())) : [];
    if (!["legacy", "direct", "prefer", "require"].includes(policy) || ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || !getProxyPoolById(id))) return c.redirect(`${backTo(provider.id)}?notice=rotation_invalid`);
    setSetting("opencode_proxy_pool_ids", JSON.stringify([...new Set(ids)]));
    setSetting("opencode_egress_policy", policy);
    return c.redirect(`${backTo(provider.id)}?notice=rotation_updated`);
  }
  const strategy = String(body.strategy || "");
  if (strategy === "off" || strategy === "round_robin" || strategy === "random") {
    setProxyRotationStrategy(provider.id, strategy);
    return c.redirect(`${backTo(provider.id)}?notice=rotation_updated`);
  }
  return c.redirect(`${backTo(provider.id)}?notice=rotation_invalid`);
}

export async function handleSetProviderConcurrency(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || "").trim());
  if (!provider || provider.noAuth) return c.redirect("/dashboard/providers");

  const raw = String(body.concurrency ?? "").trim();
  const key = `provider_concurrency:${provider.id}`;
  if (!raw) {
    deleteSetting(key);
    return c.redirect(`${backTo(provider.id)}?notice=concurrency_updated`);
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    return c.redirect(`${backTo(provider.id)}?notice=concurrency_invalid`);
  }
  setSetting(key, String(value));
  return c.redirect(`${backTo(provider.id)}?notice=concurrency_updated`);
}

export async function handleMoveAccount(c) {
  const body = await c.req.parseBody();
  const id = Number(body.id);
  const direction = String(body.direction || "");
  // Redirect by the account's own provider: the form field is only a hint and
  // must not decide which provider page the user lands on.
  const connection = id ? getConnectionById(id) : null;
  if (!connection) return c.redirect(backTo(body.provider));
  const moved = moveConnection(id, direction);
  return c.redirect(moved ? `${backTo(connection.provider)}?notice=account_moved` : backTo(connection.provider));
}

export async function handleDeleteAccount(c) {
  const body = await c.req.parseBody();
  const id = Number(body.id);
  if (id) {
    const connection = getConnectionById(id);
    if (connection) forgetSessionHealth(connection);
    deleteConnection(id);
  }
  return c.redirect(`${backTo(body.provider)}?notice=account_deleted`);
}

/** "Periksa sesi": probe the token now, ignoring the cached verdict. */
export async function handleCheckSession(c) {
  const body = await c.req.parseBody();
  const connection = getConnectionById(Number(body.id));
  const provider = getProvider(String(body.provider || "").trim());
  if (!connection || !provider || connection.provider !== provider.id) return c.redirect("/dashboard/providers");

  const result = await checkSessionHealth(connection);
  return c.redirect(`${backTo(provider.id)}?notice=session_${result.status}`);
}

/** "Perbarui sesi": replace the web token and cookies without touching the proxy. */
export async function handleUpdateSession(c) {
  const body = await c.req.parseBody();
  const connection = getConnectionById(Number(body.id));
  const provider = getProvider(String(body.provider || "").trim());
  if (!connection || !provider || connection.provider !== provider.id) return c.redirect("/dashboard/providers");

  const token = String(body.token || "").trim();
  if (!token) return c.redirect(`${backTo(provider.id)}?notice=session_token_missing`);

  updateConnection(connection.id, {
    credentials: {
      ...(connection.credentials || {}),
      token,
      cookies: String(body.cookies || "").trim(),
    },
  });
  // The old verdict was keyed on the old token and must not survive.
  forgetSessionHealth(connection);
  return c.redirect(`${backTo(provider.id)}?notice=session_updated`);
}

export async function handleAddCustomModel(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || ""));
  const modelId = String(body.model_id || "").trim();
  if (provider && modelId) {
    addCustomModel({ provider: provider.id, model_id: modelId, name: String(body.name || "").trim() || null });
    return c.redirect(`${backTo(body.provider)}?notice=custom_added`);
  }
  return c.redirect(backTo(body.provider));
}

export async function handleDeleteCustomModel(c) {
  const body = await c.req.parseBody();
  const id = Number(body.id);
  if (id) deleteCustomModel(id);
  return c.redirect(`${backTo(body.provider)}?notice=custom_deleted`);
}

export async function handleTestConnection(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || ""));
  if (!provider) return c.redirect("/dashboard/providers");

  const connectionId = Number(body.id);
  const connection = connectionId ? getConnectionById(connectionId) : null;

  const result = await testConnection(provider.id, { connection });
  if (result.ok) {
    const msgParam = result.details ? `&msg=${encodeURIComponent(result.details)}` : "";
    return c.redirect(`${backTo(provider.id)}?notice=test_ok${msgParam}`);
  }

  const errParam = encodeURIComponent(result.error || "koneksi gagal");
  return c.redirect(`${backTo(provider.id)}?notice=test_fail&msg=${errParam}`);
}

export async function handleImportModels(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || ""));
  if (!provider) return c.redirect("/dashboard/providers");

  const mode = body.mode === "free" ? "free" : "all";
  const result = await importProviderModels(provider.id, mode);
  // Imported rows are candidates for the managed combos, so rebuild before redirect.
  if (result.code === "imported") await rebuildManagedCombos();
  const params = new URLSearchParams({ import: result.code, count: String(result.count) });
  if (result.status) params.set("status", String(result.status));
  return c.redirect(`${providerUrl(provider.id)}?${params}`);
}

export async function handleDeleteImported(c) {
  const body = await c.req.parseBody({ all: true });
  const provider = getProvider(String([].concat(body.provider || "")[0]));
  if (!provider) return c.redirect("/dashboard/providers");

  const ids = [].concat(body.model_ids || []).map((v) => String(v)).filter(Boolean);
  const removed = ids.length > 0 ? deleteImportedModels(provider.id, ids) : 0;
  return c.redirect(`${providerUrl(provider.id)}?import=deleted&count=${removed}`);
}

export async function handleSyncFreeModels(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || ""));
  if (!provider) return c.redirect("/dashboard/providers");

  const result = provider.freeModelSync ? await syncFreeModels(provider.id) : await refreshProviderCatalog(provider.id);
  // The combo lists are built from the available models, so a fresh catalog has to
  // be reflected before the redirect lands on the page that reads them.
  if (result.code === "synced" || result.code === "refreshed") await rebuildManagedCombos();
  // A catalog-only refresh reports what it retired; a free sync reports its list.
  const count = provider.freeModelSync ? result.count || 0 : result.retired || 0;
  const params = new URLSearchParams({ sync: result.code, count: String(count) });
  if (result.retired > 0) params.set("retired", String(result.retired));
  if (result.status) params.set("status", String(result.status));
  return c.redirect(`${providerUrl(provider.id)}?${params}`);
}

export async function handleClearImported(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || ""));
  if (!provider) return c.redirect("/dashboard/providers");
  clearImportedModels(provider.id);
  return c.redirect(`${providerUrl(provider.id)}?import=cleared`);
}

export async function handleDisableModel(c) {
  const body = await c.req.parseBody({ all: true });
  const provider = getProvider(String([].concat(body.provider || "")[0]));
  if (!provider) return c.redirect("/dashboard/providers");

  const ids = [].concat(body.model_ids || body.model_id || []).map((v) => String(v)).filter(Boolean);
  const count = ids.length > 0 ? disableModels(provider.id, ids) : 0;
  const countParam = ids.length > 1 ? `&count=${ids.length}` : "";
  return c.redirect(`${backTo(provider.id)}?notice=model_disabled${countParam}`);
}

export async function handleEnableModel(c) {
  const body = await c.req.parseBody({ all: true });
  const provider = getProvider(String([].concat(body.provider || "")[0]));
  if (!provider) return c.redirect("/dashboard/providers");

  const ids = [].concat(body.model_ids || body.model_id || []).map((v) => String(v)).filter(Boolean);
  const count = ids.length > 0 ? enableModels(provider.id, ids) : 0;
  const countParam = ids.length > 1 ? `&count=${ids.length}` : "";
  return c.redirect(`${backTo(provider.id)}?notice=model_enabled${countParam}`);
}

export async function handleAddCustomProvider(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const prefix = String(body.prefix || "").trim().toLowerCase();
  const baseUrl = String(body.base_url || "").trim();
  const apiType = String(body.api_type || "openai").trim().toLowerCase();
  const customHeaders = String(body.custom_headers || "").trim();

  if (!name || !prefix || !baseUrl) {
    return c.redirect("/dashboard/providers?notice=custom_provider_invalid");
  }

  // Cek apakah prefix sudah dipakai oleh provider statis atau custom lain
  const existing = getProvider(prefix);
  if (existing) {
    return c.redirect("/dashboard/providers?notice=custom_provider_conflict");
  }

  try {
    let headersObj = {};
    if (customHeaders) {
      try {
        headersObj = JSON.parse(customHeaders);
      } catch {
        // jika bukan JSON valid, abaikan
      }
    }

    const created = createCustomProvider({
      id: `cp_${prefix}`,
      name,
      prefix,
      baseUrl,
      apiType: apiType === "claude" ? "claude" : "openai",
      customHeaders: headersObj,
    });

    if (!created) {
      return c.redirect("/dashboard/providers?notice=custom_provider_invalid");
    }

    return c.redirect(`/dashboard/providers/${encodeURIComponent(created.id)}?notice=custom_provider_added`);
  } catch (err) {
    return c.redirect("/dashboard/providers?notice=custom_provider_invalid");
  }
}

export async function handleDeleteCustomProvider(c) {
  const body = await c.req.parseBody();
  const providerId = String(body.provider || "").trim();
  const provider = getProvider(providerId);

  if (!provider || !provider.isCustom) {
    return c.redirect("/dashboard/providers");
  }

  deleteCustomProvider(provider.id);
  return c.redirect("/dashboard/providers?notice=custom_provider_deleted");
}

