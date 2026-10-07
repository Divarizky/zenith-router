import { getConnections } from "../../db/index.js";
import { isConnectionInCooldown } from "../../services/auth.js";
import { isConnectionExhausted } from "../../services/quota.js";
import { getUsageStats } from "../../services/usage.js";
import { getAvailableModels } from "../../providers/index.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getLocalBaseUrl } from "../../security.js";

/**
 * Render Overview Dashboard page
 */
export function renderOverviewPage(port = 20120) {
  const connections = getConnections();
  const activeCount = connections.filter(
    (c) => c.is_active === 1 && !isConnectionInCooldown(c) && !isConnectionExhausted(c)
  ).length;

  const usageToday = getUsageStats({ days: 1 });
  const models = getAvailableModels();
  const baseUrl = escapeHtml(getLocalBaseUrl(port));

  const content = `
    <div class="grid">
      <div class="card">
        <h3>Gateway Status</h3>
        <div class="value" style="color: var(--success); font-size: 1.5rem;">Online</div>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Port ${port}</p>
      </div>
      <div class="card">
        <h3>Active Connections</h3>
        <div class="value">${activeCount} <span style="font-size: 1rem; color: var(--text-muted);">/ ${connections.length}</span></div>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Accounts configured</p>
      </div>
      <div class="card">
        <h3>Tokens Used (Today)</h3>
        <div class="value">${usageToday.summary.total_tokens.toLocaleString()}</div>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">${usageToday.summary.total_requests} requests</p>
      </div>
      <div class="card">
        <h3>Available Models</h3>
        <div class="value">${models.length}</div>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Routed models</p>
      </div>
    </div>

    <div class="card" style="margin-bottom: 1.5rem;">
      <h3 style="margin-bottom: 0.75rem;">Client Integration Endpoints</h3>
      <div style="display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.85rem;">
        <div><strong>OpenAI Chat:</strong> <code>${baseUrl}/v1/chat/completions</code></div>
        <div><strong>Claude Messages:</strong> <code>${baseUrl}/v1/messages</code></div>
        <div><strong>Model Discovery:</strong> <code>${baseUrl}/v1/models</code></div>
      </div>
    </div>

    <div class="card">
      <h3>Active Routed Models</h3>
      <table>
        <thead>
          <tr>
            <th>Model ID</th>
            <th>Provider</th>
          </tr>
        </thead>
        <tbody>
          ${models
            .slice(0, 10)
            .map(
              (m) => `
            <tr>
              <td><code>${escapeHtml(m.id)}</code></td>
              <td><span class="badge">${escapeHtml(m.owned_by)}</span></td>
            </tr>`
            )
            .join("")}
          ${
            models.length > 10
              ? `<tr><td colspan="2" style="text-align: center; color: var(--text-muted);">... and ${
                  models.length - 10
                } more models</td></tr>`
              : ""
          }
        </tbody>
      </table>
    </div>
  `;

  return renderLayout({
    title: "Overview",
    activeTab: "overview",
    content,
    port,
  });
}
