import {
  createCombo,
  updateCombo,
  renameCombo,
  moveComboMember,
  setComboEnabled,
  deleteCombo,
  getComboByName,
  listCombos,
} from "../../services/combos.js";
import { escapeHtml } from "../html.js";

// The chain is ordered under fallback and rotates under round-robin.
const STRATEGY_OPTIONS = [
  { value: "fallback", label: "Urutan (fallback)" },
  { value: "round-robin", label: "Giliran (round-robin)" },
];

/** One chain row: position badge, the member, reorder buttons, and delete button. */
function renderMemberRow(name, member, index, total, combo) {
  const isUpDisabled = index === 0;
  const isDownDisabled = index === total - 1;
  const formattedOrder = `#${String(index + 1).padStart(2, "0")}`;
  const remainingModels = combo.models.filter((_, idx) => idx !== index).join("\n");

  const row = `
    <div class="combo-member" data-model="${escapeHtml(member)}">
      <span class="combo-order">${formattedOrder}</span>
      <code>${escapeHtml(member)}</code>
      <div class="combo-row-actions">
        <form action="/dashboard/combos/reorder" method="POST" class="combo-move">
          <input type="hidden" name="name" value="${escapeHtml(name)}" />
          <input type="hidden" name="index" value="${index}" />
          <button type="submit" name="direction" value="up" class="btn btn-ghost btn-xs" title="Naikkan prioritas" ${
            isUpDisabled ? "disabled" : ""
          }>&uarr;</button>
          <button type="submit" name="direction" value="down" class="btn btn-ghost btn-xs" title="Turunkan prioritas" ${
            isDownDisabled ? "disabled" : ""
          }>&darr;</button>
        </form>
        <form action="/dashboard/combos/update" method="POST" class="combo-remove-member" data-confirm="Hapus model ini dari rantai?">
          <input type="hidden" name="name" value="${escapeHtml(name)}" />
          <input type="hidden" name="strategy" value="${escapeHtml(combo.strategy)}" />
          <input type="hidden" name="models" value="${escapeHtml(remainingModels)}" />
          <button type="submit" class="btn btn-ghost btn-xs btn-remove" title="Hapus dari rantai">&times;</button>
        </form>
      </div>
    </div>`;
  return row;
}

