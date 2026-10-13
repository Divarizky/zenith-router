import {
  listProxyPools,
  createProxyPool,
  importProxyLines,
  testProxyPool,
  updateProxyPoolEntry,
  deleteProxyPool,
  toggleProxyPool,
} from "../../services/proxyPools.js";
import { escapeHtml } from "../html.js";
import { renderLayout, icon } from "../layout.js";

function fmtTestTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderProxyRow(pool) {
  const isOk = Boolean(pool.last_test_ok);
  const hasTested = Boolean(pool.last_test_at);

  const testBadge = hasTested
    ? isOk
      ? `<span class="pill pill-success" title="Tes terakhir sukses"><span class="dot"></span>ok</span>`
      : `<span class="pill pill-warning" title="Tes terakhir gagal"><span class="dot"></span>error</span>`
    : `<span class="pill" title="Belum pernah dites"><span class="dot"></span>unknown (Belum dites)</span>`;

  const activeBadge = pool.is_active
    ? `<span class="pill pill-success">active</span>`
    : `<span class="pill">inactive</span>`;

  const boundBadge = `<span class="pill">${pool.accountCount} bound (${pool.accountCount} akun)</span>`;

  // Nilai masuk atribut onclick: JSON.stringify menjaga literal JS tetap utuh
  // (quote, backslash, newline), escapeHtml hanya untuk konteks atribut HTML.
  const nameJson = escapeHtml(JSON.stringify(pool.name));
  const urlJson = escapeHtml(JSON.stringify(pool.maskedUrl));

  const testDetail = hasTested
    ? `Last tested: ${fmtTestTime(pool.last_test_at)}${
        pool.last_test_ms != null ? ` &middot; ${pool.last_test_ms} ms` : ""
      }${
        !isOk && pool.last_test_error
          ? ` &middot; <span style="color:var(--danger);">${escapeHtml(String(pool.last_test_error))}</span>`
          : ""
      }`
    : "Last tested: Never (Belum dites)";

  return `
    <div class="proxy-row" id="proxy-row-${pool.id}">
      <div class="proxy-info">
        <input
          type="checkbox"
          name="ids"
          value="${pool.id}"
          data-select-group="proxies"
          form="proxy-bulk-form"
          autocomplete="off"
          style="width: auto; margin-top: 0.35rem;"
          aria-label="Pilih ${escapeHtml(pool.name)}"
        />
        <div class="proxy-main">
          <div class="proxy-title-line">
            <span class="proxy-name">${escapeHtml(pool.name)}</span>
            ${testBadge}
            ${activeBadge}
            ${boundBadge}
          </div>
          <div class="proxy-url-line"><code>${escapeHtml(pool.maskedUrl)}</code></div>
          <div class="proxy-meta-line">${testDetail}</div>
        </div>
      </div>

      <div class="proxy-actions">
        <form action="/dashboard/proxies/toggle" method="POST" style="margin: 0;">
          <input type="hidden" name="id" value="${pool.id}" />
          <button
            type="submit"
            class="btn btn-sm ${pool.is_active ? "btn-secondary" : "btn-ghost"}"
            title="${pool.is_active ? "Nonaktifkan proxy" : "Aktifkan proxy"}"
          >${pool.is_active ? "Disable" : "Enable"}</button>
        </form>
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
          onclick="openEditModal(${pool.id}, ${nameJson}, ${urlJson}, ${pool.is_active ? 1 : 0})"
        >
          ${icon("edit", 15)}
        </button>
        <form action="/dashboard/proxies/delete" method="POST" onsubmit="return confirm('Hapus proxy ini dari daftar?')" style="margin: 0;">
          <input type="hidden" name="id" value="${pool.id}" />
          <button type="submit" class="btn btn-sm btn-icon btn-danger" title="Hapus proxy">
            ${icon("trash", 15)}
          </button>
        </form>
      </div>
    </div>`;
}

