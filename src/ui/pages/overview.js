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
      <div class="card stat">
        <div class="label">Gateway Status</div>
        <div class="value" style="font-size: 1.5rem;">Online</div>
        <div class="sub">Port ${port}</div>
      </div>
      <div class="card stat">
        <div class="label">Active Connections</div>
        <div class="value">${activeCount} <span style="font-size: 1rem; color: var(--text-muted);">/ ${connections.length}</span></div>
        <div class="sub">Accounts configured</div>
      </div>
      <div class="card stat">
        <div class="label">Tokens Used (Today)</div>
        <div class="value">${usageToday.summary.total_tokens.toLocaleString()}</div>
        <div class="sub">${usageToday.summary.total_requests} requests</div>
      </div>
      <div class="card stat">
        <div class="label">Available Models</div>
        <div class="value">${models.length}</div>
        <div class="sub"><a href="/dashboard/providers" style="color: inherit;">Kelola di Providers</a></div>
      </div>
    </div>

    <div class="card">
      <h3>Client Integration Endpoints</h3>
      <table style="margin-top: 0.5rem;">
        <tbody>
          <tr><td style="width: 160px;"><strong>OpenAI Chat</strong></td><td><code>${baseUrl}/v1/chat/completions</code></td></tr>
          <tr><td><strong>Claude Messages</strong></td><td><code>${baseUrl}/v1/messages</code></td></tr>
          <tr><td><strong>Responses API</strong></td><td><code>${baseUrl}/v1/responses</code></td></tr>
          <tr><td><strong>Model Discovery</strong></td><td><code>${baseUrl}/v1/models</code></td></tr>
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