/** Detail card for the currently selected combo. */
function renderComboDetailCard(combo) {
  const name = escapeHtml(combo.name);
  const total = combo.models.length;
  const isZenith = combo.name.startsWith("zenith-");

  return `
    <div class="card combo-card">
      <div class="card-head combo-detail-head">
        <div class="combo-detail-title-group">
          <h3>${name}</h3>
          ${
            isZenith
              ? `<span class="pill pill-accent">MANAGED 100% FREE</span>`
              : `<span class="pill">CUSTOM</span>`
          }
        </div>
        <div class="combo-card-actions">
          ${
            combo.enabled === 1
              ? `<span class="pill pill-success">Aktif</span>`
              : `<span class="pill">Nonaktif</span>`
          }
          <form action="/dashboard/combos/toggle" method="POST">
            <input type="hidden" name="name" value="${name}" />
            <button type="submit" class="btn btn-ghost btn-sm">${combo.enabled === 1 ? "Nonaktifkan" : "Aktifkan"}</button>
          </form>
          <button type="button" class="btn btn-ghost btn-sm" onclick="openRenameCombo()" title="Ubah nama combo">Ubah Nama</button>
          <form action="/dashboard/combos/delete" method="POST"
                data-confirm="Hapus combo ini beserta definisinya?">
            <input type="hidden" name="name" value="${name}" />
            <button type="submit" class="btn btn-danger btn-sm">Hapus</button>
          </form>
        </div>
      </div>

      <div class="combo-card-row">
        <span class="combo-card-label">Strategi</span>
        <div class="combo-card-value">
          <form action="/dashboard/combos/update" method="POST">
            <input type="hidden" name="name" value="${name}" />
            <select name="strategy" class="input-select" onchange="this.form.submit()">
              ${STRATEGY_OPTIONS.map(
                (s) => `<option value="${s.value}" ${combo.strategy === s.value ? "selected" : ""}>${escapeHtml(s.label)}</option>`
              ).join("")}
            </select>
            <noscript><button type="submit" class="btn btn-ghost">Simpan</button></noscript>
          </form>
        </div>
      </div>

      <div class="combo-card-row">
        <span class="combo-card-label">Integrasi Klien</span>
        <div class="combo-card-value">
          <div class="combo-client-box">
            <code>zenith-router/${name}</code>
            <button type="button" class="btn btn-ghost btn-sm btn-copy-combo" onclick="copyCombo(this, 'zenith-router/${name}')">Salin</button>
          </div>
        </div>
      </div>

      <div class="combo-card-row">
        <span class="combo-card-label">Rantai (${total})</span>
        <div class="combo-card-value">
          ${
            total > 5
              ? `<div class="combo-chain-search-wrap">
                   <input type="search" class="combo-chain-search" placeholder="Cari dalam rantai model (${total} model)…" autocomplete="off" oninput="filterChainMembers(this)" />
                 </div>`
              : ""
          }
          <div class="combo-chain-matrix">
            ${
              total === 0
                ? `<span class="hint">Belum ada anggota</span>`
                : combo.models.map((m, i) => renderMemberRow(combo.name, m, i, total, combo)).join("")
            }
          </div>
        </div>
      </div>

      <details class="combo-card-details">
        <summary class="hint">Edit</summary>
        <form action="/dashboard/combos/rename" method="POST" class="combo-rename-form">
          <input type="hidden" name="name" value="${name}" />
          <input type="text" name="new_name" value="${name}" maxlength="64" required />
          <button type="submit" class="btn btn-ghost">Simpan nama</button>
        </form>
        <form action="/dashboard/combos/update" method="POST" class="combo-edit-chain">
          <input type="hidden" name="name" value="${name}" />
          <input type="hidden" name="strategy" value="${escapeHtml(combo.strategy)}" />
          <div class="combo-chain-editor">
            <button type="button" class="btn btn-ghost" data-picker-open>+ Tambah Model dari Picker</button>
            <textarea name="models" rows="${Math.max(3, total)}">${escapeHtml(combo.models.join("\n"))}</textarea>
            <ul class="combo-selected"></ul>
          </div>
          <button type="submit" class="btn btn-primary btn-sm" style="margin-top: 0.5rem;">Simpan rantai</button>
        </form>
      </details>
    </div>`;
}

/** Master sidebar list item. */
function renderMasterItem(combo, isSelected) {
  const name = escapeHtml(combo.name);
  const isZenith = combo.name.startsWith("zenith-");
  const count = combo.models.length;
  const strat = combo.strategy === "round-robin" ? "Round-robin" : "Fallback";
  const firstModel = combo.models[0] || "Belum ada model";

  return `
    <a href="/dashboard/providers?tab=combos&selected=${encodeURIComponent(combo.name)}"
       class="combo-item ${isSelected ? "active" : ""}"
       data-name="${escapeHtml(combo.name.toLowerCase())}">
      <div class="combo-item-top">
        <div class="combo-item-title-wrap">
          ${isZenith ? `<span class="combo-zenith-badge" title="Managed 100% Free">Z</span>` : ""}
          <strong class="combo-item-name" title="${name}">${name}</strong>
        </div>
        ${
          combo.enabled === 1
            ? `<span class="pill pill-success pill-xs">Aktif</span>`
            : `<span class="pill pill-xs">Nonaktif</span>`
        }
      </div>
      <div class="combo-item-meta">
        <span class="combo-item-count">${count} model</span>
        <span class="combo-item-dot">&bull;</span>
        <span class="combo-item-strat">${strat}</span>
      </div>
      <div class="combo-item-priority">
        <span class="combo-p1-label">#1:</span>
        <code class="combo-p1-name" title="${escapeHtml(firstModel)}">${escapeHtml(firstModel)}</code>
      </div>
    </a>`;
}

