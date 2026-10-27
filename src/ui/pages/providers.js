import {
  getConnections,
  addConnection,
  deleteConnection,
  moveConnection,
  getConnectionById,
  updateConnection,
  getProxyPoolById,
} from "../../db/index.js";
import { getAllProviders, getProvider, getProviderModels } from "../../providers/index.js";
import { isConnectionFullyCooledDown } from "../../services/auth.js";
import { getProviderTraffic } from "../../services/trafficGuard.js";
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
import { syncFreeModels, getSyncIntervalMs } from "../../services/modelSync.js";
import { getOAuthFlow } from "../../services/oauth/providers.js";
import { hasLocalImport } from "../../services/oauth/flows.js";
import { FREE_TIER_BUDGETS, FREE_TIER_TOS } from "../../config/freeTierCatalog.js";
import { renderLayout, capabilityIcons } from "../layout.js";
import { renderCombosContent } from "./combos.js";
import {
  maskProxyUrl,
  listProxyPools,
  validateProxyAddress,
  getProxyRotationStrategy,
  setProxyRotationStrategy,
} from "../../services/proxyPools.js";
import { escapeHtml } from "../html.js";
import { getSetting, setSetting, deleteSetting } from "../../services/settings.js";
import { getProviderIconPath } from "../assets.js";

