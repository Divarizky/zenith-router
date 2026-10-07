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
import { FREE_TIER_BUDGETS, FREE_TIER_TOS } from "../../config/freeTierCatalog.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";

const SECTIONS = [
  { category: "oauth", title: "OAuth Providers", hint: "Login dengan akun langganan, lalu tempel token di sini." },
  { category: "free", title: "Free Tier Providers", hint: "Provider gratis. Yang berlabel Ready bisa dipakai tanpa akun." },
  { category: "apikey", title: "API Key Providers", hint: "Butuh API key dari vendor." },
];

function primaryAlias(p) {
  return Array.isArray(p.alias) ? p.alias[0] : p.alias || p.id;
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
  const schedule = hours > 0 ? `Model gratis disinkron otomatis tiap ${hours} jam.` : "Sinkron otomatis dimatikan (ZENROUTE_MODEL_SYNC_INTERVAL_HOURS=0).";
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
  if (tos === "avoid") pills.push(`<span class="pill pill-warning">ToS: avoid</span>`);
  else if (tos) pills.push(`<span class="pill">ToS: ${escapeHtml(tos)}</span>`);
  return pills.join("");
}

function accountStats(list) {
  const healthy = list.filter(
    (c) => c.is_active === 1 && !isConnectionInCooldown(c) && !isConnectionExhausted(c)
  ).length;
  return { total: list.length, healthy };
}

