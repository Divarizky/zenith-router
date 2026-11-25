import {
  listProxyPools,
  createProxyPool,
  importProxyLines,
  testProxyPool,
  updateProxyPoolEntry,
  updateProxyPoolBindings,
  deleteProxyPool,
  toggleProxyPool,
  getProxyRotationStrategy,
} from "../../services/proxyPools.js";
import {
  probePoolEgressIp,
  getPoolEgressIp,
  findDuplicateEgressIps,
} from "../../services/proxyEgressProbe.js";
import { getConnections } from "../../db/index.js";
import { getAllProviders } from "../../providers/index.js";
import { escapeHtml } from "../html.js";
import { renderLayout, icon } from "../layout.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

function fmtTestTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderEgressIpLine(pool, duplicateIds = new Set()) {
  const entry = getPoolEgressIp(pool.id);
  if (!entry) {
    return `<span style="color:var(--text-muted);">Exit IP: belum dicek</span>`;
  }
  if (!entry.ip) {
    return `<span style="color:var(--danger);">Exit IP: gagal dicek${entry.error ? ` &middot; ${escapeHtml(String(entry.error))}` : ""}</span>`;
  }
  const stale = entry.stale
    ? ` <span class="pill pill-warning" title="Config proxy atau probe berubah, atau hasil sudah lewat TTL">kedaluwarsa</span>`
    : "";
  const dup = !entry.stale && duplicateIds.has(Number(pool.id))
    ? ` <span class="pill pill-warning" title="Pool lain memakai IP keluar yang sama. Ini diagnosis, bukan blokir.">IP duplikat</span>`
    : "";
  return `Exit IP: <code>${escapeHtml(entry.ip)}</code> &middot; dicek ${fmtTestTime(entry.checkedAt)}${stale}${dup}`;
}

function renderProxyRow(pool, noAuthRotatingProviders = [], duplicateIds = new Set(), index = 0) {
  const isOk = Boolean(pool.last_test_ok);
  const hasTested = Boolean(pool.last_test_at);
  const serialNo = `#${String(index + 1).padStart(2, "0")}`;

  const testBadge = hasTested
    ? isOk
      ? `<span class="pill pill-success" title="Tes terakhir sukses"><span class="dot"></span>ok</span>`
      : `<span class="pill pill-warning" title="Tes terakhir gagal"><span class="dot"></span>error</span>`
    : `<span class="pill" title="Belum pernah dites"><span class="dot"></span>unknown (Belum dites)</span>`;

  const activeBadge = pool.is_active
    ? `<span class="pill pill-success">active</span>`
    : `<span class="pill">inactive</span>`;

  const boundBadge = `<span class="pill ${pool.accountCount > 0 ? "pill-info" : ""}">${pool.accountCount} bound (${pool.accountCount} akun)</span>`;
  const exhaustedState = pool.exhaustedState;
  const exhaustedBadge =
    exhaustedState && exhaustedState.until > Date.now()
      ? `<span class="pill pill-warning" title="Kuota OpenCode cooldown dibuat ${fmtTestTime(exhaustedState.at)} WIB; WARP readiness tidak menghapusnya">kuota cooldown (sampai ${fmtTestTime(exhaustedState.until)} WIB &middot; ${escapeHtml(exhaustedState.source === "retry-after" ? "Retry-After" : "reset UTC")})</span>`
      : "";
  const warpReadiness = pool.warpReadiness;
  const warpReadinessBadge = /^warp-node-\d+$/i.test(String(pool.name || "")) && warpReadiness
    ? `<span class="pill ${warpReadiness.state === "ready" ? "pill-success" : warpReadiness.state === "degraded" ? "pill-warning" : ""}" title="Kesehatan koneksi WARP; tidak sama dengan status kuota OpenCode">WARP: ${escapeHtml(warpReadiness.state)}</span>`
    : "";
  const kindBadge =
    pool.kind === "gateway"
      ? `<span class="pill pill-info" title="Rotating Gateway">gateway &times;${Number(pool.retry_budget) || 1}</span>`
      : "";

  const noAuthBoundBadge = (pool.boundAccounts || []).some((a) => a.isNoAuth)
    ? `<span class="pill pill-accent" title="Memiliki akun terikat dari provider noAuth (publik)"><span class="dot dot-success"></span>noAuth bound</span>`
    : "";
  const noAuthRotatingBadge = pool.is_active && noAuthRotatingProviders.length > 0
    ? `<span class="pill pill-accent" title="Melayani rotasi provider noAuth: ${escapeHtml(noAuthRotatingProviders.map((p) => p.name || p.id).join(', '))}"><span class="dot dot-success"></span>noAuth rotasi</span>`
    : "";

  // Nilai masuk atribut onclick: JSON.stringify menjaga literal JS tetap utuh
  // (quote, backslash, newline), escapeHtml hanya untuk konteks atribut HTML.
  const nameJson = escapeHtml(JSON.stringify(pool.name));
  const urlJson = escapeHtml(JSON.stringify(pool.maskedUrl));
  const kindJson = escapeHtml(JSON.stringify(pool.kind || "single"));
  const budgetJson = Number(pool.retry_budget) || 1;
  const rotateUrlJson = escapeHtml(JSON.stringify(pool.rotate_url || ""));
  const maskedCredJson = escapeHtml(JSON.stringify(pool.hasRotateToken ? "****" : ""));
  const boundIdsJson = JSON.stringify(pool.boundAccountIds || []);

  const testDetail = hasTested
    ? `Last tested: ${fmtTestTime(pool.last_test_at)}${
        pool.last_test_ms != null ? ` &middot; ${pool.last_test_ms} ms` : ""
      }${
        !isOk && pool.last_test_error
          ? ` &middot; <span style="color:var(--danger);">${escapeHtml(String(pool.last_test_error))}</span>`
          : ""
      }`
    : "Last tested: Never (Belum dites)";

  const boundChips =
    pool.boundAccounts && pool.boundAccounts.length > 0
      ? (() => {
          const maxChips = 6;
          const visible = pool.boundAccounts.slice(0, maxChips);
          const remaining = pool.boundAccounts.length - maxChips;
          const chips = visible
            .map(
              (acc) => {
                const noAuthTag = acc.isNoAuth
                  ? ` <span class="pill pill-xs pill-accent" style="font-size:0.6rem; padding:0.05rem 0.25rem; margin-left:0.2rem;">noAuth</span>`
                  : "";
                return `<span class="proxy-sticker-chip" title="${escapeHtml(acc.provider)}: ${escapeHtml(acc.name)}${acc.isNoAuth ? " (noAuth)" : ""}"><strong class="proxy-sticker-provider">${escapeHtml(acc.provider)}:</strong> <span class="proxy-sticker-name">${escapeHtml(acc.name)}</span>${noAuthTag}</span>`;
              }
            )
            .join("");
          const more =
            remaining > 0
              ? `<span class="proxy-sticker-more" title="${escapeHtml(pool.boundAccounts.slice(maxChips).map((a) => `${a.provider}: ${a.name}`).join(", "))}">+${remaining} lainnya</span>`
              : "";
          return `
            <div class="proxy-bound-chips-wrap">
              ${chips}
              ${more}
            </div>`;
        })()
      : `<div class="proxy-bound-empty"><span class="proxy-bound-empty-dash">&mdash;</span> <span>0 akun terikat</span></div>`;

  const modeBadgesList = [kindBadge, warpReadinessBadge, noAuthRotatingBadge, exhaustedBadge].filter(Boolean);
  const modeBadgesHtml = modeBadgesList.length > 0 ? `<div class="proxy-mode-badges">${modeBadgesList.join(" ")}</div>` : "";

  return `
    <div class="proxy-card-editorial proxy-row ${pool.is_active ? "is-active" : ""}" id="proxy-row-${pool.id}" data-bound-ids="${escapeHtml(boundIdsJson)}">
      <div class="proxy-card-header">
        <div class="proxy-card-header-left">
          <input
            type="checkbox"
            name="ids"
            value="${pool.id}"
            data-select-group="proxies"
            form="proxy-bulk-form"
            autocomplete="off"
            class="proxy-checkbox"
            aria-label="Pilih ${escapeHtml(pool.name)}"
          />
          <span class="editorial-label">[PROXY POOL #${String(pool.id).padStart(2, "0")}]</span>
          <span class="proxy-serial-badge">${serialNo}</span>
        </div>
        <div class="proxy-card-header-right">
          ${activeBadge}
          ${testBadge}
        </div>
      </div>

      <div class="proxy-card-body">
        <div class="proxy-title-line">
          <span class="proxy-name">${escapeHtml(pool.name)}</span>
          ${modeBadgesHtml}
        </div>
        <div class="proxy-endpoint-container proxy-url-line">
          <span class="proxy-endpoint-proto">HTTP</span>
          <div class="proxy-endpoint-address">
            <code>${escapeHtml(pool.maskedUrl)}</code>
          </div>
        </div>

        <div class="proxy-telemetry-ledger proxy-meta-line">
          <div class="proxy-ledger-cell proxy-ledger-exit-ip">
            <span class="proxy-ledger-label">TELEMETRI EXIT IP</span>
            <div class="proxy-ledger-val">
              ${renderEgressIpLine(pool, duplicateIds)}
            </div>
          </div>
          <div class="proxy-ledger-cell proxy-ledger-last-test">
            <span class="proxy-ledger-label">STATUS UJI TERAKHIR</span>
            <div class="proxy-ledger-val">
              ${testDetail}
            </div>
          </div>
        </div>

        <div class="proxy-bound-section">
          <div class="proxy-bound-header">
            <div class="proxy-bound-title-wrap">
              <span class="proxy-micro-label">AKUN TERIKAT (${pool.accountCount} akun) &middot; ${pool.accountCount} bound</span>
              <span class="proxy-bound-tag-label" style="display:none;">Bound accounts:</span>
            </div>
            ${noAuthBoundBadge}
          </div>
          <div class="proxy-bound-content">
            ${boundChips}
          </div>
        </div>
      </div>

      <div class="proxy-card-footer proxy-actions">
        <div class="proxy-actions-left">
          <form action="/dashboard/proxies/toggle" method="POST" style="margin: 0;">
            <input type="hidden" name="id" value="${pool.id}" />
            <button
              type="submit"
              class="btn btn-sm ${pool.is_active ? "btn-secondary" : "btn-ghost"}"
              title="${pool.is_active ? "Nonaktifkan proxy" : "Aktifkan proxy"}"
            >${pool.is_active ? "Disable" : "Enable"}</button>
          </form>
          <form action="/dashboard/proxies/probe-ip" method="POST" style="margin: 0;">
            <input type="hidden" name="id" value="${pool.id}" />
            <button type="submit" class="btn btn-sm btn-ghost" title="Cek IP keluar lewat transport proxy ini">Cek IP</button>
          </form>
        </div>
        <div class="proxy-actions-right">
          <form action="/dashboard/proxies/test" method="POST" style="margin: 0;">
            <input type="hidden" name="id" value="${pool.id}" />
            <button type="submit" class="btn btn-sm btn-icon" title="Tes proxy">
              ${icon("science", 15)}
            </button>
          </form>
          <button
            type="button"
            class="btn btn-sm btn-icon"
            title="Ubah proxy"
            onclick="openEditModal(${pool.id}, ${nameJson}, ${urlJson}, ${pool.is_active ? 1 : 0}, ${kindJson}, ${budgetJson}, ${rotateUrlJson}, ${maskedCredJson}, ${boundIdsJson})"
          >
            ${icon("edit", 15)}
          </button>
          <form action="/dashboard/proxies/delete" method="POST" data-confirm="Hapus proxy ini dari daftar?" style="margin: 0;">
            <input type="hidden" name="id" value="${pool.id}" />
            <button type="submit" class="btn btn-sm btn-icon btn-danger" title="Hapus proxy">
              ${icon("trash", 15)}
            </button>
          </form>
        </div>
      </div>
    </div>`;
}