const SECTIONS = [
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
function importNotice(query = {}) {
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
  const status = Number.parseInt(query.status, 10);
  const httpSuffix = Number.isFinite(status) ? ` (HTTP ${status})` : "";
  switch (query.sync) {
    case "synced":
      return { ok: true, text: `Sinkron selesai: ${count} model gratis.` };
    case "empty":
      return { ok: false, text: "Sinkron gagal: provider tidak mengembalikan model gratis. Daftar sebelumnya tetap dipakai." };
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
  if (query.notice === "test_ok") return { ok: true, text: "Koneksi provider berhasil." };
  if (query.notice === "test_fail") {
    return { ok: false, text: "Koneksi provider gagal: " + escapeHtml(String(query.msg || "tidak diketahui")) };
  }
  if (query.notice === "test_no_base") return { ok: false, text: "Provider ini tidak memiliki endpoint untuk diuji." };
  return null;
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

/** One-line sync status for providers with freeModelSync. */
function syncSummary(p) {
  const state = getModelSyncState(p.id);
  const hours = getSyncIntervalMs() / 3_600_000;
  const schedule = hours > 0 ? `Model gratis disinkron otomatis tiap ${hours} jam.` : "Sinkron otomatis dimatikan (ZENITH_MODEL_SYNC_INTERVAL_HOURS=0).";
  const fallback = p.freeModelSync === "replace" ? "memakai daftar bawaan" : "hanya daftar bawaan yang tampil";

  let status;
  if (!state?.last_success_at) status = `Belum pernah berhasil sinkron, ${fallback}.`;
  else status = `Terakhir sinkron ${formatWib(state.last_success_at)} (${state.count} model).`;

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
  if (p.noAuth) return `<span class="pill pill-success">Siap</span>`;
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
export function renderProvidersPage(port = 20120, query = {}) {
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
        return `
      <a class="card provider-card" href="${providerUrl(p.id)}">
        <div class="provider-card-head">
          <div class="provider-title">
            ${providerIconHtml(p, 32)}
            <div class="provider-text">
              <h3>${escapeHtml(p.name)}</h3>
              <p class="hint"><code>${escapeHtml(primaryAlias(p))}/</code> &middot; ${countProviderModels(
                p,
                allImported.filter((m) => m.provider === p.id),
                allCustom.filter((m) => m.provider === p.id)
              )} model</p>
            </div>
          </div>
          ${statusPill(p, stats, byProvider.get(p.id) || [])}
        </div>
        ${s.category === "free" ? `<div class="pill-row">${freeTierPills(p.id)}</div>` : ""}
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
    <div class="page-tabs">
      <a class="page-tab ${activeTab === "providers" ? "active" : ""}" href="/dashboard/providers">Providers</a>
      <a class="page-tab ${activeTab === "combos" ? "active" : ""}" href="/dashboard/providers?tab=combos">Combos</a>
    </div>`;

  const content =
    activeTab === "combos"
      ? tabBar + renderCombosContent(query)
      : tabBar + sections;

  return renderLayout({
    title:
      activeTab === "combos"
        ? "Combos"
        : activeTab === "proxy"
          ? "Proxy — Zenith Router"
          : "Providers",
    activeTab: "providers",
    content,
    port,
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
 * Account row priority cell: the #n badge plus up/down controls, the same
 * pattern as a combo chain. A lone account has nothing to reorder against.
 */
function accountOrderCell(c, id, index, total) {
  const badge = `<span class="priority-badge" title="Prioritas #${index + 1}">${index + 1}</span>`;
  if (total < 2) return `<div class="priority-stepper" style="box-shadow:none;">${badge}</div>`;
  return `<div class="priority-stepper">
      ${badge}
      <form action="/dashboard/providers/accounts/move" method="POST" class="priority-actions">
        <input type="hidden" name="id" value="${escapeHtml(c.id)}" />
        <input type="hidden" name="provider" value="${id}" />
        <button type="submit" name="direction" value="up" class="priority-btn" title="Naikkan prioritas" ${
          index === 0 ? "disabled" : ""
        }>&uarr;</button>
        <button type="submit" name="direction" value="down" class="priority-btn" title="Turunkan prioritas" ${
          index === total - 1 ? "disabled" : ""
        }>&darr;</button>
      </form>
    </div>`;
}

/**
 * Account row proxy cell: shows the effective binding plus an inline
 * form to rebind it at any time. The manual address itself is never echoed.
 */
function accountProxyCell(c, id, pools) {
  const poolById = new Map(pools.map((p) => [p.id, p]));
  let label;
  if (c.proxy_pool_id) {
    const pool = poolById.get(c.proxy_pool_id);
    if (!pool) label = `<span class="pill pill-danger">Proxy dihapus</span>`;
    else if (!pool.is_active) label = `<span class="pill pill-warning">Daftar nonaktif: ${escapeHtml(pool.name)}</span>`;
    else label = `<span class="pill pill-success">Daftar: ${escapeHtml(pool.name)}</span>`;
  } else if (c.proxy_url) {
    label = `<code>${escapeHtml(maskProxyUrl(c.proxy_url))}</code>`;
  } else {
    label = `<span class="hint">Langsung</span>`;
  }
  return `
            ${label}
            <form action="/dashboard/providers/accounts/set-proxy" method="POST" class="account-proxy-form">
              <input type="hidden" name="id" value="${escapeHtml(c.id)}" />
              <input type="hidden" name="provider" value="${id}" />
              <select name="proxy_choice">
                <option value="" ${!c.proxy_pool_id && !c.proxy_url ? "selected" : ""}>Langsung</option>
                ${pools
                  .map(
                    (p) =>
                      `<option value="pool:${p.id}" ${c.proxy_pool_id === p.id ? "selected" : ""}>${escapeHtml(p.name)}</option>`
                  )
                  .join("")}
                <option value="manual" ${!c.proxy_pool_id && c.proxy_url ? "selected" : ""}>Manual…</option>
              </select>
              <input type="text" name="proxy_url" placeholder="alamat manual baru" />
              <button type="submit" class="btn btn-sm">Simpan</button>
            </form>`;
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
  return `<div class="hint" style="font-size: 0.75rem;">${parts.join(" · ")}</div>`;
}

/**
 * Provider detail: accounts, models (built-in + custom) with enable/disable.
 * Returns null when the provider id is unknown.
 */
export function renderProviderDetailPage(port, idOrAlias, query = {}) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  const importModes = getImportModes(p);
  const notice = importNotice(query);

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
  const trafficUpdated = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  // Explicit setting first, then the provider's own default, then the global cap.
  const concurrencySetting = getSetting(`provider_concurrency:${p.id}`, "");
  const declaredConcurrency = Number(p.concurrency) > 0 ? Number(p.concurrency) : 0;
  const globalConcurrency = Number(getSetting("max_account_concurrency", "2")) || 2;
  const effectiveConcurrency = Number(concurrencySetting) || declaredConcurrency || globalConcurrency;
  const concurrencyPlaceholder = declaredConcurrency || globalConcurrency;

  const accountRows = accounts
    .map((c, index) => {
      let status = `<span class="pill pill-success">Aktif</span>`;
      if (c.is_active !== 1) status = `<span class="pill">Nonaktif</span>`;
      else if (isConnectionFullyCooledDown(c)) status = `<span class="pill pill-warning">Cooldown</span>`;
      else if (isConnectionExhausted(c)) status = `<span class="pill pill-danger">Habis Kuota</span>`;
      const hidden = `<input type="hidden" name="id" value="${escapeHtml(c.id)}" />
              <input type="hidden" name="provider" value="${id}" />`;
      const sessionForms =
        c.auth_type === "session"
          ? `<form action="/dashboard/providers/accounts/check-session" method="POST">
              ${hidden}
              <button type="submit" class="btn btn-sm">Periksa sesi</button>
            </form>
            <form action="/dashboard/providers/accounts/update-session" method="POST" class="account-session-form">
              ${hidden}
              <input type="password" name="token" placeholder="token baru" required autocomplete="off" />
              <input type="text" name="cookies" placeholder="cookies (opsional)" autocomplete="off" />
              <button type="submit" class="btn btn-sm">Perbarui sesi</button>
            </form>`
          : "";
      return `
        <tr>
          <td>${accountOrderCell(c, id, index, accounts.length)}</td>
          <td><strong>${escapeHtml(c.name)}</strong>${accountIdentityCell(c)}</td>
          <td>${escapeHtml(c.auth_type)}</td>
          <td>${accountProxyCell(c, id, proxyPools)}</td>
          <td>${status}</td>
          <td>${slotCell(trafficByAccount.get(c.id))}</td>
          ${isSession ? `<td>${sessionHealthCell(c)}</td>` : ""}
          <td class="actions">
            ${sessionForms}
            <form action="/dashboard/providers/accounts/delete" method="POST">
              ${hidden}
              <button type="submit" class="btn btn-danger btn-sm">Hapus</button>
            </form>
          </td>
        </tr>`;
    })
    .join("");

  let accountsBody;
  if (p.noAuth) {
    accountsBody = `<p class="hint">Provider ini tidak butuh akun. Zenith Router langsung meneruskan request ke endpoint publik.</p>`;
  } else if (accounts.length === 0) {
    accountsBody = `<div class="empty"><p class="big"><span class="pill pill-muted">Belum ada akun</span></p><p>Tambahkan akun agar model ${escapeHtml(p.name)} bisa di-route.</p></div>`;
  } else {
    accountsBody = `<table class="accounts-table">
        <thead><tr><th title="Akun #1 dipakai duluan; akun berikutnya hanya saat akun di atasnya tidak tersedia">Urutan</th><th>Nama</th><th>Auth</th><th>Proxy</th><th>Status</th><th title="Request berjalan / batas per akun. Angka diambil saat halaman dimuat.">Slot</th>${isSession ? "<th>Sesi</th>" : ""}<th></th></tr></thead>
        <tbody>${accountRows}</tbody>
      </table>${
        isSession
          ? `<p class="hint" style="margin-top: 10px;">Status sesi berasal dari health check <code>create_pow_challenge</code> (tanpa memulai percakapan). Token diambil dari <code>localStorage.userToken</code> di chat.deepseek.com dan disimpan sebagai teks biasa di database lokal.</p>`
          : ""
      }`;
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
    builtin: `<span class="hint">Bawaan</span>`,
    synced: `<span class="pill pill-info">Sinkron</span>`,
    custom: `<span class="pill pill-accent">Kustom</span>`,
    imported: `<span class="pill pill-warning">Impor</span>`,
  };

  const modelRow = (modelId, name, source, customId, isFree = false, capabilities = null) => {
    const custom = source === "custom";
    const disabled = isModelDisabled(p.id, modelId);
    const toggleAction = disabled ? "enable" : "disable";
    const selectCell = `<input type="checkbox" name="model_ids" value="${escapeHtml(
      modelId
    )}" form="models-bulk-form" data-select-group="models" autocomplete="off" aria-label="Pilih ${escapeHtml(
      modelId
    )}" />`;
    return `
        <tr class="model-row${disabled ? ` muted` : ""}" data-sync-row="models">
          <td class="select-cell">${selectCell}</td>
          <td><code>${escapeHtml(alias)}/${escapeHtml(modelId)}</code>${capabilityIcons(capabilities)}</td>
          <td>${escapeHtml(name || modelId)}${isFree ? ` <span class="pill pill-success">Gratis</span>` : ""}</td>
          <td>${SOURCE_CELL[source]}</td>
          <td>${disabled ? `<span class="pill pill-warning">Nonaktif</span>` : `<span class="pill pill-success">Aktif</span>`}</td>
          <td class="actions">
            <form action="/dashboard/providers/models/${toggleAction}" method="POST">
              <input type="hidden" name="provider" value="${id}" />
              <input type="hidden" name="model_id" value="${escapeHtml(modelId)}" />
              <button type="submit" class="btn btn-sm">${disabled ? "Aktifkan" : "Nonaktifkan"}</button>
            </form>
            ${
              custom
                ? `<form action="/dashboard/providers/models/custom/delete" method="POST">
              <input type="hidden" name="id" value="${escapeHtml(customId)}" />
              <input type="hidden" name="provider" value="${id}" />
              <button type="submit" class="btn btn-danger btn-sm">Hapus</button>
            </form>`
                : ""
            }
          </td>
        </tr>`;
  };

  const modelRows = [
    ...builtInModels.map((m) => modelRow(m.id, m.name, m.source, null, m.source === "synced", m.capabilities)),
    ...importedModels.map((m) => modelRow(m.model_id, m.name, "imported", null, m.is_free === 1, resolveCapabilities(m.model_id))),
    ...customModels.map((m) => modelRow(m.model_id, m.name, "custom", m.id, false, resolveCapabilities(m.model_id))),
  ].join("");
  const totalModels = builtInModels.length + importedModels.length + customModels.length;

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
    <div class="back-nav">
      <a href="/dashboard/providers" class="back-link">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="19" y1="12" x2="5" y2="12"></line>
          <polyline points="12 19 5 12 12 5"></polyline>
        </svg>
        <span>Back to Providers</span>
      </a>
    </div>
    ${
      notice
        ? `<div class="notice ${notice.ok ? "notice-ok" : "notice-error"}"><span>${escapeHtml(
            notice.text
          )}</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : ""
    }

    <div class="card">
      <div class="provider-card-head">
        <div class="provider-title">
          ${providerIconHtml(p, 40)}
          <div class="provider-text">
            <h3 style="font-size: 1.1rem;">${escapeHtml(p.name)}</h3>
            <p class="hint">Prefix model <code>${escapeHtml(alias)}/</code> &middot; kategori ${p.category === "free" ? "Gratis" : p.category === "oauth" ? "OAuth" : p.category === "session" ? "Sesi Browser" : "API Key"}</p>
          </div>
        </div>
        ${statusPill(p, stats, accounts)}
      </div>
      ${p.category === "free" ? `<div class="pill-row">${freeTierPills(p.id)}</div>` : ""}
      ${
        !p.noAuth
          ? `<form action="/dashboard/providers/test-connection" method="POST" style="display:inline;">
            <input type="hidden" name="provider" value="${id}" />
            <button type="submit" class="btn btn-sm btn-ghost">Uji Koneksi</button>
          </form>`
          : ""
      }
      ${p.keyUrl ? `<p class="hint" style="margin-top: 10px;">${keyLink(p, p.noAuth ? "Buat API key (opsional)" : "Buat API key")}</p>` : ""}
      <p class="hint" style="margin-top: 6px; font-size: 0.75rem;">Data traffic & slot difetch pada ${trafficUpdated} WIB. Segarkan halaman untuk memperbarui.</p>
    </div>

    ${
      isSession
        ? `<div class="card">
      <p class="hint" style="margin: 0;">Akses ini memakai antarmuka web DeepSeek, bukan API resmi. Pemakaian di luar klien resmi bisa melanggar ketentuan layanan mereka dan berisiko pembatasan atau pemblokiran akun. Token setara akses penuh ke akun dan tersimpan sebagai teks biasa di database lokal. Gateway tidak menyediakan akun bersama: provider ini nonaktif sampai Anda menambahkan token sendiri, dan Anda memakai akun tersebut dengan risiko sendiri.</p>
    </div>`
        : ""
    }

    <div class="card">
      <div class="card-head">
        <h3>Accounts${p.noAuth ? "" : ` (${accounts.length})`}</h3>
        ${p.noAuth ? "" : `<button class="btn btn-primary btn-sm" onclick="openModal('add-account-modal')">Tambah Akun</button>`}
      </div>
      ${accountsBody}
    </div>

    ${
      p.noAuth
        ? ""
        : `<div class="card">
      <div class="card-head">
        <h3>Batas Sesi Paralel</h3>
        <span class="pill">${escapeHtml(String(effectiveConcurrency))} per akun</span>
        ${
          traffic.accounts.length > 0
            ? `<span class="pill${traffic.inFlight >= traffic.cap ? " pill-warning" : ""}">${traffic.inFlight}/${traffic.cap} dipakai</span>
        ${traffic.queue > 0 ? `<span class="pill pill-warning">${traffic.queue} antre</span>` : ""}`
            : ""
        }
      </div>
      <form action="/dashboard/providers/concurrency" method="POST">
        <input type="hidden" name="provider" value="${id}" />
        <div class="field">
          <label for="provider-concurrency">Maksimal request serentak per akun</label>
          <input id="provider-concurrency" name="concurrency" type="number" min="1" max="10" step="1" value="${escapeHtml(String(concurrencySetting))}" placeholder="${escapeHtml(String(concurrencyPlaceholder))}" />
        </div>
        <p class="hint">Batas dihitung per akun, jadi dua akun aktif berarti total dua kali lipat. Request di atas batas menunggu dalam antrean; lewat 30 detik klien menerima 429 dan gateway mencoba akun berikutnya. Panggilan bantu seperti judul sesi menyerah setelah 2 detik agar tidak menahan percakapan. Kosongkan untuk memakai nilai bawaan.</p>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">Simpan Batas</button>
        </div>
      </form>
    </div>`
    }

    ${
      p.noAuth
        ? `<div class="card">
      <div class="card-head">
        <h3>Rotasi Proxy</h3>
      </div>
      <form action="/dashboard/providers/proxy-rotation" method="POST">
        <input type="hidden" name="provider" value="${id}" />
        <div class="field">
          <label for="proxy-rotation-strategy">Strategi</label>
          <select id="proxy-rotation-strategy" name="strategy">
            <option value="off" ${proxyRotationStrategy === "off" ? "selected" : ""}>Tidak aktif</option>
            <option value="round_robin" ${proxyRotationStrategy === "round_robin" ? "selected" : ""}>Bergiliran</option>
            <option value="random" ${proxyRotationStrategy === "random" ? "selected" : ""}>Acak</option>
          </select>
        </div>
        <p class="hint">Saat aktif, setiap request ke provider ini memakai proxy aktif dari daftar Proxy dan pindah ke proxy berikutnya bila gagal, maksimal tiga percobaan per request. Daftar proxy aktif yang kosong berarti request tetap lewat koneksi langsung.</p>
        <div class="modal-actions">
          <button type="submit" class="btn btn-primary">Simpan Strategi</button>
        </div>
      </form>
    </div>`
        : ""
    }

    <div class="card">
      <div class="card-head">
        <h3>Model (${totalModels})</h3>
        <div class="btn-row">
          ${
            hasImported
              ? `<form action="/dashboard/providers/models/import/clear" method="POST" style="margin: 0;" onsubmit="return confirm('Hapus semua model hasil import?')">
            <input type="hidden" name="provider" value="${id}" />
            <button type="submit" class="btn btn-danger btn-sm">Bersihkan Impor</button>
          </form>`
              : ""
          }
          ${
            p.freeModelSync
              ? `<form action="/dashboard/providers/models/sync" method="POST" style="margin: 0;">
            <input type="hidden" name="provider" value="${id}" />
            <button type="submit" class="btn btn-sm">Sinkron Sekarang</button>
          </form>`
              : ""
          }
          ${importModes.length > 0 ? `<button class="btn btn-sm" onclick="openModal('import-models-modal')">Import Models</button>` : ""}
          <button class="btn btn-primary btn-sm" onclick="openModal('add-model-modal')">Add Custom Model</button>
        </div>
      </div>
      ${p.freeModelSync ? syncSummary(p) : ""}
      ${
        p.freeModelSync && importModes.length > 0
          ? `<p class="hint" style="margin-top: -0.25rem; margin-bottom: 0.85rem; font-size: 0.8rem;">Sinkron mengambil daftar model gratis resmi dari provider. Import menambahkan model live dari akun Anda.</p>`
          : ""
      }
      <div class="model-toolbar" style="display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.85rem;">
        <div style="flex: 1; min-width: 200px; max-width: 320px;">
          <input type="text" id="model-search" placeholder="Cari model..." style="margin: 0; padding: 0.35rem 0.65rem; font-size: 0.82rem; height: 32px;" />
        </div>
        <div class="btn-row" style="margin: 0;">
          <button type="button" class="btn btn-sm" data-select-mode-toggle="models">Pilih Model</button>
          <button type="submit" class="btn btn-sm" form="models-bulk-form" formaction="/dashboard/providers/models/enable" data-requires-selection="models" disabled>Aktifkan Terpilih (<span data-selected-count="models">0</span>)</button>
          <button type="submit" class="btn btn-sm" form="models-bulk-form" formaction="/dashboard/providers/models/disable" data-requires-selection="models" disabled>Nonaktifkan Terpilih (<span data-selected-count="models">0</span>)</button>
          ${
            hasImported
              ? `<button type="submit" class="btn btn-danger btn-sm" form="models-bulk-form" formaction="/dashboard/providers/models/import/delete" data-requires-selection="models" disabled onclick="return confirmSelected(document.getElementById('models-bulk-form'), 'model_ids', 'model hasil import')">Hapus Terpilih (<span data-selected-count="models">0</span>)</button>`
              : ""
          }
        </div>
      </div>
      <form id="models-bulk-form" method="POST">
        <input type="hidden" name="provider" value="${id}" />
      </form>
      <table data-sync-row="models">
        <thead><tr><th class="select-cell"><input type="checkbox" data-select-all="models" autocomplete="off" aria-label="Pilih semua model" title="Pilih semua model" /></th><th>Model ID</th><th>Name</th><th>Source</th><th>Status</th><th></th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
      <script>
        (function() {
          var input = document.getElementById('model-search');
          var rows = document.querySelectorAll('table[data-sync-row="models"] tbody tr.model-row');
          if (!input || !rows.length) return;
          input.addEventListener('input', function() {
            var q = input.value.toLowerCase();
            rows.forEach(function(row) {
              var text = row.textContent.toLowerCase();
              row.style.display = text.includes(q) ? '' : 'none';
            });
          });
        })();
      </script>
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
  `;

  return renderLayout({ title: p.name, activeTab: "providers", content, port });
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

  const baseUrl = provider.transport?.baseUrl;
  if (!baseUrl) return c.redirect(`${backTo(provider.id)}?notice=test_no_base`);

  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      return c.redirect(`${backTo(provider.id)}?notice=test_ok`);
    }
    return c.redirect(
      `${backTo(provider.id)}?notice=test_fail&msg=${encodeURIComponent(`HTTP ${res.status}`)}`
    );
  } catch (err) {
    return c.redirect(
      `${backTo(provider.id)}?notice=test_fail&msg=${encodeURIComponent(err.message || "koneksi gagal")}`
    );
  }
}

export async function handleImportModels(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || ""));
  if (!provider) return c.redirect("/dashboard/providers");

  const mode = body.mode === "free" ? "free" : "all";
  const result = await importProviderModels(provider.id, mode);
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

  const result = await syncFreeModels(provider.id);
  const params = new URLSearchParams({ sync: result.code, count: String(result.count) });
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
