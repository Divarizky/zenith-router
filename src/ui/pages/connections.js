import {
  getConnections,
  addConnection,
  deleteConnection,
} from "../../db/index.js";
import { getAllProviders, getProvider } from "../../providers/index.js";
import { isConnectionInCooldown } from "../../services/auth.js";
import { isConnectionExhausted } from "../../services/quota.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";

/**
 * Render Connections Management page: provider cards + modal form.
 */
export function renderConnectionsPage(port = 20120) {
  const connections = getConnections();
  const providers = getAllProviders();

  const byProvider = new Map();
  for (const c of connections) {
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, []);
    byProvider.get(c.provider).push(c);
  }

  const cards = providers
    .map((p) => {
      const list = byProvider.get(p.id) || [];
      const healthy = list.filter((c) => !isConnectionInCooldown(c) && !isConnectionExhausted(c)).length;
      return `
    <div class="card" style="margin-bottom: 0;">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
        <h3 style="margin-bottom: 0;">${escapeHtml(p.name)}</h3>
        <span class="pill">${escapeHtml(p.id)}</span>
      </div>
      <p class="hint">${list.length} account &middot; ${healthy} aktif</p>
      <div style="margin-top: 0.9rem;">
        <button class="btn btn-sm" onclick="openModal('add-modal')">Add account</button>
      </div>
    </div>`;
    })
    .join("");

  const rows = connections
    .map((c) => {
      const inCooldown = isConnectionInCooldown(c);
      const exhausted = isConnectionExhausted(c);
      let status = `<span class="pill pill-success">Active</span>`;
      if (inCooldown) status = `<span class="pill pill-warning">Cooldown</span>`;
      else if (exhausted) status = `<span class="pill pill-danger">Exhausted</span>`;
      return `
        <tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td><span class="pill">${escapeHtml(c.provider)}</span></td>
          <td>${escapeHtml(c.auth_type)}</td>
          <td>${c.proxy_url ? `<code>${escapeHtml(c.proxy_url)}</code>` : `<span class="hint">-</span>`}</td>
          <td>${status}</td>
          <td>
            <form action="/dashboard/connections/delete" method="POST" style="display:inline;">
              <input type="hidden" name="id" value="${escapeHtml(c.id)}" />
              <button type="submit" class="btn btn-danger btn-sm">Delete</button>
            </form>
          </td>
        </tr>`;
    })
    .join("");

  const content = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
      <p class="hint">${connections.length} connection terkonfigurasi</p>
      <button class="btn btn-primary" onclick="openModal('add-modal')">Add New Connection</button>
    </div>

    <div class="grid-3" style="margin-bottom: 1.5rem;">${cards}</div>

    <div class="card">
      <h3>Configured Accounts</h3>
      ${
        connections.length === 0
          ? `<div class="empty"><p class="big">Belum ada connection</p><p>Tambahkan API key pertama lewat tombol di atas.</p></div>`
          : `<table>
        <thead>
          <tr><th>Name</th><th>Provider</th><th>Auth</th><th>Proxy</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`
      }
    </div>

    <div class="modal-backdrop" id="add-modal">
      <div class="modal">
        <h3>Add New Connection</h3>
        <form action="/dashboard/connections/add" method="POST">
          <div class="field">
            <label for="provider">Provider</label>
            <select id="provider" name="provider" required>
              ${providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="name">Account Label</label>
            <input type="text" id="name" name="name" placeholder="e.g. My GLM Key" required />
          </div>
          <div class="field">
            <label for="auth_type">Auth Type</label>
            <select id="auth_type" name="auth_type">
              <option value="apikey">API Key</option>
              <option value="oauth">OAuth Token</option>
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
          <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem;">
            <button type="button" class="btn" data-close-modal="add-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">Add Connection</button>
          </div>
        </form>
      </div>
    </div>
  `;

  return renderLayout({
    title: "Connections",
    activeTab: "connections",
    content,
    port,
  });
}

/**
 * Handle form POST /dashboard/connections/add
 */
export async function handleAddConnection(c) {
  const body = await c.req.parseBody();

  const provider = String(body.provider || "").trim();
  const name = String(body.name || `${provider} Account`).trim();
  const auth_type = body.auth_type === "oauth" ? "oauth" : "apikey";
  const secret = String(body.api_key || "").trim();
  const proxy_url = body.proxy_url ? String(body.proxy_url).trim() : "";

  const proxyValid = !proxy_url || /^https?:\/\/[^\s]+$/i.test(proxy_url);

  if (getProvider(provider) && secret && proxyValid) {
    addConnection({
      provider,
      name,
      auth_type,
      credentials: auth_type === "oauth" ? { access_token: secret } : { api_key: secret },
      proxy_url: proxy_url || null,
    });
  }

  return c.redirect("/dashboard/connections");
}

/**
 * Handle form POST /dashboard/connections/delete
 */
export async function handleDeleteConnection(c) {
  const body = await c.req.parseBody();
  const id = Number(body.id);
  if (id) {
    deleteConnection(id);
  }
  return c.redirect("/dashboard/connections");
}
