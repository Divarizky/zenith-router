import { getConnections, addConnection, deleteConnection } from "../../db/index.js";
import { getAllProviders, getProvider, getProviderModels } from "../../providers/index.js";
import { isConnectionInCooldown } from "../../services/auth.js";
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
import { syncFreeModels, getSyncIntervalMs } from "../../services/modelSync.js";
import { getOAuthFlow } from "../../services/oauth/providers.js";
import { hasLocalImport } from "../../services/oauth/flows.js";
import { FREE_TIER_BUDGETS, FREE_TIER_TOS } from "../../config/freeTierCatalog.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getProviderIconPath } from "../assets.js";

const SECTIONS = [
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
  if (query.notice === "account_deleted") return { ok: true, text: "Akun berhasil dihapus." };
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
    (c) => c.is_active === 1 && !isConnectionInCooldown(c) && !isConnectionExhausted(c)
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

function statusPill(p, stats) {
  if (p.noAuth) return `<span class="pill pill-success">Siap</span>`;
  if (stats.healthy > 0) return `<span class="pill pill-success">${stats.healthy} Terhubung</span>`;
  if (stats.total > 0) return `<span class="pill pill-warning">${stats.total} tidak aktif</span>`;
  return `<span class="pill">Belum ada akun</span>`;
}

/**
 * Providers list: cards grouped by category, each linking to its detail page.
 */
export function renderProvidersPage(port = 20120) {
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
      // Ready (noAuth) first, then connected, then alphabetical, like 9router.
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
          ${statusPill(p, stats)}
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

  return renderLayout({ title: "Providers", activeTab: "providers", content: sections, port });
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
const OAUTH_SCRIPT = `
<script>
(function () {
  var flowId = null, timer = null, pollMs = 2000;
  var statusEl = document.getElementById('oauth-status');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }
  function val(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; }
  function show(html, isError) { statusEl.hidden = false; statusEl.className = 'oauth-status' + (isError ? ' error' : ''); statusEl.innerHTML = html; }
  function post(url, data) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok && !j.error) j.error = 'HTTP ' + r.status; return j; }); });
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
      var url = r.flowType === 'device_code' ? r.verificationUri : r.authUrl;
      if (popup) { popup.opener = null; popup.location.href = url; }
      var link = '<a href="' + esc(url) + '" target="_blank" rel="noopener">Buka halaman login</a>';
      if (r.flowType === 'device_code') {
        pollMs = Math.max(2, r.interval || 5) * 1000;
        show((r.userCode ? '<p>Masukkan kode ini di halaman login:</p><div class="device-code">' + esc(r.userCode) + '</div>' : '<p>Selesaikan login di tab yang terbuka.</p>') +
          '<p>' + link + '</p><p class="hint">Menunggu persetujuan...</p>');
      } else {
        pollMs = 2000;
        show('<p>Selesaikan login di tab yang terbuka. ' + link + '</p>' +
          (r.listening === false ? '<p>Port callback sedang dipakai aplikasi lain, jadi tempel URL callback secara manual.</p>'
            : '<p class="hint">Menunggu callback. Kalau browser tidak kembali ke Zenith Router, tempel URL callback atau kode di bawah.</p>') +
          '<div class="field"><input id="oauth-manual" placeholder="http://localhost:.../callback?code=... atau code#state" autocomplete="off" /></div>' +
          '<button type="button" class="btn btn-sm" onclick="zrOAuthManual()">Kirim</button>' +
          '<p id="oauth-manual-error" class="hint" style="color: var(--danger); margin-top: 0.5rem;"></p>');
      }
      schedule();
    }).catch(function (e) { if (popup) popup.close(); show('Gagal memulai login: ' + esc(e.message), true); });
  };
  window.zrOAuthManual = function () {
    if (!flowId) return;
    post('/dashboard/oauth/manual', { flowId: flowId, input: val('oauth-manual') }).then(function (r) {
      if (r.status === 'done') return done();
      document.getElementById('oauth-manual-error').textContent = r.error || 'Gagal.';
    });
  };
  window.zrOAuthCancel = function () {
    if (flowId) post('/dashboard/oauth/cancel', { flowId: flowId });
    flowId = null;
    clearTimeout(timer);
    statusEl.hidden = true;
  };
})();
</script>`;

function renderAddAccountModal(p) {
  const id = escapeHtml(p.id);
  const title = `<h3>Add ${escapeHtml(p.name)} Account</h3>`;

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
            <label for="proxy_url">URL Proxy (Opsional)</label>
            <input type="text" id="proxy_url" name="proxy_url" placeholder="http://127.0.0.1:7890" />
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
            ? `<div class="notice" style="background: var(--bg-hover, #1e2029); border-left: 3px solid var(--warning, #eab308); padding: 0.5rem 0.75rem; font-size: 0.8rem; margin-bottom: 1rem; line-height: 1.4;">
                <span style="color: var(--text-muted, #94a3b8);">${OAUTH_SCOPE_NOTICES[p.id]}</span>
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
 * Provider detail: accounts, models (built-in + custom) with enable/disable.
 * Returns null when the provider id is unknown.
 */
export function renderProviderDetailPage(port, idOrAlias, query = {}) {
  const p = getProvider(idOrAlias);
  if (!p) return null;
  const importModes = getImportModes(p);
  const notice = importNotice(query);

  const alias = primaryAlias(p);
  const accounts = getConnections().filter((c) => c.provider === p.id);
  const stats = accountStats(accounts);
  const id = escapeHtml(p.id);

  const accountRows = accounts
    .map((c) => {
      let status = `<span class="pill pill-success">Aktif</span>`;
      if (c.is_active !== 1) status = `<span class="pill">Nonaktif</span>`;
      else if (isConnectionInCooldown(c)) status = `<span class="pill pill-warning">Cooldown</span>`;
      else if (isConnectionExhausted(c)) status = `<span class="pill pill-danger">Habis Kuota</span>`;
      return `
        <tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td>${escapeHtml(c.auth_type)}</td>
          <td>${c.proxy_url ? `<code>${escapeHtml(c.proxy_url)}</code>` : `<span class="hint">-</span>`}</td>
          <td>${status}</td>
          <td class="actions">
            <form action="/dashboard/providers/accounts/delete" method="POST">
              <input type="hidden" name="id" value="${escapeHtml(c.id)}" />
              <input type="hidden" name="provider" value="${id}" />
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
    accountsBody = `<div class="empty"><p class="big">Belum ada akun</p><p>Tambahkan akun agar model ${escapeHtml(p.name)} bisa di-route.</p></div>`;
  } else {
    accountsBody = `<table>
        <thead><tr><th>Nama</th><th>Auth</th><th>Proxy</th><th>Status</th><th></th></tr></thead>
        <tbody>${accountRows}</tbody>
      </table>`;
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
    synced: `<span class="pill">Sinkron</span>`,
    custom: `<span class="pill">Kustom</span>`,
    imported: `<span class="pill">Impor</span>`,
  };

  const modelRow = (modelId, name, source, customId, isFree = false) => {
    const custom = source === "custom";
    const disabled = isModelDisabled(p.id, modelId);
    const toggleAction = disabled ? "enable" : "disable";
    const selectCell = `<input type="checkbox" name="model_ids" value="${escapeHtml(
      modelId
    )}" form="models-bulk-form" data-select-group="models" autocomplete="off" aria-label="Pilih ${escapeHtml(
      modelId
    )}" />`;
    return `
        <tr${disabled ? ` class="muted"` : ""}>
          <td class="select-cell">${selectCell}</td>
          <td><code>${escapeHtml(alias)}/${escapeHtml(modelId)}</code></td>
          <td>${escapeHtml(name || modelId)}${isFree ? ` <span class="pill pill-success">Gratis</span>` : ""}</td>
          <td>${SOURCE_CELL[source]}</td>
          <td>${disabled ? `<span class="pill">Nonaktif</span>` : `<span class="pill pill-success">Aktif</span>`}</td>
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
    ...builtInModels.map((m) => modelRow(m.id, m.name, m.source, null, m.source === "synced")),
    ...importedModels.map((m) => modelRow(m.model_id, m.name, "imported", null, m.is_free === 1)),
    ...customModels.map((m) => modelRow(m.model_id, m.name, "custom", m.id)),
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
            <p class="hint">Prefix model <code>${escapeHtml(alias)}/</code> &middot; kategori ${p.category === "free" ? "Gratis" : p.category === "oauth" ? "OAuth" : "API Key"}</p>
          </div>
        </div>
        ${statusPill(p, stats)}
      </div>
      ${p.category === "free" ? `<div class="pill-row">${freeTierPills(p.id)}</div>` : ""}
      ${p.keyUrl ? `<p class="hint" style="margin-top: 10px;">${keyLink(p, p.noAuth ? "Buat API key (opsional)" : "Buat API key")}</p>` : ""}
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Accounts${p.noAuth ? "" : ` (${accounts.length})`}</h3>
        ${p.noAuth ? "" : `<button class="btn btn-primary btn-sm" onclick="openModal('add-account-modal')">Tambah Akun</button>`}
      </div>
      ${accountsBody}
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Model (${totalModels})</h3>
        <div class="btn-row">
          <button type="submit" class="btn btn-sm" form="models-bulk-form" formaction="/dashboard/providers/models/disable" data-requires-selection="models" disabled>Nonaktifkan Terpilih (<span data-selected-count="models">0</span>)</button>
          <button type="submit" class="btn btn-sm" form="models-bulk-form" formaction="/dashboard/providers/models/enable" data-requires-selection="models" disabled>Aktifkan Terpilih (<span data-selected-count="models">0</span>)</button>
          ${
            hasImported
              ? `<button type="submit" class="btn btn-danger btn-sm" form="models-bulk-form" formaction="/dashboard/providers/models/import/delete" data-requires-selection="models" disabled onclick="return confirmSelected(document.getElementById('models-bulk-form'), 'model_ids', 'model hasil import')">Hapus Terpilih (<span data-selected-count="models">0</span>)</button>
          <form action="/dashboard/providers/models/import/clear" method="POST" onsubmit="return confirm('Hapus semua model hasil import?')">
            <input type="hidden" name="provider" value="${id}" />
            <button type="submit" class="btn btn-danger btn-sm">Bersihkan Impor</button>
          </form>`
              : ""
          }
          ${
            p.freeModelSync
              ? `<form action="/dashboard/providers/models/sync" method="POST">
            <input type="hidden" name="provider" value="${id}" />
            <button type="submit" class="btn btn-sm">Sinkron Sekarang</button>
          </form>`
              : ""
          }
          ${importModes.length > 0 ? `<button class="btn btn-sm" onclick="openModal('import-models-modal')">Import Models</button>` : ""}
          <button class="btn btn-sm" onclick="openModal('add-model-modal')">Add Custom Model</button>
        </div>
      </div>
      ${p.freeModelSync ? syncSummary(p) : ""}
      <form id="models-bulk-form" method="POST">
        <input type="hidden" name="provider" value="${id}" />
      </form>
      <table>
        <thead><tr><th class="select-cell"><input type="checkbox" data-select-all="models" autocomplete="off" aria-label="Pilih semua model" title="Pilih semua model" /></th><th>Model ID</th><th>Name</th><th>Source</th><th>Status</th><th></th></tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
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
            <input type="text" id="model_id" name="model_id" placeholder="ID upstream, tanpa prefix" required />
          </div>
          <div class="field">
            <label for="model_name">Display Name (Optional)</label>
            <input type="text" id="model_name" name="name" />
          </div>
          <p class="hint">Dipanggil lewat <code>${escapeHtml(alias)}/&lt;model-id&gt;</code>.</p>
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
  const proxyValid = !proxy_url || /^https?:\/\/[^\s]+$/i.test(proxy_url);

  if (provider && !provider.noAuth && secret && proxyValid) {
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
      proxy_url: proxy_url || null,
    });
    return c.redirect(`${backTo(body.provider)}?notice=account_added`);
  }
  return c.redirect(backTo(body.provider));
}

export async function handleDeleteAccount(c) {
  const body = await c.req.parseBody();
  const id = Number(body.id);
  if (id) deleteConnection(id);
  return c.redirect(`${backTo(body.provider)}?notice=account_deleted`);
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