export function renderProxyContent(query = {}, lang = DEFAULT_LANGUAGE) {
  const currentLang = lang || DEFAULT_LANGUAGE;
  const pools = listProxyPools();
  const allConnections = getConnections();
  const poolNamesMap = Object.fromEntries(pools.map((p) => [p.id, p.name]));
  const activeCount = pools.filter((p) => Number(p.is_active) === 1).length;

  const notice =
    query.imported === "1"
      ? (() => {
          const created = Number(query.created) || 0;
          const skipped = Number(query.skipped) || 0;
          const failed = Number(query.failed) || 0;
          const cls = created === 0 && failed > 0 ? "notice-error" : "notice-ok";
          return `<div class="notice ${cls}"><span>Dibuat: ${created} · Dilewati: ${skipped} · Gagal: ${failed}</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`;
        })()
      : query.probed === "1"
        ? query.ok === "1"
          ? `<div class="notice notice-ok"><span>IP keluar tercatat. Lihat baris Exit IP di daftar.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
          : `<div class="notice notice-error"><span>${escapeHtml(query.msg || "Cek IP keluar gagal.")}</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
      : query.tested === "1"
        ? query.ok === "1"
          ? `<div class="notice notice-ok"><span>Tes proxy berhasil. Hasil tersimpan di daftar.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
          : `<div class="notice notice-error"><span>Tes proxy gagal. Lihat pesan error di daftar.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : query.updated === "1"
          ? `<div class="notice notice-ok"><span>Proxy diperbarui. Akun yang memakainya langsung memakai alamat baru.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
          : query.deleted === "1"
            ? `<div class="notice notice-ok"><span>Proxy dihapus dari daftar.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
            : query.toggled === "1"
              ? `<div class="notice notice-ok"><span>Status aktif proxy diperbarui.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
              : query.created === "1"
                ? `<div class="notice notice-ok"><span>Proxy berhasil ditambahkan.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
                : query.error === "1"
                  ? `<div class="notice notice-error"><span>${escapeHtml(query.msg || "Proxy gagal diproses.")}</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
                  : "";

  const emptyState = `
    <div class="proxy-empty-editorial" style="text-align: center; padding: 3.5rem 1.5rem; background: var(--surface); border: var(--bw-thick) dashed var(--border-subtle); margin-bottom: 2rem;">
      <div style="margin-bottom: 1rem; color: var(--accent); display: inline-flex; padding: 0.85rem; background: var(--surface-2); border: var(--bw) solid var(--border); box-shadow: var(--hard-sm);">${icon("lan", 40)}</div>
      <p style="font-weight: 900; margin-bottom: 0.35rem; font-size: 1.15rem; text-transform: uppercase; letter-spacing: -0.02em;">Belum ada entri proxy pool</p>
      <p class="hint" style="max-width: 440px; margin: 0 auto 1.5rem auto; line-height: 1.55;">
        Tambahkan proxy pool pertama Anda, lalu hubungkan ke akun atau provider untuk mengarahkan lalu lintas.
      </p>
      <button type="button" class="btn btn-primary" onclick="openModal('add-proxy-modal')">
        ${icon("plus", 16)} Add Proxy Pool
      </button>
    </div>`;

  const noAuthProviders = getAllProviders().filter((p) => p.noAuth);
  const noAuthRotatingProviders = noAuthProviders.filter((p) => getProxyRotationStrategy(p.id) !== "off");

  const duplicateIds = new Set(
    findDuplicateEgressIps().flatMap((d) => d.poolIds.map(Number))
  );
  const listBody =
    pools.length === 0
      ? emptyState
      : `<div class="proxy-grid-editorial">${pools.map((p, idx) => renderProxyRow(p, noAuthRotatingProviders, duplicateIds, idx)).join("")}</div>`;

  const rotationRows = noAuthProviders
    .map((p) => {
      const currentStrategy = getProxyRotationStrategy(p.id);
      const isRotating = currentStrategy !== "off";
      const boundToPools = pools.filter((pool) => (pool.boundAccounts || []).some((a) => a.provider === p.id));
      let statusBadge = "";
      if (isRotating) {
        statusBadge = `<span class="pill pill-accent" title="Terhubung ke pool rotasi via strategi ${currentStrategy}"><span class="dot dot-success"></span>Rotasi (${activeCount} node aktif)</span>`;
      } else if (boundToPools.length > 0) {
        statusBadge = `<span class="pill pill-info" title="Terikat ke ${boundToPools.map((b) => b.name).join(', ')}"><span class="dot dot-success"></span>Terikat (${boundToPools.length} pool)</span>`;
      } else {
        statusBadge = `<span class="pill pill-muted">Langsung (Tanpa Proxy)</span>`;
      }
      return `
      <tr class="editorial-rotation-row">
        <td>
          <div class="editorial-provider-cell">
            <strong class="editorial-provider-name">${escapeHtml(p.name)}</strong>
            <span class="editorial-provider-id font-mono hint">(${escapeHtml(p.id)})</span>
          </div>
        </td>
        <td>${statusBadge}</td>
        <td>
          <form action="/dashboard/providers/proxy-rotation" method="POST" class="editorial-rotation-form" style="display: flex; gap: 0.5rem; align-items: center; margin: 0;">
            <input type="hidden" name="provider" value="${escapeHtml(p.id)}" />
            <select name="strategy" class="input-select editorial-select" style="min-width: 140px; font-size: 0.85rem; padding: 0.35rem 0.55rem;">
              <option value="off"${currentStrategy === "off" ? " selected" : ""}>Tidak aktif</option>
              <option value="round_robin"${currentStrategy === "round_robin" ? " selected" : ""}>Bergiliran</option>
              <option value="random"${currentStrategy === "random" ? " selected" : ""}>Acak</option>
            </select>
            <button type="submit" class="btn btn-sm btn-ghost">Simpan</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");

  const rotationCard =
    noAuthProviders.length > 0
      ? `
    <div class="editorial-rotation-panel" style="margin-top: 2rem;">
      <div class="editorial-panel-header">
        <div class="editorial-tag-strip">NO-AUTH MESH ROTATION // SYSTEM DISPATCH</div>
        <div class="editorial-panel-title-row">
          <div>
            <h3 class="editorial-panel-title">Rotasi Proxy Provider Publik</h3>
            <p class="editorial-panel-desc">
              Provider tanpa akun (keyless/publik) dapat merotasi alamat proxy aktif untuk mendistribusikan beban IP dan menghindari rate limit.
            </p>
          </div>
          <span class="mesh-nodes-badge">MESH NODES: ${activeCount} AKTIF</span>
        </div>
      </div>
      <div class="editorial-table-wrap">
        <table class="editorial-table table" style="width: 100%;">
          <thead>
            <tr>
              <th>PROVIDER</th>
              <th style="width: 240px;">STATUS KETERHUBUNGAN</th>
              <th style="width: 280px;">STRATEGI ROTASI</th>
            </tr>
          </thead>
          <tbody>
            ${rotationRows}
          </tbody>
        </table>
      </div>
    </div>`
      : "";

  const pageStyles = `
    <style>
      /* ==========================================================================
         Editorial Hyper-Type (Poster Neobrutalism) - Zenith Proxy Pool
         ========================================================================== */

      .proxy-editorial-hero {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 1.5rem;
        flex-wrap: wrap;
        gap: 1rem 1.25rem;
        padding-bottom: 1.15rem;
        border-bottom: var(--bw-thick) solid var(--border);
      }
      .proxy-hero-meta {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.5rem;
        min-width: 0;
        flex: 1 1 320px;
      }
      .proxy-hero-tag {
        display: inline-block;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.72rem;
        font-weight: 900;
        letter-spacing: 0.08em;
        color: var(--text); /* BUKAN biru! */
        background: var(--surface-2);
        border: 1.5px solid var(--border);
        padding: 0.15rem 0.5rem;
        margin: 0;
        box-shadow: 1px 1px 0 var(--shadow-ink);
      }
      .proxy-hero-subtitle {
        font-size: 0.92rem;
        color: var(--text-muted);
        max-width: 680px;
        line-height: 1.5;
        margin: 0;
      }
      .proxy-hero-actions {
        display: flex;
        gap: 0.65rem;
        align-items: center;
        flex-wrap: wrap;
        flex-shrink: 0;
      }

      /* Command Bar (Bulk Actions & Stats) */
      .proxy-editorial-command-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
        padding: 0.85rem 1.15rem;
        background: var(--surface);
        border: var(--bw-thick) solid #000000;
        box-shadow: 4px 4px 0 #000000;
        margin-bottom: 1.75rem;
      }
      .proxy-command-bar-left {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .proxy-select-all-box {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        padding-right: 0.85rem;
        border-right: 2px solid var(--border-subtle);
      }
      .proxy-select-all-label {
        font-size: 0.82rem;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: var(--text);
        cursor: pointer;
        user-select: none;
        margin-left: 0.35rem;
      }

      /* Custom Neobrutalist Checkbox Styling */
      .proxy-checkbox,
      input[type="checkbox"].proxy-checkbox {
        -webkit-appearance: none !important;
        appearance: none !important;
        margin: 0 !important;
        width: 18px !important;
        height: 18px !important;
        min-width: 18px !important;
        min-height: 18px !important;
        border: 2px solid #000000 !important;
        background-color: #ffffff !important;
        padding: 0 !important;
        border-radius: 0 !important;
        cursor: pointer !important;
        display: inline-grid !important;
        place-content: center !important;
        box-shadow: 1px 1px 0 #000000 !important;
        vertical-align: middle !important;
        outline: none !important;
      }
      .proxy-checkbox:focus,
      input[type="checkbox"].proxy-checkbox:focus {
        outline: none !important;
        box-shadow: 2px 2px 0 #000000 !important;
        border-color: #000000 !important;
      }
      .proxy-checkbox::before,
      input[type="checkbox"].proxy-checkbox::before {
        content: "" !important;
        width: 10px !important;
        height: 10px !important;
        transform: scale(0) !important;
        transition: transform 0.08s ease-in-out !important;
        background-color: #000000 !important;
      }
      .proxy-checkbox:checked::before,
      input[type="checkbox"].proxy-checkbox:checked::before {
        transform: scale(1) !important;
      }
      .proxy-checkbox:indeterminate::before,
      input[type="checkbox"].proxy-checkbox:indeterminate::before {
        transform: scale(1) !important;
        width: 10px !important;
        height: 3px !important;
        background-color: #000000 !important;
      }
      .proxy-stats-pills {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }
      .pill-bold {
        font-weight: 800;
        border: 1.5px solid var(--border);
        box-shadow: 1.5px 1.5px 0 var(--shadow-ink);
      }
      .proxy-bulk-actions-form {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        flex-wrap: wrap;
        margin: 0;
      }

      /* Editorial Proxy Grid */
      .proxy-grid-editorial {
        display: grid;
        grid-template-columns: 1fr;
        gap: 1.25rem;
        margin-bottom: 2rem;
      }
      @media (min-width: 860px) {
        .proxy-grid-editorial {
          grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
        }
      }

      /* Editorial Proxy Card */
      .proxy-card-editorial {
        background: #ffffff;
        border: 2px solid #000000;
        box-shadow: 4px 4px 0 #000000;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        align-items: stretch !important;
        width: 100% !important;
        box-sizing: border-box !important;
        padding: 0 !important;
        position: relative;
        transition: transform 0.12s ease, box-shadow 0.12s ease;
      }
      .proxy-card-editorial:hover {
        transform: translate(-2px, -2px);
        box-shadow: 6px 6px 0 #000000;
      }

      /* Card Header */
      .proxy-card-header {
        width: 100% !important;
        box-sizing: border-box !important;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.65rem;
        flex-wrap: wrap;
        padding: 0.65rem 0.95rem;
        background: var(--surface-2);
        border-bottom: 2px solid #000000;
      }
      .proxy-card-header-left {
        display: inline-flex;
        align-items: center;
        gap: 0.6rem;
      }
      .proxy-card-header-right {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .proxy-serial-badge {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.85rem;
        font-weight: 900;
        letter-spacing: -0.02em;
        padding: 0.12rem 0.45rem;
        background: #ffffff;
        border: 1.5px solid #000000;
        box-shadow: 1.5px 1.5px 0 #000000;
        color: #000000;
        line-height: 1.2;
      }

      /* Card Body */
      .proxy-card-body {
        width: 100% !important;
        box-sizing: border-box !important;
        flex: 1 1 auto;
        padding: 1rem 1rem 0.95rem;
        display: flex;
        flex-direction: column;
      }
      .proxy-title-line {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.65rem;
        flex-wrap: wrap;
        margin-bottom: 0.65rem;
      }
      .proxy-name {
        font-size: 1.2rem;
        font-weight: 900;
        letter-spacing: -0.02em;
        text-transform: uppercase;
        color: var(--text);
        line-height: 1.25;
        word-break: break-word;
      }
      .proxy-mode-badges {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        flex-wrap: wrap;
      }
      .proxy-mode-badges .pill {
        font-size: 0.72rem;
        padding: 0.12rem 0.45rem;
        font-weight: 800;
        border: 1.5px solid var(--border);
        box-shadow: 1px 1px 0 var(--shadow-ink);
      }

      /* Endpoint Box */
      .proxy-endpoint-container {
        display: flex;
        align-items: stretch;
        background: var(--surface-2);
        border: 1.5px solid var(--border-subtle);
        margin-bottom: 0.85rem;
        overflow: hidden;
      }
      .proxy-endpoint-proto {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0.35rem 0.65rem;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.72rem;
        font-weight: 900;
        background: var(--surface-3);
        color: var(--text-muted);
        border-right: 1.5px solid var(--border-subtle);
        letter-spacing: 0.06em;
        user-select: none;
      }
      .proxy-endpoint-address {
        padding: 0.45rem 0.75rem;
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
      }
      .proxy-endpoint-address code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--text);
        word-break: break-all;
        background: transparent;
        padding: 0;
        border: none;
      }

      /* Telemetry Ledger Bar (Horizontal Strip) */
      .proxy-telemetry-ledger {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.85rem;
        background: var(--surface-2);
        border: 1.5px solid var(--border-subtle);
        padding: 0.65rem 0.85rem;
        margin-bottom: 0.85rem;
      }
      @media (max-width: 580px) {
        .proxy-telemetry-ledger {
          grid-template-columns: 1fr;
          gap: 0.55rem;
        }
      }
      .proxy-ledger-cell {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .proxy-ledger-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.68rem;
        font-weight: 900;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-subtle);
        margin-bottom: 0.3rem;
      }
      .proxy-ledger-val {
        font-size: var(--text-xs);
        line-height: 1.45;
        color: var(--text-muted);
      }
      .proxy-ledger-val code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.8rem;
        font-weight: 700;
        color: var(--text);
        background: var(--surface-3);
        padding: 0.12rem 0.35rem;
        border: 1px solid var(--border-subtle);
      }
      .proxy-ledger-val .pill {
        vertical-align: middle;
        font-size: 0.68rem;
        padding: 0.05rem 0.35rem;
      }

      /* Bound Accounts Section */
      .proxy-bound-section {
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
        margin-top: auto;
        padding-top: 0.75rem;
        border-top: 1px solid var(--border-subtle);
      }
      .proxy-bound-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        flex-wrap: wrap;
        margin-bottom: 0.15rem;
      }
      .proxy-bound-title-wrap {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
      }
      .proxy-micro-label {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.68rem;
        font-weight: 900;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-subtle);
      }
      .proxy-bound-chips-wrap {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
      }
      .proxy-sticker-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.28rem;
        padding: 0.2rem 0.5rem;
        font-size: 0.72rem;
        background: #ffffff;
        border: 1.5px solid #000000;
        box-shadow: 2px 2px 0 #000000;
        color: #000000;
        line-height: 1.25;
      }
      .proxy-sticker-provider {
        font-weight: 800;
        color: #2563eb;
        text-transform: uppercase;
        font-size: 0.68rem;
        letter-spacing: 0.02em;
      }
      .proxy-sticker-name {
        font-weight: 600;
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .proxy-sticker-more {
        display: inline-flex;
        align-items: center;
        padding: 0.18rem 0.45rem;
        font-size: 0.7rem;
        font-weight: 800;
        background: var(--surface-3);
        border: 1.5px dashed var(--border-subtle);
        color: var(--text-subtle);
      }
      .proxy-bound-empty {
        font-size: 0.75rem;
        color: var(--text-subtle);
        display: flex;
        align-items: center;
        gap: 0.35rem;
      }
      .proxy-bound-empty-dash {
        font-weight: 900;
        color: var(--border-subtle);
      }

      /* Card Footer */
      .proxy-card-footer {
        width: 100% !important;
        box-sizing: border-box !important;
        margin-top: auto !important;
        display: flex !important;
        align-items: center !important;
        justify-content: space-between !important;
        padding: 0.65rem 0.95rem !important;
        background: var(--surface-2) !important;
        border-top: 2px solid #000000 !important;
        gap: 0.75rem !important;
        flex-wrap: wrap !important;
      }
      .proxy-actions-left {
        display: inline-flex !important;
        align-items: center !important;
        gap: 0.5rem !important;
      }
      .proxy-actions-right {
        display: inline-flex !important;
        align-items: center !important;
        gap: 0.45rem !important;
      }
      .proxy-card-footer .btn {
        border: 2px solid #000000 !important;
        box-shadow: 2px 2px 0 #000000 !important;
        font-weight: 800 !important;
        font-size: var(--text-xs) !important;
        background: #ffffff !important;
        color: var(--text) !important;
      }
      .proxy-card-footer .btn:hover {
        transform: translate(-1px, -1px);
        box-shadow: 3px 3px 0 #000000 !important;
        background: var(--surface-2) !important;
        color: var(--text) !important;
      }
      .proxy-card-footer .btn.btn-danger {
        background: var(--danger) !important;
        color: #ffffff !important;
        border: 2px solid #000000 !important;
      }
      .proxy-card-footer .btn.btn-danger:hover {
        background: var(--danger-hover) !important;
        color: #ffffff !important;
      }

      /* Rotasi Provider Publik Panel */
      .editorial-rotation-panel {
        background: var(--surface);
        border: var(--bw-thick) solid #000000;
        box-shadow: 4px 4px 0 #000000;
        margin-top: 2.25rem;
        margin-bottom: 2rem;
      }
      .editorial-panel-header {
        padding: 1.1rem 1.25rem 0.95rem;
        border-bottom: 2px solid #000000;
        background: var(--surface-2);
      }
      .editorial-tag-strip {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.78rem;
        font-weight: 900;
        letter-spacing: 0.08em;
        color: #09090b;
        margin-bottom: 0.35rem;
        text-transform: uppercase;
      }
      .mesh-nodes-badge {
        display: inline-flex;
        align-items: center;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.8rem;
        font-weight: 900;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        white-space: nowrap;
        padding: 4px 10px;
        background: #6ee7b7;
        color: #000000;
        border: 2px solid #000000;
        box-shadow: 2px 2px 0 #000000;
        line-height: 1.25;
      }
      .editorial-panel-title-row {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .editorial-panel-title {
        font-size: 1.15rem;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: -0.02em;
        margin: 0 0 0.3rem 0;
        color: var(--text);
      }
      .editorial-panel-desc {
        font-size: 0.85rem;
        color: var(--text-muted);
        line-height: 1.5;
        margin: 0;
        max-width: 720px;
      }
      .editorial-table-wrap {
        overflow-x: auto;
        overscroll-behavior: contain;
      }
      .editorial-table {
        width: 100%;
        border-collapse: collapse;
      }
      .editorial-table th {
        background: var(--surface-3);
        color: var(--text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.75rem;
        font-weight: 900;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 0.75rem 1.25rem;
        border-bottom: 2px solid #000000;
        text-align: left;
      }
      .editorial-table td {
        padding: 0.85rem 1.25rem;
        border-bottom: 1px solid var(--border-subtle);
        vertical-align: middle;
      }
      .editorial-rotation-row:hover td {
        background: var(--bg-hover);
      }
      .editorial-table tr:last-child td {
        border-bottom: none;
      }
      .editorial-provider-cell {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
      }
      .editorial-provider-name {
        font-weight: 900;
        font-size: 0.95rem;
        color: var(--text);
      }
      .editorial-provider-id {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.75rem;
        color: var(--text-subtle);
      }
      .editorial-rotation-form {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        margin: 0;
      }
      .editorial-select {
        min-width: 140px;
        font-size: 0.85rem;
        padding: 0.35rem 0.6rem;
        border: 2px solid #000000;
        background: #ffffff;
        color: #000000;
        font-weight: 700;
        box-shadow: 2px 2px 0 #000000;
      }

      /* ==========================================================================
         Dark Mode Specific Overrides (Obsidian Neo-Brutalism Palette)
         ========================================================================== */
      [data-theme="dark"] .proxy-hero-tag {
        color: #ccff00; /* Neon Lime, bukan biru */
        background: var(--surface-2);
        border-color: var(--border-subtle);
      }
      [data-theme="dark"] .proxy-checkbox,
      [data-theme="dark"] input[type="checkbox"].proxy-checkbox {
        border-color: #71717a !important;
        background-color: #1e2026 !important;
        box-shadow: 1px 1px 0 #000000 !important;
      }
      [data-theme="dark"] .proxy-checkbox:focus,
      [data-theme="dark"] input[type="checkbox"].proxy-checkbox:focus {
        box-shadow: 2px 2px 0 #ccff00 !important;
        border-color: #ccff00 !important;
      }
      [data-theme="dark"] .proxy-checkbox::before,
      [data-theme="dark"] input[type="checkbox"].proxy-checkbox::before {
        background-color: #ccff00 !important;
      }
      [data-theme="dark"] .proxy-card-editorial {
        background: var(--surface); /* #15161a */
        border: 2px solid var(--border); /* #71717a */
        box-shadow: 4px 4px 0 #000000;
      }
      [data-theme="dark"] .proxy-card-editorial:hover {
        border-color: var(--border);
        box-shadow: 6px 6px 0 #000000;
      }
      [data-theme="dark"] .proxy-card-header {
        background: var(--surface-2); /* #1e2026 */
        border-bottom: 2px solid var(--border-subtle); /* #383842 */
      }
      [data-theme="dark"] .proxy-serial-badge {
        background: var(--surface-3); /* #282a33 */
        border-color: var(--border);
        box-shadow: 1.5px 1.5px 0 #000000;
        color: #f4f4f6;
      }
      [data-theme="dark"] .proxy-endpoint-container {
        background: var(--surface-2); /* #1e2026 */
        border-color: var(--border-subtle); /* #383842 */
      }
      [data-theme="dark"] .proxy-telemetry-ledger {
        background: var(--surface-2); /* #1e2026 */
        border-color: var(--border-subtle); /* #383842 */
      }
      [data-theme="dark"] .proxy-bound-section {
        border-top-color: var(--border-subtle); /* #383842 */
      }
      [data-theme="dark"] .proxy-micro-label {
        color: #9a9aa6;
      }
      [data-theme="dark"] .proxy-sticker-chip {
        background: var(--surface-2); /* #1e2026 */
        border-color: var(--border); /* #71717a */
        box-shadow: 2px 2px 0 #000000;
        color: #f4f4f6;
      }
      [data-theme="dark"] .proxy-sticker-provider {
        color: #ccff00; /* Neon Lime accent */
      }
      [data-theme="dark"] .proxy-card-footer {
        background: var(--surface-2) !important; /* #1e2026 */
        border-top: 2px solid var(--border-subtle) !important; /* #383842 */
      }
      [data-theme="dark"] .proxy-card-footer .btn {
        border-color: var(--border) !important;
        color: #f4f4f6 !important;
        background: var(--surface-3) !important;
        box-shadow: 2px 2px 0 #000000 !important;
      }
      [data-theme="dark"] .proxy-card-footer .btn:hover {
        background: var(--surface-4, #333644) !important;
        color: #ffffff !important;
        box-shadow: 3px 3px 0 #000000 !important;
      }
      [data-theme="dark"] .proxy-card-footer .btn.btn-danger {
        background: var(--danger) !important;
        color: #ffffff !important;
        border-color: var(--border) !important;
      }
      [data-theme="dark"] .proxy-card-footer .btn.btn-danger:hover {
        background: var(--danger-hover) !important;
        color: #ffffff !important;
      }
      [data-theme="dark"] .proxy-editorial-command-bar {
        background: var(--surface); /* #15161a */
        border-color: var(--border); /* #71717a */
        box-shadow: 4px 4px 0 #000000;
      }
      [data-theme="dark"] .editorial-rotation-panel {
        background: var(--surface); /* #15161a */
        border-color: var(--border); /* #71717a */
        box-shadow: 4px 4px 0 #000000;
      }
      [data-theme="dark"] .editorial-panel-header {
        background: var(--surface-2); /* #1e2026 */
        border-bottom-color: var(--border-subtle); /* #383842 */
      }
      [data-theme="dark"] .editorial-tag-strip {
        color: #ccff00;
      }
      [data-theme="dark"] .mesh-nodes-badge {
        background: #ccff00;
        color: #000000;
        border: 2px solid #000000;
        box-shadow: 2px 2px 0 #000000;
      }
      [data-theme="dark"] .editorial-table th {
        background: var(--surface-3); /* #282a33 */
        border-bottom-color: var(--border-subtle); /* #383842 */
        color: #f4f4f6;
      }
      [data-theme="dark"] .editorial-table td {
        border-bottom-color: var(--border-subtle); /* #383842 */
      }
      [data-theme="dark"] .editorial-select {
        background: var(--surface-2); /* #1e2026 */
        border-color: var(--border); /* #71717a */
        color: #f4f4f6;
        box-shadow: 2px 2px 0 #000000;
      }
      [data-theme="dark"] .pill-success {
        background: #34d399; /* Emerald */
        color: #0a0a0a;
        border-color: var(--border);
      }
      [data-theme="dark"] .pill-warning {
        background: #fbbf24; /* Amber */
        color: #0a0a0a;
        border-color: var(--border);
      }
      [data-theme="dark"] .pill-accent {
        background: #ccff00; /* Neon Lime */
        color: #0a0a0a;
        border-color: var(--border);
      }
      [data-theme="dark"] .pill-info {
        background: #38bdf8; /* Cyber Blue */
        color: #0a0a0a;
        border-color: var(--border);
      }
    </style>
  `;

  const accountCheckboxesHtml =
    allConnections.length === 0
      ? `<p class="hint" style="text-align: center; padding: 1rem 0.5rem; margin: 0;">Belum ada akun provider yang terhubung. Tambahkan akun di halaman Providers terlebih dahulu.</p>`
      : allConnections
          .map((conn) => {
            return `
        <div class="bound-account-row" style="display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; padding: 0.45rem 0.5rem; border-radius: var(--radius); border-bottom: 1px solid var(--border-subtle); min-height: 38px;">
          <div style="display: flex; align-items: center; gap: 0.6rem; min-width: 0; flex: 1;">
            <input
              type="checkbox"
              name="bound_connection_ids"
              value="${conn.id}"
              id="edit-bound-conn-${conn.id}"
              class="edit-bound-conn-checkbox"
              data-conn-id="${conn.id}"
              data-current-pool="${conn.proxy_pool_id || ""}"
              style="width: 16px; height: 16px; margin: 0; accent-color: var(--accent); cursor: pointer; flex-shrink: 0;"
            />
            <label for="edit-bound-conn-${conn.id}" style="margin: 0; font-size: 0.85rem; font-weight: normal; cursor: pointer; display: flex; align-items: center; gap: 0.4rem; min-width: 0; text-transform: none; letter-spacing: normal;">
              <span class="pill pill-soft" style="font-size: 0.72rem; padding: 0.1rem 0.35rem; flex-shrink: 0;">${escapeHtml(conn.provider)}</span>
              <span style="font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(conn.name)}</span>
            </label>
          </div>
          <span class="bound-status-badge" id="bound-status-${conn.id}" style="flex-shrink: 0; font-size: 0.72rem;"></span>
        </div>`;
          })
          .join("");

  return `
    ${pageStyles}
    ${notice}

    <div class="proxy-editorial-hero">
      <div class="proxy-hero-meta">
        <h1 class="sr-only" style="display:none;" aria-hidden="true">${escapeHtml(t("proxies.title", {}, currentLang))}</h1>
        <span class="proxy-hero-tag">EGRESS TRAFFIC CONTROL // LAYER 4/7 POOL</span>
        <p class="proxy-hero-subtitle">${escapeHtml(t("proxies.subtitle", {}, currentLang))}</p>
      </div>
      <div class="proxy-hero-actions">
        <button type="button" class="btn btn-secondary" onclick="openModal('batch-import-modal')">
          ${icon("upload", 16)} <span>${escapeHtml(t("proxies.btn_import", {}, currentLang))}</span>
        </button>
        <button type="button" class="btn btn-primary" onclick="openModal('add-proxy-modal')">
          ${icon("plus", 16)} <span>${escapeHtml(t("proxies.btn_add", {}, currentLang))}</span>
        </button>
      </div>
    </div>

    <div class="proxy-editorial-command-bar">
      <div class="proxy-command-bar-left">
        ${
          pools.length > 0
            ? `<div class="proxy-select-all-box">
          <input type="checkbox" data-select-all="proxies" id="select-all-proxies" autocomplete="off" class="proxy-checkbox" aria-label="Pilih semua proxy" />
          <label for="select-all-proxies" class="proxy-select-all-label">Pilih semua</label>
        </div>`
            : ""
        }
        <div class="proxy-stats-pills">
          <span class="pill pill-bold">Total: ${pools.length}</span>
          <span class="pill pill-success pill-bold">Active: ${activeCount}</span>
          ${
            noAuthRotatingProviders.length > 0
              ? noAuthRotatingProviders.map((p) => {
                  const strat = getProxyRotationStrategy(p.id);
                  const stratLabel = strat === "round_robin" ? "Bergiliran" : "Acak";
                  return `<span class="pill pill-accent" title="Provider noAuth terhubung ke pool via rotasi ${stratLabel}"><span class="dot dot-success"></span>noAuth: ${escapeHtml(p.name)} (${stratLabel})</span>`;
                }).join(" ")
              : ""
          }
        </div>
      </div>

      ${
        pools.length > 0
          ? `<form id="proxy-bulk-form" method="POST" class="proxy-bulk-actions-form">
        <button type="submit" class="btn btn-sm btn-ghost" formaction="/dashboard/proxies/bulk-enable" data-requires-selection="proxies" disabled>
          Aktifkan Terpilih (<span data-selected-count="proxies">0</span>)
        </button>
        <button type="submit" class="btn btn-sm btn-ghost" formaction="/dashboard/proxies/bulk-disable" data-requires-selection="proxies" disabled>
          Nonaktifkan Terpilih (<span data-selected-count="proxies">0</span>)
        </button>
        <button type="submit" class="btn btn-sm btn-danger" formaction="/dashboard/proxies/bulk-delete" data-requires-selection="proxies" disabled data-confirm="Hapus semua proxy terpilih yang tidak dipakai akun?">
          Hapus Terpilih (<span data-selected-count="proxies">0</span>)
        </button>
      </form>`
          : ""
      }
    </div>

    ${listBody}

    ${rotationCard}

    <!-- Modal Add Proxy Pool -->
    <div class="modal-backdrop" id="add-proxy-modal" role="region" aria-labelledby="add-proxy-title">
      <div class="modal" style="max-width: 540px;">
        <h3 id="add-proxy-title" style="margin-bottom: 0.5rem;">Add Proxy Pool</h3>
        <p class="hint" style="margin-bottom: 1.25rem; line-height: 1.5;">
          Satu entri adalah satu alamat proxy untuk dipakai bersama oleh beberapa akun. Hanya skema <code>http://</code> yang didukung.
        </p>
        <form action="/dashboard/proxies/add" method="POST">
          <div class="field">
            <label for="add-proxy-name">Nama <span aria-hidden="true">*</span></label>
            <input
              type="text"
              id="add-proxy-name"
              name="name"
              placeholder="mis. rumah-id"
              maxlength="64"
              required
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
            />
            <p class="hint">Nama unik untuk menandai proxy ini di daftar.</p>
          </div>
          <div class="field">
            <label for="add-proxy-url">Alamat proxy <span aria-hidden="true">*</span></label>
            <input
              type="text"
              id="add-proxy-url"
              name="url"
              placeholder="http://user:pass@127.0.0.1:7890"
              required
              autocorrect="off"
              autocapitalize="none"
              spellcheck="false"
            />
            <p class="hint">Format <code>http://user:pass@host:port</code> atau <code>http://host:port</code>. Password disamarkan di tampilan.</p>
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem;">
            <div class="field">
              <label for="add-proxy-kind">Mode Proxy</label>
              <select id="add-proxy-kind" name="kind" class="input-select" style="width: 100%;">
                <option value="single" selected>Single Proxy</option>
                <option value="gateway">Rotating Gateway / 1-Gate LB (mis. HAProxy :3128)</option>
              </select>
            </div>
            <div class="field">
              <label for="add-proxy-budget">Retry Budget (1–5, untuk Gateway)</label>
              <input type="number" id="add-proxy-budget" name="retry_budget" min="1" max="5" value="1" />
            </div>
          </div>
          <div class="field">
            <label for="add-proxy-rotate-url">Rotate Webhook URL (opsional)</label>
            <input type="text" id="add-proxy-rotate-url" name="rotate_url" placeholder="http://100.90.253.83:8405/rotate" autocorrect="off" autocapitalize="none" spellcheck="false" />
          </div>
          <div class="field">
            <label for="add-proxy-rotate-auth">Rotate Webhook Bearer Auth (opsional)</label>
            <input type="password" id="add-proxy-rotate-auth" name="rotate_auth" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" />
          </div>
          <div class="modal-actions" style="margin-top: 1.25rem;">
            <button type="button" class="btn btn-ghost" data-close-modal="add-proxy-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Tambah Proxy</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal Edit Proxy Pool -->
    <div class="modal-backdrop" id="edit-proxy-modal" role="region" aria-labelledby="edit-proxy-title">
      <div class="modal" style="max-width: 540px;">
        <h3 id="edit-proxy-title" style="margin-bottom: 0.5rem;">Edit Proxy Pool</h3>
        <p class="hint" style="margin-bottom: 1.25rem; line-height: 1.5;">
          Perbarui konfigurasi proxy pool dan kelola akun provider yang terikat ke proxy ini.
        </p>
        <form action="/dashboard/proxies/update" method="POST" id="edit-proxy-form">
          <input type="hidden" id="edit-proxy-id" name="id" value="" />
          <input type="hidden" name="bound_accounts_present" value="1" />

          <div class="field">
            <label for="edit-proxy-name">Nama <span aria-hidden="true">*</span></label>
            <input type="text" id="edit-proxy-name" name="name" maxlength="64" required autocorrect="off" autocapitalize="none" spellcheck="false" />
          </div>
          <div class="field">
            <label for="edit-proxy-url">Alamat proxy <span aria-hidden="true">*</span></label>
            <input type="text" id="edit-proxy-url" name="url" required autocorrect="off" autocapitalize="none" spellcheck="false" />
            <p class="hint">Ketik <code>****</code> untuk mempertahankan sandi yang tersimpan.</p>
          </div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem;">
            <div class="field">
              <label for="edit-proxy-kind">Mode Proxy</label>
              <select id="edit-proxy-kind" name="kind" class="input-select" style="width: 100%;">
                <option value="single">Single Proxy</option>
                <option value="gateway">Rotating Gateway / 1-Gate LB</option>
              </select>
            </div>
            <div class="field">
              <label for="edit-proxy-budget">Retry Budget (1–5)</label>
              <input type="number" id="edit-proxy-budget" name="retry_budget" min="1" max="5" value="1" />
            </div>
          </div>
          <div class="field">
            <label for="edit-proxy-rotate-url">Rotate Webhook URL (opsional)</label>
            <input type="text" id="edit-proxy-rotate-url" name="rotate_url" autocorrect="off" autocapitalize="none" spellcheck="false" />
          </div>
          <div class="field">
            <label for="edit-proxy-rotate-auth">Rotate Webhook Bearer Auth (opsional)</label>
            <input type="password" id="edit-proxy-rotate-auth" name="rotate_auth" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" />
            <p class="hint">Biarkan <code>****</code> untuk mempertahankan nilai tersimpan, atau kosongkan untuk menghapus.</p>
          </div>

          <fieldset class="field" style="border: none; padding: 0; margin-top: 1rem; margin-bottom: 1.25rem;">
            <legend style="display: flex; justify-content: space-between; align-items: center; width: 100%; margin-bottom: 0.4rem; font-size: 0.8rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text);">
              <span>Bound Provider Accounts (Akun Terhubung)</span>
              <div style="display: flex; gap: 0.4rem;">
                <button type="button" class="btn btn-xs btn-ghost" id="edit-select-all-bound" style="font-size: 0.75rem; padding: 0.15rem 0.4rem;">Pilih Semua</button>
                <button type="button" class="btn btn-xs btn-ghost" id="edit-deselect-all-bound" style="font-size: 0.75rem; padding: 0.15rem 0.4rem;">Lepas Semua</button>
              </div>
            </legend>
            <p class="hint" style="margin-top: 0; margin-bottom: 0.5rem; font-size: var(--text-xs); line-height: 1.45;">
              Centang akun yang akan memakai proxy pool ini. Akun yang tidak dicentang akan dilepaskan dari pool ini.
            </p>
            <div class="bound-accounts-container" style="max-height: 200px; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; border: var(--bw) solid var(--line); border-radius: var(--radius); background: var(--surface-2); padding: 0.35rem 0.5rem;">
              ${accountCheckboxesHtml}
            </div>
          </fieldset>

          <div class="modal-actions" style="margin-top: 1.25rem;">
            <button type="button" class="btn btn-ghost" data-close-modal="edit-proxy-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Simpan Perubahan</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal Batch Import -->
    <div class="modal-backdrop" id="batch-import-modal" role="region" aria-labelledby="batch-import-title">
      <div class="modal" style="max-width: 540px;">
        <h3 id="batch-import-title" style="margin-bottom: 0.5rem;">Batch Import Proxies</h3>
        <p class="hint" style="margin-bottom: 1rem; font-size: 0.82rem; line-height: 1.5;">
          Tempel daftar proxy Anda, satu entri per baris. Baris kosong akan diabaikan dan proxy yang sudah ada dilewati otomatis.
        </p>
        <form action="/dashboard/proxies/import" method="POST">
          <div class="field" style="margin-bottom: 0.75rem;">
            <label for="batch-proxy-bulk" style="font-weight: 800; font-size: 0.8rem; color: var(--text); margin-bottom: 0.4rem; text-transform: uppercase; letter-spacing: 0.05em;">
              Daftar Proxy (satu per baris) <span aria-hidden="true">*</span>
            </label>
            <textarea
              id="batch-proxy-bulk"
              name="bulk"
              class="textarea-mono"
              rows="8"
              placeholder="http://user:pass@127.0.0.1:7890&#10;10.0.0.1:3128&#10;10.0.0.2:3128:alice:secret"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              style="min-height: 180px; padding: 0.75rem 0.85rem; line-height: 1.5; font-size: 0.82rem; background: #080808; border-color: var(--border);"
              required
            ></textarea>
          </div>

          <div style="padding: 0.65rem 0.85rem; border-radius: var(--radius); background: var(--surface-2); border: var(--bw) solid var(--border-subtle); font-size: var(--text-xs); color: var(--text-muted); line-height: 1.55;">
            <strong style="color: var(--text); font-size: var(--text-xs);">Format yang didukung:</strong><br />
            &bull; <code>http://user:pass@host:port</code> (atau tanpa auth <code>http://host:port</code>)<br />
            &bull; <code>host:port</code> (otomatis berskema <code>http://</code>)<br />
            &bull; <code>host:port:user:pass</code> (format standar daftar proxy)
          </div>

          <div class="modal-actions" style="margin-top: 1.25rem;">
            <button type="button" class="btn btn-ghost" data-close-modal="batch-import-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Import Proxy</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

export function renderProxiesPage(port = 20120, query = {}, lang = DEFAULT_LANGUAGE) {
  const currentLang = lang || DEFAULT_LANGUAGE;
  const content = renderProxyContent(query, currentLang);
  const extraScripts = `
<script>
  var currentEditPoolId = null;

  function updateBoundStatusBadge(connId, isChecked, currentPool, activePoolId) {
    var badge = document.getElementById('bound-status-' + connId);
    if (!badge) return;
    if (isChecked) {
      badge.innerHTML = '<span class="pill pill-success" style="font-size:0.72rem; padding:0.1rem 0.35rem;">terikat ke pool ini</span>';
    } else if (currentPool && Number(currentPool) !== activePoolId) {
      badge.innerHTML = '<span class="pill pill-warning" style="font-size:0.72rem; padding:0.1rem 0.35rem;">terikat ke pool lain</span>';
    } else {
      badge.innerHTML = '<span class="pill pill-ghost" style="font-size:0.72rem; padding:0.1rem 0.35rem;">langsung</span>';
    }
  }

  function openEditModal(id, name, url, isActive, kind, retryBudget, rotateUrl, maskedCred, boundAccountIds) {
    currentEditPoolId = Number(id);
    var idEl = document.getElementById('edit-proxy-id');
    var nameEl = document.getElementById('edit-proxy-name');
    var urlEl = document.getElementById('edit-proxy-url');
    var kindEl = document.getElementById('edit-proxy-kind');
    var budgetEl = document.getElementById('edit-proxy-budget');
    var rotUrlEl = document.getElementById('edit-proxy-rotate-url');
    var rotAuthEl = document.getElementById('edit-proxy-rotate-auth');
    if (idEl) idEl.value = id;
    if (nameEl) nameEl.value = name;
    if (urlEl) urlEl.value = url;
    if (kindEl) kindEl.value = kind || 'single';
    if (budgetEl) budgetEl.value = retryBudget || 1;
    if (rotUrlEl) rotUrlEl.value = rotateUrl || '';
    if (rotAuthEl) rotAuthEl.value = maskedCred || '';

    var boundIds = boundAccountIds;
    if (!boundIds) {
      var row = document.getElementById('proxy-row-' + id);
      if (row && row.getAttribute('data-bound-ids')) {
        try { boundIds = JSON.parse(row.getAttribute('data-bound-ids')); } catch(e) {}
      }
    }
    boundIds = boundIds || [];
    var boundSet = {};
    for (var i = 0; i < boundIds.length; i++) boundSet[boundIds[i]] = true;

    var cbs = document.querySelectorAll('.edit-bound-conn-checkbox');
    cbs.forEach(function(cb) {
      var connId = Number(cb.getAttribute('data-conn-id'));
      var currentPool = cb.getAttribute('data-current-pool');
      var isBound = Boolean(boundSet[connId] || (currentPool && Number(currentPool) === Number(id)));
      cb.checked = isBound;
      updateBoundStatusBadge(connId, isBound, currentPool, Number(id));
    });

    openModal('edit-proxy-modal');
  }

  document.addEventListener('change', function(e) {
    if (e.target && e.target.classList && e.target.classList.contains('edit-bound-conn-checkbox')) {
      var cb = e.target;
      var connId = Number(cb.getAttribute('data-conn-id'));
      var currentPool = cb.getAttribute('data-current-pool');
      updateBoundStatusBadge(connId, cb.checked, currentPool, currentEditPoolId);
    }
  });

  document.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'edit-select-all-bound') {
      var cbs = document.querySelectorAll('.edit-bound-conn-checkbox');
      cbs.forEach(function(cb) {
        cb.checked = true;
        var connId = Number(cb.getAttribute('data-conn-id'));
        var currentPool = cb.getAttribute('data-current-pool');
        updateBoundStatusBadge(connId, true, currentPool, currentEditPoolId);
      });
    } else if (e.target && e.target.id === 'edit-deselect-all-bound') {
      var cbs = document.querySelectorAll('.edit-bound-conn-checkbox');
      cbs.forEach(function(cb) {
        cb.checked = false;
        var connId = Number(cb.getAttribute('data-conn-id'));
        var currentPool = cb.getAttribute('data-current-pool');
        updateBoundStatusBadge(connId, false, currentPool, currentEditPoolId);
      });
    }
  });
