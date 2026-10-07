import {
  getConnections,
  addConnection,
  deleteConnection,
} from "../../db/index.js";
import { getAllProviders } from "../../providers/index.js";
import { isConnectionInCooldown } from "../../services/auth.js";
import { isConnectionExhausted } from "../../services/quota.js";
import { renderLayout } from "../layout.js";

/**
 * Render Connections Management page
 */
export function renderConnectionsPage(port = 20128) {
  const connections = getConnections();
  const providers = getAllProviders();

  const content = `
    <div class="card" style="margin-bottom: 1.5rem;">
      <h3 style="margin-bottom: 1rem;">Add New Connection</h3>
      <form action="/dashboard/connections/add" method="POST">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
          <div class="form-group">
            <label for="provider">Provider</label>
            <select id="provider" name="provider" required>
              ${providers
                .map((p) => `<option value="${p.id}">${p.name} (${p.id})</option>`)
                .join("")}
            </select>
          </div>
          <div class="form-group">
            <label for="name">Account Label</label>
            <input type="text" id="name" name="name" placeholder="e.g. My GLM Key" required />
          </div>
          <div class="form-group">
            <label for="auth_type">Auth Type</label>
            <select id="auth_type" name="auth_type">
              <option value="apikey">API Key</option>
              <option value="oauth">OAuth Token</option>
            </select>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-top: 0.5rem;">
          <div class="form-group">
            <label for="api_key">API Key or Token</label>
            <input type="password" id="api_key" name="api_key" placeholder="Paste credential secret..." required />
          </div>
          <div class="form-group">
            <label for="proxy_url">Proxy URL (Optional)</label>
            <input type="text" id="proxy_url" name="proxy_url" placeholder="http://127.0.0.1:7890" />
          </div>
        </div>

        <div style="margin-top: 1rem;">
          <button type="submit" class="btn">Add Connection</button>
        </div>
      </form>
    </div>

    <div class="card">
      <h3>Configured Accounts (${connections.length})</h3>
      ${
        connections.length === 0
          ? `<p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 0.5rem;">No connections configured yet. Add your first API key above.</p>`
          : `<table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Provider</th>
            <th>Auth Type</th>
            <th>Proxy</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${connections
            .map((c) => {
              const inCooldown = isConnectionInCooldown(c);
              const exhausted = isConnectionExhausted(c);
              let statusBadge = `<span class="badge badge-success">Active</span>`;
              if (inCooldown) {
                statusBadge = `<span class="badge badge-warning">Cooldown</span>`;
              } else if (exhausted) {
                statusBadge = `<span class="badge badge-danger">Exhausted</span>`;
              }

              return `
            <tr>
              <td><code>${c.id}</code></td>
              <td><strong>${c.name}</strong></td>
              <td><span class="badge">${c.provider}</span></td>
              <td>${c.auth_type}</td>
              <td>${c.proxy_url ? `<code>${c.proxy_url}</code>` : `<span style="color: var(--text-muted);">-</span>`}</td>
              <td>${statusBadge}</td>
              <td>
                <form action="/dashboard/connections/delete" method="POST" style="display:inline;">
                  <input type="hidden" name="id" value="${c.id}" />
                  <button type="submit" class="btn btn-danger" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;">Delete</button>
                </form>
              </td>
            </tr>`;
            })
            .join("")}
        </tbody>
      </table>`
      }
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
  const auth_type = String(body.auth_type || "apikey").trim();
  const apiKey = String(body.api_key || "").trim();
  const proxy_url = body.proxy_url ? String(body.proxy_url).trim() : null;

  if (provider && apiKey) {
    addConnection({
      provider,
      name,
      auth_type,
      credentials: {
        api_key: apiKey,
        access_token: apiKey,
      },
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