function statusPill(p, stats) {
  if (p.noAuth) return `<span class="pill pill-success">Ready</span>`;
  if (stats.healthy > 0) return `<span class="pill pill-success">${stats.healthy} Connected</span>`;
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
          <h3>${escapeHtml(p.name)}</h3>
          ${statusPill(p, stats)}
        </div>
        <p class="hint"><code>${escapeHtml(primaryAlias(p))}/</code> &middot; ${countProviderModels(
          p,
          allImported.filter((m) => m.provider === p.id),
          allCustom.filter((m) => m.provider === p.id)
        )} model</p>
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
      let status = `<span class="pill pill-success">Active</span>`;
      if (c.is_active !== 1) status = `<span class="pill">Disabled</span>`;
      else if (isConnectionInCooldown(c)) status = `<span class="pill pill-warning">Cooldown</span>`;
      else if (isConnectionExhausted(c)) status = `<span class="pill pill-danger">Exhausted</span>`;
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
              <button type="submit" class="btn btn-danger btn-sm">Delete</button>
            </form>
          </td>
        </tr>`;
    })
    .join("");

  let accountsBody;
  if (p.noAuth) {
    accountsBody = `<p class="hint">Provider ini tidak butuh akun. zenroute langsung meneruskan request ke endpoint publik.</p>`;
  } else if (accounts.length === 0) {
    accountsBody = `<div class="empty"><p class="big">Belum ada akun</p><p>Tambahkan akun agar model ${escapeHtml(p.name)} bisa di-route.</p></div>`;
  } else {
    accountsBody = `<table>
        <thead><tr><th>Name</th><th>Auth</th><th>Proxy</th><th>Status</th><th></th></tr></thead>
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
    builtin: `<span class="hint">Built-in</span>`,
    synced: `<span class="pill">Synced</span>`,
    custom: `<span class="pill">Custom</span>`,
    imported: `<span class="pill">Imported</span>`,
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
          <td>${escapeHtml(name || modelId)}${isFree ? ` <span class="pill pill-success">Free</span>` : ""}</td>
          <td>${SOURCE_CELL[source]}</td>
          <td>${disabled ? `<span class="pill">Disabled</span>` : `<span class="pill pill-success">Enabled</span>`}</td>
          <td class="actions">
            <form action="/dashboard/providers/models/${toggleAction}" method="POST">
              <input type="hidden" name="provider" value="${id}" />
              <input type="hidden" name="model_id" value="${escapeHtml(modelId)}" />
              <button type="submit" class="btn btn-sm">${disabled ? "Enable" : "Disable"}</button>
            </form>
            ${
              custom
                ? `<form action="/dashboard/providers/models/custom/delete" method="POST">
              <input type="hidden" name="id" value="${escapeHtml(customId)}" />
              <input type="hidden" name="provider" value="${id}" />
              <button type="submit" class="btn btn-danger btn-sm">Delete</button>
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
            <button type="button" class="btn" data-close-modal="import-models-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Import</button>
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
        <div>
          <h3 style="font-size: 1.1rem;">${escapeHtml(p.name)}</h3>
          <p class="hint">Prefix model <code>${escapeHtml(alias)}/</code> &middot; kategori ${escapeHtml(p.category || "apikey")}</p>
        </div>
        ${statusPill(p, stats)}
      </div>
      ${p.category === "free" ? `<div class="pill-row">${freeTierPills(p.id)}</div>` : ""}
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Accounts${p.noAuth ? "" : ` (${accounts.length})`}</h3>
        ${p.noAuth ? "" : `<button class="btn btn-primary btn-sm" onclick="openModal('add-account-modal')">Add Account</button>`}
      </div>
      ${accountsBody}
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Models (${totalModels})</h3>
        <div class="btn-row">
          <button type="submit" class="btn btn-sm" form="models-bulk-form" formaction="/dashboard/providers/models/disable" data-requires-selection="models" disabled>Disable Selected (<span data-selected-count="models">0</span>)</button>
          <button type="submit" class="btn btn-sm" form="models-bulk-form" formaction="/dashboard/providers/models/enable" data-requires-selection="models" disabled>Enable Selected (<span data-selected-count="models">0</span>)</button>
          ${
            hasImported
              ? `<button type="submit" class="btn btn-danger btn-sm" form="models-bulk-form" formaction="/dashboard/providers/models/import/delete" data-requires-selection="models" disabled onclick="return confirmSelected(document.getElementById('models-bulk-form'), 'model_ids', 'model hasil import')">Delete Selected (<span data-selected-count="models">0</span>)</button>
          <form action="/dashboard/providers/models/import/clear" method="POST" onsubmit="return confirm('Hapus semua model hasil import?')">
            <input type="hidden" name="provider" value="${id}" />
            <button type="submit" class="btn btn-danger btn-sm">Clear Imported</button>
          </form>`
              : ""
          }
          ${
            p.freeModelSync
              ? `<form action="/dashboard/providers/models/sync" method="POST">
            <input type="hidden" name="provider" value="${id}" />
            <button type="submit" class="btn btn-sm">Sync Now</button>
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

    <div class="modal-backdrop" id="add-account-modal">
      <div class="modal">
        <h3>Add ${escapeHtml(p.name)} Account</h3>
        <form action="/dashboard/providers/accounts/add" method="POST">
          <input type="hidden" name="provider" value="${id}" />
          <div class="field">
            <label for="name">Account Label</label>
            <input type="text" id="name" name="name" placeholder="e.g. Akun utama" required />
          </div>
          <div class="field">
            <label for="auth_type">Auth Type</label>
            <select id="auth_type" name="auth_type">
              <option value="apikey"${p.category === "oauth" ? "" : " selected"}>API Key</option>
              <option value="oauth"${p.category === "oauth" ? " selected" : ""}>OAuth Token</option>
            </select>
          </div>
          <div class="field">
            <label for="api_key">API Key or Token</label>
            <input type="password" id="api_key" name="api_key" placeholder="Paste credential secret..." required />
          </div>
          <div class="field">
            <label for="proxy_url">Proxy URL (Optional)</label>
            <input type="text" id="proxy_url" name="proxy_url" placeholder="http://127.0.0.1:7890" />
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" data-close-modal="add-account-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Add Account</button>
          </div>
        </form>
      </div>
    </div>

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
            <button type="button" class="btn" data-close-modal="add-model-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Add Model</button>
          </div>
        </form>
      </div>
    </div>
  `;

  return renderLayout({ title: p.name, activeTab: "providers", content, port });
}

export async function handleAddAccount(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || "").trim());
  const name = String(body.name || "").trim() || `${provider?.name || "Provider"} Account`;
  const auth_type = body.auth_type === "oauth" ? "oauth" : "apikey";
  const secret = String(body.api_key || "").trim();
  const proxy_url = body.proxy_url ? String(body.proxy_url).trim() : "";
  const proxyValid = !proxy_url || /^https?:\/\/[^\s]+$/i.test(proxy_url);

  if (provider && !provider.noAuth && secret && proxyValid) {
    addConnection({
      provider: provider.id,
      name,
      auth_type,
      credentials: auth_type === "oauth" ? { access_token: secret } : { api_key: secret },
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