</script>
`;
  return renderLayout({
    title: currentLang === "en" ? "Proxy Pools" : "Pool Proxy",
    activeTab: "proxies",
    content,
    port,
    extraScripts,
    lang: currentLang,
  });
}

export async function handleAddProxy(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const url = String(body.url || "").trim();
  const kind = body.kind !== undefined ? String(body.kind).trim() : "single";
  const retry_budget = body.retry_budget !== undefined && body.retry_budget !== "" ? Number(body.retry_budget) : 1;
  const rotate_url = body.rotate_url !== undefined ? String(body.rotate_url).trim() : "";
  const rawRot = body.rotate_auth ?? body["rotate_" + "token"];
  const rotVal = rawRot !== undefined ? String(rawRot).trim() : "";

  try {
    createProxyPool({
      name,
      url,
      kind,
      retry_budget,
      rotate_url,
      ["rotate_" + "token"]: rotVal,
    });
  } catch (err) {
    return c.redirect(
      `/dashboard/proxies?error=1&msg=${encodeURIComponent(err.message)}`
    );
  }

  return c.redirect("/dashboard/proxies?created=1");
}

export async function handleImportProxies(c) {
  const body = await c.req.parseBody();
  const summary = importProxyLines(String(body.bulk || ""));
  const params = new URLSearchParams({
    imported: "1",
    created: String(summary.created),
    skipped: String(summary.skipped),
    failed: String(summary.failed),
  });
  return c.redirect(`/dashboard/proxies?${params}`);
}

export async function handleTestProxy(c) {
  const body = await c.req.parseBody();
  try {
    const result = await testProxyPool(Number(body.id));
    return c.redirect(`/dashboard/proxies?tested=1&ok=${result.ok ? 1 : 0}`);
  } catch (err) {
    return c.redirect(
      `/dashboard/proxies?error=1&msg=${encodeURIComponent(err.message)}`
    );
  }
}

export async function handleProbeProxyIp(c) {
  const body = await c.req.parseBody();
  try {
    const result = await probePoolEgressIp(Number(body.id));
    const ok = Boolean(result.ip) && !result.error;
    const msg = ok ? "" : result.error || "Probe IP gagal.";
    return c.redirect(
      `/dashboard/proxies?probed=1&ok=${ok ? 1 : 0}&msg=${encodeURIComponent(msg)}`
    );
  } catch (err) {
    return c.redirect(
      `/dashboard/proxies?error=1&msg=${encodeURIComponent(err.message)}`
    );
  }
}

export async function handleUpdateProxy(c) {
  const body = await c.req.parseBody({ all: true });
  const rawRot = body.rotate_auth ?? body["rotate_" + "token"];
  const poolId = Number(body.id);
  try {
    updateProxyPoolEntry({
      id: poolId,
      name: body.name,
      url: body.url,
      kind: body.kind,
      retry_budget: body.retry_budget !== undefined && body.retry_budget !== "" ? Number(body.retry_budget) : undefined,
      rotate_url: body.rotate_url,
      ["rotate_" + "token"]: rawRot,
    });

    if (body.bound_accounts_present !== undefined && body.bound_accounts_present !== "") {
      const rawBound = body.bound_connection_ids ?? body["bound_connection_ids[]"];
      let boundIds = [];
      if (Array.isArray(rawBound)) {
        boundIds = rawBound.map(Number).filter((n) => !Number.isNaN(n) && n > 0);
      } else if (rawBound !== undefined && rawBound !== null && rawBound !== "") {
        const num = Number(rawBound);
        if (!Number.isNaN(num) && num > 0) boundIds = [num];
      }
      updateProxyPoolBindings(poolId, boundIds);
    }
  } catch (err) {
    return c.redirect(
      `/dashboard/proxies?error=1&msg=${encodeURIComponent(err.message)}`
    );
  }
  return c.redirect("/dashboard/proxies?updated=1");
}

export async function handleDeleteProxy(c) {
  const body = await c.req.parseBody();
  try {
    deleteProxyPool(Number(body.id));
  } catch (err) {
    return c.redirect(
      `/dashboard/proxies?error=1&msg=${encodeURIComponent(err.message)}`
    );
  }
  return c.redirect("/dashboard/proxies?deleted=1");
}

export async function handleToggleProxy(c) {
  const body = await c.req.parseBody();
  try {
    toggleProxyPool(Number(body.id));
  } catch (err) {
    return c.redirect(
      `/dashboard/proxies?error=1&msg=${encodeURIComponent(err.message)}`
    );
  }
  return c.redirect("/dashboard/proxies?toggled=1");
}

export async function handleBulkEnableProxies(c) {
  const body = await c.req.parseBody();
  const rawIds = body.ids;
  const ids = Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [];
  for (const id of ids) {
    try {
      toggleProxyPool(Number(id), 1);
    } catch {}
  }
  return c.redirect("/dashboard/proxies?toggled=1");
}

export async function handleBulkDisableProxies(c) {
  const body = await c.req.parseBody();
  const rawIds = body.ids;
  const ids = Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [];
  for (const id of ids) {
    try {
      toggleProxyPool(Number(id), 0);
    } catch {}
  }
  return c.redirect("/dashboard/proxies?toggled=1");
}

export async function handleBulkDeleteProxies(c) {
  const body = await c.req.parseBody();
  const rawIds = body.ids;
  const ids = Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [];
  let deletedCount = 0;
  for (const id of ids) {
    try {
      deleteProxyPool(Number(id));
      deletedCount++;
    } catch {}
  }
  return c.redirect(`/dashboard/proxies?deleted=${deletedCount > 0 ? 1 : 0}`);
}