export function renderProxyContent(query = {}) {
  const pools = listProxyPools();
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
    <div style="text-align: center; padding: 3.5rem 1.5rem;">
      <div style="margin-bottom: 1rem; color: var(--text-muted); display: inline-flex;">${icon("lan", 40)}</div>
      <p style="font-weight: 600; margin-bottom: 0.35rem; font-size: 1.05rem;">Belum ada entri proxy pool</p>
      <p class="hint" style="max-width: 420px; margin: 0 auto 1.5rem auto;">
        Tambahkan proxy pool pertama Anda, lalu hubungkan ke akun atau provider untuk mengarahkan lalu lintas.
      </p>
      <button type="button" class="btn btn-primary" onclick="openModal('add-proxy-modal')">
        ${icon("plus", 16)} Add Proxy Pool
      </button>
    </div>`;

  const listBody =
    pools.length === 0
      ? emptyState
      : `<div class="proxy-list">${pools.map(renderProxyRow).join("")}</div>`;

  return `
    ${notice}

    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem;">
      <div>
        <h1 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 0.25rem;">Proxy Pools</h1>
        <p class="hint" style="margin: 0;">Kelola daftar proxy pool terpusat untuk akun provider dan rotasi request.</p>
      </div>
      <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
        <button type="button" class="btn btn-secondary" onclick="openModal('batch-import-modal')">
          ${icon("upload", 16)} <span>Batch Import</span>
        </button>
        <button type="button" class="btn btn-primary" onclick="openModal('add-proxy-modal')">
          ${icon("plus", 16)} <span>Add Proxy Pool</span>
        </button>
      </div>
    </div>

    <div class="card">
      <div class="card-head" style="flex-wrap: wrap; gap: 0.75rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.85rem; margin-bottom: 0.85rem;">
        <div style="display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
          ${
            pools.length > 0
              ? `<div style="display: flex; align-items: center; gap: 0.4rem; margin-right: 0.5rem;">
            <input type="checkbox" data-select-all="proxies" id="select-all-proxies" autocomplete="off" style="width: auto;" aria-label="Pilih semua proxy" />
            <label for="select-all-proxies" style="font-size: 0.8rem; color: var(--text-muted); cursor: pointer;">Pilih semua</label>
          </div>`
              : ""
          }
          <span class="pill">Total: ${pools.length}</span>
          <span class="pill pill-success">Active: ${activeCount}</span>
        </div>

        ${
          pools.length > 0
            ? `<form id="proxy-bulk-form" method="POST" style="margin: 0; display: inline-flex; gap: 0.4rem; align-items: center; flex-wrap: wrap;">
          <button type="submit" class="btn btn-sm btn-ghost" formaction="/dashboard/proxies/bulk-enable" data-requires-selection="proxies" disabled>
            Aktifkan Terpilih (<span data-selected-count="proxies">0</span>)
          </button>
          <button type="submit" class="btn btn-sm btn-ghost" formaction="/dashboard/proxies/bulk-disable" data-requires-selection="proxies" disabled>
            Nonaktifkan Terpilih (<span data-selected-count="proxies">0</span>)
          </button>
          <button type="submit" class="btn btn-sm btn-danger" formaction="/dashboard/proxies/bulk-delete" data-requires-selection="proxies" disabled onclick="return confirm('Hapus semua proxy terpilih yang tidak dipakai akun?')">
            Hapus Terpilih (<span data-selected-count="proxies">0</span>)
          </button>
        </form>`
            : ""
        }
      </div>

      ${listBody}
    </div>

    <!-- Modal Add Proxy Pool -->
    <div class="modal-backdrop" id="add-proxy-modal">
      <div class="modal">
        <h3>Add Proxy Pool</h3>
        <p class="hint" style="margin-bottom: 1rem;">
          Satu entri adalah satu alamat proxy untuk dipakai bersama oleh beberapa akun. Hanya skema <code>http://</code> yang didukung.
        </p>
        <form action="/dashboard/proxies/add" method="POST">
          <div class="field">
            <label for="add-proxy-name">Nama</label>
            <input
              type="text"
              id="add-proxy-name"
              name="name"
              placeholder="mis. rumah-id"
              maxlength="64"
              required
            />
            <p class="hint">Nama unik untuk menandai proxy ini di daftar.</p>
          </div>
          <div class="field">
            <label for="add-proxy-url">Alamat proxy</label>
            <input
              type="text"
              id="add-proxy-url"
              name="url"
              placeholder="http://user:pass@127.0.0.1:7890"
              required
            />
            <p class="hint">Format <code>http://user:pass@host:port</code> atau <code>http://host:port</code>. Password disamarkan di tampilan.</p>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-close-modal="add-proxy-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Tambah Proxy</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal Edit Proxy Pool -->
    <div class="modal-backdrop" id="edit-proxy-modal">
      <div class="modal">
        <h3>Edit Proxy Pool</h3>
        <form action="/dashboard/proxies/update" method="POST">
          <input type="hidden" id="edit-proxy-id" name="id" value="" />
          <div class="field">
            <label for="edit-proxy-name">Nama</label>
            <input type="text" id="edit-proxy-name" name="name" maxlength="64" required />
          </div>
          <div class="field">
            <label for="edit-proxy-url">Alamat proxy</label>
            <input type="text" id="edit-proxy-url" name="url" required />
            <p class="hint">Ketik <code>****</code> untuk mempertahankan password yang tersimpan.</p>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" data-close-modal="edit-proxy-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Simpan Perubahan</button>
          </div>
        </form>
      </div>
    </div>

    <!-- Modal Batch Import -->
    <div class="modal-backdrop" id="batch-import-modal">
      <div class="modal" style="max-width: 520px;">
        <h3>Batch Import Proxies</h3>
        <p class="hint" style="margin-bottom: 1rem; font-size: 0.82rem; line-height: 1.45;">
          Tempel daftar proxy Anda, satu entri per baris. Baris kosong akan diabaikan dan proxy yang sudah ada dilewati otomatis.
        </p>
        <form action="/dashboard/proxies/import" method="POST">
          <div class="field" style="margin-bottom: 0.5rem;">
            <label for="batch-proxy-bulk" style="font-weight: 500; font-size: 0.85rem; color: var(--text); margin-bottom: 0.4rem;">
              Daftar Proxy (satu per baris)
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
              style="min-height: 190px; padding: 0.75rem 0.85rem; line-height: 1.5; font-size: 0.82rem; background: #080808; border-color: var(--border);"
              required
            ></textarea>
          </div>

          <div style="padding: 0.6rem 0.75rem; border-radius: 6px; background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); font-size: 0.78rem; color: var(--text-muted); line-height: 1.55;">
            <strong style="color: var(--text); font-size: 0.78rem;">Format yang didukung:</strong><br />
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

export function renderProxiesPage(port = 20120, query = {}) {
  const content = renderProxyContent(query);
  const extraScripts = `
<script>
  function openEditModal(id, name, url, isActive) {
    var idEl = document.getElementById('edit-proxy-id');
    var nameEl = document.getElementById('edit-proxy-name');
    var urlEl = document.getElementById('edit-proxy-url');
    if (idEl) idEl.value = id;
    if (nameEl) nameEl.value = name;
    if (urlEl) urlEl.value = url;
    openModal('edit-proxy-modal');
  }
</script>
`;
  return renderLayout({
    title: "Proxy Pools",
    activeTab: "proxies",
    content,
    port,
    extraScripts,
  });
}

export async function handleAddProxy(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const url = String(body.url || "").trim();

  try {
    createProxyPool({ name, url });
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

export async function handleUpdateProxy(c) {
  const body = await c.req.parseBody();
  try {
    updateProxyPoolEntry({ id: Number(body.id), name: body.name, url: body.url });
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