export function renderCombosContent(query = {}) {
  const combos = listCombos();

  const notice =
    query.created === "1"
      ? `<div class="notice notice-ok"><span>Combo berhasil dibuat.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
      : query.updated === "1"
        ? `<div class="notice notice-ok"><span>Combo berhasil diperbarui.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : query.deleted === "1"
          ? `<div class="notice notice-ok"><span>Combo berhasil dihapus.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
          : query.error === "1"
            ? `<div class="notice notice-error"><span>${escapeHtml(query.msg || "Combo gagal disimpan.")}</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
            : "";

  const selectedName = (query.selected || "").trim();
  let selectedCombo = combos.find((c) => c.name === selectedName);
  if (!selectedCombo && combos.length > 0) {
    selectedCombo = combos[0];
  }

  const masterPane = `
    <div class="combos-master-pane">
      <div class="combos-master-header">
        <h3 class="combos-section-title">Combos (${combos.length})</h3>
        <button type="button" class="btn btn-primary btn-sm" onclick="openModal('create-combo-modal')">+ Buat Combo Baru</button>
      </div>
      <div class="combo-search-box">
        <input type="search" id="combo-search-input" placeholder="Saring nama combo…" autocomplete="off" oninput="filterComboList(this.value)" />
      </div>
      <div class="combo-master-list" id="combo-master-list">
        ${combos.map((c) => renderMasterItem(c, selectedCombo && c.name === selectedCombo.name)).join("")}
        <div id="combo-search-empty" class="hint" style="display: none; padding: 0.75rem 0.5rem; text-align: center;">Tidak ada combo yang cocok.</div>
      </div>
    </div>`;

  const detailPane = `
    <div class="combos-detail-pane">
      ${
        combos.length === 0
          ? `<div class="card"><div class="empty"><p class="big">Belum ada combo</p><p>Buat combo pertama lewat tombol di atas atau form pembuatan, lalu panggil namanya seperti model biasa.</p></div></div>`
          : renderComboDetailCard(selectedCombo)
      }
    </div>`;

  const content = `
    ${notice}

    <div class="combos-layout">
      ${masterPane}
      ${detailPane}
    </div>

    <div class="modal-backdrop" id="create-combo-modal">
      <div class="modal combo-create-modal">
        <div class="modal-head" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">
          <h3 style="margin: 0;">Buat Combo Baru</h3>
          <button type="button" class="btn btn-ghost btn-sm" data-close-modal="create-combo-modal">&times;</button>
        </div>
        <p class="hint" style="margin-bottom: 1rem;">
          Combo adalah rantai model lintas provider yang dipanggil dengan satu nama.
          Urutan dari atas ke bawah adalah urutan percobaan: anggota berikutnya hanya dicoba
          saat anggota di atasnya gagal karena kondisi account, rate limit, atau upstream yang sibuk.
        </p>
        <form action="/dashboard/combos/create" method="POST">
          <div class="field">
            <label for="combo-name">Nama combo</label>
            <input
              type="text"
              id="combo-name"
              name="name"
              placeholder="mis. cepat-dan-hemat"
              maxlength="64"
              required
            />
            <p class="hint">
              Hanya huruf, angka, titik, garis, dan garis bawah. Nama yang berawalan nama model
              milik provider otomatis ditolak.
            </p>
          </div>
          <div class="field">
            <label for="combo-models">Anggota rantai</label>
            <div class="combo-chain-editor">
              <button type="button" class="btn btn-ghost" data-picker-open>Pilih model…</button>
              <textarea
                id="combo-models"
                name="models"
                rows="4"
                placeholder="together/meta-llama/Llama-3-70b-chat-hf&#10;glm/glm-4-flash"
              ></textarea>
              <ul class="combo-selected"></ul>
            </div>
            <p class="hint">Satu model per baris, ditulis <code>provider/model</code>. Baris pertama adalah anggota yang dicoba lebih dulu. Baris kosong dan anggota yang sama lebih dari sekali diabaikan.</p>
          </div>
          <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.25rem;">
            <button type="button" class="btn btn-ghost" data-close-modal="create-combo-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Buat Combo</button>
          </div>
        </form>
      </div>
    </div>

    <div class="modal-backdrop" id="model-picker-modal">
      <div class="modal combo-picker">
        <h3>Pilih model</h3>
        <input type="search" id="combo-picker-search" placeholder="Cari model atau provider…" autocomplete="off" />
        <div id="combo-picker-list" class="combo-picker-list"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" data-close-modal="model-picker-modal">Selesai</button>
        </div>
      </div>
    </div>

    <style>
      .combos-layout {
        display: flex;
        gap: 1.25rem;
        align-items: flex-start;
      }
      @media (max-width: 860px) {
        .combos-layout {
          flex-direction: column;
        }
      }
      .combos-master-pane {
        flex: 0 0 340px;
        width: 340px;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }
      @media (max-width: 860px) {
        .combos-master-pane {
          width: 100%;
          flex: 1 1 auto;
        }
      }
      .combos-detail-pane {
        flex: 1;
        min-width: 0;
      }
      .combos-master-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .combos-section-title {
        font-size: 0.95rem;
        font-weight: 800;
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .combo-search-box {
        position: relative;
      }
      .combo-search-box input[type="search"] {
        width: 100%;
        box-sizing: border-box;
        padding: 0.45rem 0.65rem;
        font-size: 0.85rem;
        background: var(--surface);
        border: 2px solid var(--line);
        color: var(--text);
        box-shadow: 2px 2px 0 var(--shadow-ink);
      }
      .combo-search-box input[type="search"]:focus {
        outline: 3px solid var(--accent);
        outline-offset: 1px;
      }
      .combo-master-list {
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        max-height: calc(100vh - 240px);
        overflow-y: auto;
        padding-right: 3px;
      }
      .combo-item {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        padding: 0.75rem 0.85rem;
        background: var(--surface);
        border: 2px solid var(--line);
        box-shadow: 2px 2px 0 var(--shadow-ink);
        text-decoration: none;
        color: var(--text);
        cursor: pointer;
        transition: transform 0.1s ease, box-shadow 0.1s ease, background 0.1s ease;
        position: relative;
      }
      .combo-item:hover {
        background: var(--surface-2);
        transform: translate(-1px, -1px);
        box-shadow: var(--hard-sm);
      }
      .combo-item.active {
        background: var(--surface-2);
        border: 2px solid var(--line);
        border-left: 6px solid var(--accent-lime);
        box-shadow: 3px 3px 0 var(--shadow-ink);
        transform: translate(-1px, -1px);
      }
      [data-theme="dark"] .combo-item.active {
        border-left-color: var(--accent-lime);
      }
      .combo-item-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .combo-item-title-wrap {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        min-width: 0;
      }
      .combo-item-name {
        font-size: 0.9rem;
        font-weight: 700;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .combo-zenith-badge {
        background: var(--accent-lime);
        color: #0a0a0a;
        font-size: 0.65rem;
        font-weight: 800;
        padding: 0.1rem 0.35rem;
        border: 1.5px solid var(--line);
        line-height: 1;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        flex-shrink: 0;
      }
      .combo-item-meta {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: var(--text-xs);
        color: var(--text-muted);
      }
      .combo-item-dot {
        opacity: 0.5;
      }
      .combo-item-priority {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        font-size: var(--text-xs);
        color: var(--text-subtle);
        margin-top: 0.15rem;
        overflow: hidden;
      }
      .combo-p1-label {
        font-weight: 700;
        color: var(--text-muted);
        flex-shrink: 0;
      }
      .combo-p1-name {
        font-size: 0.78rem;
        color: var(--text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        background: var(--surface);
        padding: 0.1rem 0.3rem;
        border: 1px solid var(--border-subtle);
      }
      .pill-xs {
        font-size: 0.7rem;
        padding: 0.1rem 0.45rem;
        line-height: 1.2;
      }
      .combo-detail-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
        border-bottom: 2px solid var(--line);
        padding-bottom: 0.85rem;
        margin-bottom: 0.85rem;
      }
      .combo-detail-title-group {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        flex-wrap: wrap;
      }
      .combo-detail-title-group h3 {
        font-size: 1.25rem;
        font-weight: 800;
        margin: 0;
        word-break: break-word;
      }
      .combo-client-box {
        display: inline-flex;
        align-items: center;
        gap: 0.6rem;
        background: var(--surface-2);
        border: 2px solid var(--line);
        box-shadow: 2px 2px 0 var(--shadow-ink);
        padding: 0.35rem 0.65rem;
        max-width: 100%;
        box-sizing: border-box;
      }
      .combo-client-box code {
        font-family: var(--font-mono);
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text);
        user-select: all;
        overflow-wrap: anywhere;
      }
      .btn-copy-combo {
        padding: 0.2rem 0.55rem;
        font-size: 0.75rem;
        font-weight: 700;
        border: 1.5px solid var(--line);
        background: var(--surface);
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .btn-copy-combo.btn-copied {
        background: var(--accent-lime);
        color: #0a0a0a;
        border-color: var(--line);
      }
      .combo-chain-search-wrap {
        margin-bottom: 0.5rem;
      }
      .combo-chain-search {
        width: 100%;
        box-sizing: border-box;
        padding: 0.45rem 0.65rem;
        font-size: 0.85rem;
        background: var(--surface);
        border: 2px solid var(--line);
        color: var(--text);
        box-shadow: 2px 2px 0 var(--shadow-ink);
      }
      .combo-chain-search:focus {
        outline: 3px solid var(--accent);
        outline-offset: 1px;
      }
      .combo-chain-matrix {
        max-height: 450px;
        overflow-y: auto;
        overflow-x: hidden;
        border: 2px solid var(--line);
        box-shadow: 2px 2px 0 var(--shadow-ink);
        background: var(--surface-2);
        padding: 0.45rem;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .combo-member {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        background: var(--surface);
        border: 1.5px solid var(--line);
        padding: 0.35rem 0.6rem;
        transition: background 0.1s ease;
      }
      .combo-member:hover {
        background: var(--surface-2);
      }
      .combo-order {
        font-family: var(--font-mono);
        font-size: 0.75rem;
        font-weight: 800;
        color: var(--text-muted);
        min-width: 2.2em;
        flex-shrink: 0;
      }
      .combo-member code {
        flex: 1;
        min-width: 0;
        font-size: 0.84rem;
        overflow-wrap: anywhere;
      }
      .combo-row-actions {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        flex-shrink: 0;
      }
      .combo-row-actions form {
        display: inline-flex;
        margin: 0;
      }
      #model-picker-modal {
        z-index: 100;
      }
      .btn-xs {
        padding: 0.15rem 0.4rem;
        min-height: auto;
        font-size: 0.8rem;
        line-height: 1.1;
      }
      .btn-remove {
        color: var(--danger);
        font-weight: bold;
      }
      .btn-remove:hover {
        background: rgba(239, 68, 68, 0.15);
        color: var(--danger);
      }
      .combo-card-actions { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
      .combo-card-actions form { display: flex; gap: 0.35rem; }
      .combo-card-row { display: flex; align-items: flex-start; gap: 0.9rem; margin-top: 0.85rem; }
      .combo-card-label { flex: none; width: 6.5rem; padding-top: 0.3rem; font-size: var(--text-xs); font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-subtle); }
      .combo-card-value { flex: 1; min-width: 0; }
      .combo-card-details { margin-top: 0.9rem; padding-top: 0.6rem; border-top: 1px solid var(--border-subtle); }
      .combo-rename-form { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
      .combo-rename-form input[type="text"] { flex: 1; min-width: 12rem; max-width: 20rem; }
      .combo-edit-chain { margin-top: 0.5rem; }
      .combo-chain-editor > .btn { margin-bottom: 0.4rem; }
      .combo-selected { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
      .combo-selected li { display: flex; align-items: center; gap: 0.5rem; border: 2px solid var(--text); border-radius: 0; padding: 0.35rem 0.55rem; font-size: 0.85rem; background: var(--surface-2); }
      .combo-selected li.cs-empty { border: none; padding: 0.2rem 0; color: var(--text-subtle); background: transparent; }
      .combo-selected .cs-order { color: var(--text-muted); font-size: var(--text-xs); font-weight: 800; min-width: 1.4em; text-align: center; }
      .combo-selected code { font-size: 0.82rem; flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .combo-selected-actions { display: flex; gap: 0.2rem; flex: none; }
      .combo-selected-actions .btn-ghost { padding: 0.15rem 0.4rem; min-height: auto; line-height: 1.1; font-size: 0.85rem; }
      .combo-picker { max-width: 640px; }
      .combo-picker input[type="search"] { width: 100%; box-sizing: border-box; }
      .combo-picker-list { margin-top: 0.75rem; max-height: 420px; overflow-y: auto; }
      .picker-group-head { position: sticky; top: 0; z-index: 1; background: var(--surface); display: flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0; border-bottom: 2px solid var(--border-subtle); font-size: 0.8rem; font-weight: 800; color: var(--text-subtle); }
      .picker-group-head img { width: 14px; height: 14px; }
      .picker-row { display: flex; align-items: center; gap: 0.5rem; width: 100%; padding: 0.4rem 0.5rem; border: 2px solid transparent; background: none; color: var(--text); text-align: left; font-size: 0.85rem; cursor: pointer; border-radius: 0; }
      .picker-row:hover { background: var(--surface-2); border-color: var(--text); }
      .picker-check { width: 1em; text-align: center; color: var(--text-subtle); }
      .picker-caps { margin-left: auto; display: flex; gap: 0.5rem; font-size: var(--text-xs); color: var(--text-subtle); flex-shrink: 0; }
    </style>

    <script>
    function copyCombo(btn, text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      var orig = btn.textContent;
      btn.textContent = "Tersalin!";
      btn.classList.add("btn-copied");
      setTimeout(function () {
        btn.textContent = orig;
        btn.classList.remove("btn-copied");
      }, 1500);
    }

    function openRenameCombo() {
      var d = document.querySelector(".combo-card-details");
      if (d) {
        d.open = true;
        var inp = d.querySelector('input[name="new_name"]');
        if (inp) { inp.focus(); inp.select(); }
      }
    }

    function filterComboList(query) {
      var q = (query || "").trim().toLowerCase();
      var items = document.querySelectorAll("#combo-master-list .combo-item");
      var matched = 0;
      items.forEach(function (item) {
        var name = item.getAttribute("data-name") || "";
        var show = !q || name.indexOf(q) !== -1;
        item.style.display = show ? "flex" : "none";
        if (show) matched++;
      });
      var emptyEl = document.getElementById("combo-search-empty");
      if (emptyEl) {
        emptyEl.style.display = (matched === 0 && items.length > 0) ? "block" : "none";
      }
    }

    function filterChainMembers(input) {
      var q = (input.value || "").trim().toLowerCase();
      var rows = document.querySelectorAll(".combo-chain-matrix .combo-member");
      rows.forEach(function (row) {
        var model = (row.getAttribute("data-model") || "").toLowerCase();
        row.style.display = (!q || model.indexOf(q) !== -1) ? "flex" : "none";
      });
    }
    </script>

    <script>
    (function () {
      var LOAD_FAIL = "Daftar model gagal dimuat. Model tetap bisa ditulis manual di textarea.";
      var listEl = document.getElementById("combo-picker-list");
      var searchEl = document.getElementById("combo-picker-search");
      var activeTa = null;
      var catalog = null;

      function lines(ta) {
        return ta.value.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      }
      function writeLines(ta, arr) { ta.value = arr.join("\\n"); }

      function mutate(ta, fn) {
        var vals = lines(ta);
        fn(vals);
        writeLines(ta, vals);
        renderSelected(ta);
      }

      function mkBtn(text, title, disabled, onClick, extraClass) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "btn " + (extraClass || "btn-ghost");
        b.textContent = text;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener("click", onClick);
        return b;
      }

      function capSpan(text) {
        var s = document.createElement("span");
        s.textContent = text;
        return s;
      }

      function renderSelected(ta) {
        var ul = ta.parentElement.querySelector(".combo-selected");
        if (!ul) return;
        ul.textContent = "";
        var vals = lines(ta);
        if (!vals.length) {
          var empty = document.createElement("li");
          empty.className = "cs-empty";
          empty.textContent = "Belum ada model dipilih";
          ul.appendChild(empty);
        }
        vals.forEach(function (v, i) {
          var li = document.createElement("li");
          var order = document.createElement("span");
          order.className = "cs-order";
          order.textContent = String(i + 1);
          var code = document.createElement("code");
          code.textContent = v;
          var actions = document.createElement("div");
          actions.className = "combo-selected-actions";
          actions.appendChild(mkBtn("↑", "Naikkan", i === 0, function () {
            mutate(ta, function (a) { var t = a[i - 1]; a[i - 1] = a[i]; a[i] = t; });
          }));
          actions.appendChild(mkBtn("↓", "Turunkan", i === vals.length - 1, function () {
            mutate(ta, function (a) { var t = a[i + 1]; a[i + 1] = a[i]; a[i] = t; });
          }));
          actions.appendChild(mkBtn("×", "Hapus", false, function () {
            mutate(ta, function (a) { a.splice(i, 1); });
            renderList();
          }, "btn-danger"));
          li.appendChild(order);
          li.appendChild(code);
          li.appendChild(actions);
          ul.appendChild(li);
        });
      }

      function renderList() {
        listEl.textContent = "";
        if (!catalog) { listEl.textContent = LOAD_FAIL; return; }
        var q = (searchEl.value || "").trim().toLowerCase();
        var sel = {};
        if (activeTa) lines(activeTa).forEach(function (v) { sel[v] = true; });
        var shown = 0;
        catalog.forEach(function (g) {
          var models = g.models.filter(function (m) {
            return !q || m.id.toLowerCase().indexOf(q) !== -1 ||
              g.name.toLowerCase().indexOf(q) !== -1 || g.id.toLowerCase().indexOf(q) !== -1;
          });
          if (!models.length) return;
          shown += models.length;
          var head = document.createElement("div");
          head.className = "picker-group-head";
          if (g.icon) {
            var img = document.createElement("img");
            img.src = g.icon;
            img.alt = "";
            head.appendChild(img);
          }
          var nm = document.createElement("span");
          nm.textContent = g.name;
          var cnt = document.createElement("span");
          cnt.textContent = "(" + models.length + ")";
          head.appendChild(nm);
          head.appendChild(cnt);
          listEl.appendChild(head);
          models.forEach(function (m) {
            var row = document.createElement("button");
            row.type = "button";
            row.className = "picker-row";
            var check = document.createElement("span");
            check.className = "picker-check";
            check.textContent = sel[m.id] ? "✓" : "";
            var idEl = document.createElement("code");
            idEl.textContent = m.id;
            var caps = document.createElement("span");
            caps.className = "picker-caps";
            if (m.custom) caps.appendChild(capSpan("custom"));
            if (m.capabilities && m.capabilities.vision) caps.appendChild(capSpan("vision"));
            if (m.capabilities && m.capabilities.reasoning) caps.appendChild(capSpan("reasoning"));
            if (m.context_length) {
              var ctx = document.createElement("span");
              ctx.textContent = Math.round(m.context_length / 1000) + "k";
              caps.appendChild(ctx);
            }
            row.appendChild(check);
            row.appendChild(idEl);
            row.appendChild(caps);
            row.addEventListener("click", function () { toggle(m.id); });
            listEl.appendChild(row);
          });
        });
        if (shown === 0) {
          var p = document.createElement("p");
          p.className = "hint";
          p.textContent = "Tidak ada model yang cocok.";
          listEl.appendChild(p);
        }
      }

      function toggle(id) {
        if (!activeTa) return;
        mutate(activeTa, function (a) {
          var i = a.indexOf(id);
          if (i === -1) a.push(id); else a.splice(i, 1);
        });
        renderList();
      }

      function load() {
        listEl.textContent = "Memuat daftar model…";
        fetch("/api/models", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            catalog = data && Array.isArray(data.providers) ? data.providers : null;
            if (!catalog && activeTa) activeTa.hidden = false;
            renderList();
          })
          .catch(function () {
            catalog = null;
            if (activeTa) activeTa.hidden = false;
            listEl.textContent = LOAD_FAIL;
          });
      }

      function open(ta) {
        activeTa = ta;
        searchEl.value = "";
        openModal("model-picker-modal");
        load();
      }

      searchEl.addEventListener("input", renderList);
      document.querySelectorAll("[data-picker-open]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var wrap = btn.closest(".combo-chain-editor");
          var ta = wrap ? wrap.querySelector('textarea[name="models"]') : null;
          if (ta) open(ta);
        });
      });

      document.querySelectorAll(".combo-chain-editor").forEach(function (wrap) {
        var ta = wrap.querySelector('textarea[name="models"]');
        if (ta) {
          ta.hidden = true;
          renderSelected(ta);
        }
      });
    })();
    </script>
  `;

  return content;
}

