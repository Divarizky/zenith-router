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
  if (!ms) return `<span style="color: var(--text-muted);">never</span>`;
  return escapeHtml(new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 16));
}

function renderNewKeyNotice(newKey, port) {
  if (!newKey) return "";
  const baseUrl = escapeHtml(getLocalBaseUrl(port));
  return `
    <div class="card" style="margin-bottom: 1.5rem; border-color: var(--warning);">
      <h3 style="color: var(--warning);">New key: copy it now</h3>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">
        This is the only time the full key is shown. zenroute stores only its SHA-256 hash.
      </p>
      <code style="display: block; padding: 0.75rem; word-break: break-all; font-size: 0.95rem;">${escapeHtml(newKey.key)}</code>
      <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.75rem;">
        Send it as <code>Authorization: Bearer &lt;key&gt;</code> or <code>x-api-key: &lt;key&gt;</code> to <code>${baseUrl}/v1</code>.
      </p>
    </div>`;
}

/**
 * Render API Keys page. `newKey` is passed only right after creation.
 */
export function renderApiKeysPage(port = 20120, newKey = null) {
  const keys = listApiKeys();
  const required = isApiKeyRequired();
  const activeCount = keys.filter((k) => k.is_active === 1).length;

  const policy = required
    ? `<span class="pill pill-success">Required</span>`
    : `<span class="pill pill-warning">Not required</span>`;

  const lockoutWarning =
    required && activeCount === 0
      ? `<p style="color: var(--danger); font-size: 0.85rem; margin-top: 0.5rem;">No active key: every /v1 request is rejected until you create one.</p>`
      : "";

  const content = `
    ${renderNewKeyNotice(newKey, port)}

    <div class="card" style="margin-bottom: 1.5rem;">
      <h3>Gateway Access Policy</h3>
      <p class="hint">API key on /v1: ${policy}</p>
      <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
        Toggle in Settings. Always required when zenroute binds to a non-loopback address.
        These keys only unlock zenroute; provider credentials stay in Connections and are never taken from clients.
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
            <input type="text" id="name" name="name" placeholder="e.g. Claude Code laptop" maxlength="80" required />
          </div>
          <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem;">
            <button type="button" class="btn" data-close-modal="create-key-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Create</button>
          </div>
        </form>
      </div>
    </div>

    <div class="card">
      <h3>Keys (${keys.length})</h3>
      ${
        keys.length === 0
          ? `<div class="empty"><p class="big">No keys yet</p><p>Buat key pertama lewat tombol Create API Key.</p></div>`
          : `<table>
        <thead>
          <tr>
            <th>Label</th>
            <th>Key</th>
            <th>Created</th>
            <th>Last Used</th>
            <th>Status</th>
            <th>Action</th>
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
                  ? `<span class="pill pill-success">Active</span>`
                  : `<span class="pill pill-danger">Disabled</span>`
              }</td>
              <td style="display: flex; gap: 0.4rem;">
                <form action="/dashboard/keys/toggle" method="POST">
                  <input type="hidden" name="id" value="${escapeHtml(k.id)}" />
                  <input type="hidden" name="active" value="${k.is_active === 1 ? "false" : "true"}" />
                  <button type="submit" class="btn btn-sm">${
                    k.is_active === 1 ? "Disable" : "Enable"
                  }</button>
                </form>
                <form action="/dashboard/keys/delete" method="POST">
                  <input type="hidden" name="id" value="${escapeHtml(k.id)}" />
                  <button type="submit" class="btn btn-danger btn-sm">Delete</button>
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
  return c.redirect("/dashboard/keys");
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
  return c.redirect("/dashboard/keys");
}
