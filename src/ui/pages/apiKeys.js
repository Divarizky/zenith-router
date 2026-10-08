import {
  createApiKey,
  listApiKeys,
  setApiKeyActive,
  deleteApiKey,
} from "../../services/apiKeys.js";
import { isApiKeyRequired, getLocalBaseUrl } from "../../security.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";

function formatTime(ms) {
  if (!ms) return `<span style="color: var(--text-muted);">belum pernah</span>`;
  return escapeHtml(new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 16));
}

function renderNewKeyNotice(newKey, port) {
  if (!newKey) return "";
  const baseUrl = escapeHtml(getLocalBaseUrl(port));
  return `
    <div class="card" style="margin-bottom: 1.5rem; border-color: var(--warning);">
      <h3 style="color: var(--warning);">New key: copy it now</h3>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">
        Ini satu-satunya waktu kunci penuh ditampilkan. zenroute hanya menyimpan hash SHA-256.
      </p>
      <code style="display: block; padding: 0.75rem; word-break: break-all; font-size: 0.95rem;">${escapeHtml(newKey.key)}</code>
      <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.75rem;">
        Kirim sebagai <code>Authorization: Bearer &lt;key&gt;</code> or <code>x-api-key: &lt;key&gt;</code> to <code>${baseUrl}/v1</code>.
      </p>
    </div>`;
}

/**
 * Render API Keys page. `newKey` is passed only right after creation.
 */
export function renderApiKeysPage(port = 20120, newKey = null, query = {}) {
  const keys = listApiKeys();
  const required = isApiKeyRequired();
  const activeCount = keys.filter((k) => k.is_active === 1).length;

  let noticeText = null;
  if (query.status === "deleted") noticeText = "API key berhasil dihapus.";
  else if (query.status === "toggled") noticeText = "Status API key diperbarui.";

  const policy = required
    ? `<span class="pill pill-success">Wajib</span>`
    : `<span class="pill pill-warning">Tidak wajib</span>`;

  const lockoutWarning =
    required && activeCount === 0
      ? `<p style="color: var(--danger); font-size: 0.85rem; margin-top: 0.5rem;">Tidak ada kunci aktif: semua request /v1 ditolak sampai kamu membuat satu.</p>`
      : "";

  const content = `
    ${
      noticeText
        ? `<div class="notice notice-ok"><span>${escapeHtml(
            noticeText
          )}</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : ""
    }
    ${renderNewKeyNotice(newKey, port)}

    <div class="card" style="margin-bottom: 1.5rem;">
      <h3>Gateway Access Policy</h3>
      <p class="hint">Kunci API di /v1: ${policy}</p>
      <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
        Ubah di Pengaturan. Selalu wajib saat zenroute terikat ke alamat non-loopback.
        Kunci ini hanya membuka zenroute; kredensial penyedia tetap di Koneksi dan tidak diambil dari klien.
      </p>
      ${lockoutWarning}
    </div>

    <div class="card" style="margin-bottom: 1.5rem;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <h3 style="margin-bottom: 0;">Keys (${keys.length})</h3>
        <button class="btn btn-primary" onclick="openModal('create-key-modal')">Create API Key</button>
      </div>
    </div>

    <div class="modal-backdrop" id="create-key-modal">
      <div class="modal">
        <h3>Create API Key</h3>
        <form action="/dashboard/keys/create" method="POST">
          <div class="field">
            <label for="name">Label</label>
            <input type="text" id="name" name="name" placeholder="mis. Claude Code laptop" maxlength="80" required />
          </div>
          <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem;">
            <button type="button" class="btn" data-close-modal="create-key-modal">Batal</button>
            <button type="submit" class="btn btn-primary">Buat</button>
          </div>
        </form>
      </div>
    </div>

    <div class="card">
      <h3>Keys (${keys.length})</h3>
      ${
        keys.length === 0
          ? `<div class="empty"><p class="big">Belum ada kunci</p><p>Buat kunci pertama lewat tombol Buat Kunci API.</p></div>`
          : `<table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Kunci</th>
            <th>Dibuat</th>
            <th>Terakhir Dipakai</th>
            <th>Status</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${keys
            .map(
              (k) => `
            <tr>
              <td><strong>${escapeHtml(k.name)}</strong></td>
              <td><code>${escapeHtml(k.key_prefix)}…</code></td>
              <td>${formatTime(k.created_at)}</td>
              <td>${formatTime(k.last_used_at)}</td>
              <td>${
                k.is_active === 1
                  ? `<span class="pill pill-success">Aktif</span>`
                  : `<span class="pill pill-danger">Nonaktif</span>`
              }</td>
              <td style="display: flex; gap: 0.4rem;">
                <form action="/dashboard/keys/toggle" method="POST">
                  <input type="hidden" name="id" value="${escapeHtml(k.id)}" />
                  <input type="hidden" name="active" value="${k.is_active === 1 ? "false" : "true"}" />
                  <button type="submit" class="btn btn-sm">${
                    k.is_active === 1 ? "Nonaktifkan" : "Aktifkan"
                  }</button>
                </form>
                <form action="/dashboard/keys/delete" method="POST">
                  <input type="hidden" name="id" value="${escapeHtml(k.id)}" />
                  <button type="submit" class="btn btn-danger btn-sm">Hapus</button>
                </form>
              </td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`
      }
    </div>
  `;

  return renderLayout({
    title: "API Keys",
    activeTab: "keys",
    content,
    port,
  });
}

/**
 * Handle POST /dashboard/keys/create. Renders the page directly (no redirect)
 * so the plaintext key is never kept anywhere after this response.
 */
export async function handleCreateApiKey(c, port) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim().slice(0, 80);
  if (!name) {
    return c.redirect("/dashboard/keys");
  }

  const created = createApiKey(name);
  c.header("Cache-Control", "no-store");
  return c.html(renderApiKeysPage(port, created), 201);
}

/**
 * Handle POST /dashboard/keys/toggle
 */
export async function handleToggleApiKey(c) {
  const body = await c.req.parseBody();
  const id = Number(body.id);
  if (id) {
    setApiKeyActive(id, body.active === "true");
  }
  return c.redirect("/dashboard/keys?status=toggled");
}

/**
 * Handle POST /dashboard/keys/delete
 */
export async function handleDeleteApiKey(c) {
  const body = await c.req.parseBody();
  const id = Number(body.id);
  if (id) {
    deleteApiKey(id);
  }
  return c.redirect("/dashboard/keys?status=deleted");
}