export async function renderCombosPage(c) {
  const query = c.req.query();
  const search = query.search ? `?${new URLSearchParams(query).toString()}` : "";
  return c.redirect(`/dashboard/providers?tab=combos${search ? "&" + search.slice(1) : ""}`);
}

export async function handleCreateCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const models = parseMemberLines(body.models);

  try {
    createCombo({ name, models });
  } catch (err) {
    return c.redirect(`/dashboard/providers?tab=combos&error=1&msg=${encodeURIComponent(err.message)}`);
  }

  return c.redirect("/dashboard/providers?tab=combos&created=1");
}

/** The textarea is the source of truth for the chain; blank lines are dropped. */
function parseMemberLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function backWithError(c, message) {
  return c.redirect(`/dashboard/providers?tab=combos&error=1&msg=${encodeURIComponent(message)}`);
}

export async function handleUpdateCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();

  try {
    const payload = { strategy: String(body.strategy || "").trim() };
    if (body.models !== undefined) payload.models = parseMemberLines(body.models);
    updateCombo(name, payload);
  } catch (err) {
    return backWithError(c, err.message);
  }

  return c.redirect("/dashboard/providers?tab=combos&updated=1");
}

export async function handleReorderCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const direction = String(body.direction || "").trim();

  try {
    moveComboMember(name, Number.parseInt(body.index, 10), direction);
  } catch (err) {
    return backWithError(c, err.message);
  }

  return c.redirect("/dashboard/providers?tab=combos&updated=1");
}

export async function handleRenameCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const newName = String(body.new_name || "").trim();

  try {
    renameCombo(name, newName);
  } catch (err) {
    return backWithError(c, err.message);
  }

  return c.redirect("/dashboard/providers?tab=combos&updated=1");
}

export async function handleToggleCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();

  const current = getComboByName(name);
  if (!current) return backWithError(c, `combo "${name}" tidak ada`);
  setComboEnabled(name, current.enabled !== 1);

  return c.redirect("/dashboard/providers?tab=combos&updated=1");
}

export async function handleDeleteCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();

  try {
    deleteCombo(name);
  } catch (err) {
    return backWithError(c, err.message);
  }

  return c.redirect("/dashboard/providers?tab=combos&deleted=1");
}
