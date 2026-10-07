import { getUsageStats } from "../../services/usage.js";
import { getAllQuotaStatus } from "../../services/quota.js";
import { renderLayout } from "../layout.js";

/**
 * Render Usage Analytics and Quota page
 */
export function renderUsagePage(port = 20128) {
  const stats = getUsageStats({ days: 30 });
  const quotas = getAllQuotaStatus();

  const content = `
    <div class="grid">
      <div class="card">
        <h3>Total Requests (30d)</h3>
        <div class="value">${stats.summary.total_requests}</div>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Avg: ${stats.summary.avg_duration_ms}ms</p>
      </div>
      <div class="card">
        <h3>Input Tokens</h3>
        <div class="value">${stats.summary.total_input_tokens.toLocaleString()}</div>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Prompt context</p>
      </div>
      <div class="card">
        <h3>Output Tokens</h3>
        <div class="value">${stats.summary.total_output_tokens.toLocaleString()}</div>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Generated content</p>
      </div>
      <div class="card">
        <h3>Total Tokens</h3>
        <div class="value" style="color: var(--primary);">${stats.summary.total_tokens.toLocaleString()}</div>
        <p style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">Combined usage</p>
      </div>
    </div>

    <div class="card" style="margin-bottom: 1.5rem;">
      <h3>Token Consumption by Model</h3>
      ${
        stats.by_model.length === 0
          ? `<p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 0.5rem;">No usage records recorded yet.</p>`
          : `<table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Requests</th>
            <th>Total Tokens</th>
          </tr>
        </thead>
        <tbody>
          ${stats.by_model
            .map(
              (m) => `
            <tr>
              <td><code>${m.model}</code></td>
              <td>${m.count}</td>
              <td><strong>${m.total_tokens.toLocaleString()}</strong></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`
      }
    </div>

    <div class="card">
      <h3>Account Quotas & Balance</h3>
      ${
        quotas.length === 0
          ? `<p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 0.5rem;">No accounts configured.</p>`
          : `<table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Provider</th>
            <th>Remaining Quota</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${quotas
            .map(
              (q) => `
            <tr>
              <td><strong>${q.name}</strong></td>
              <td><span class="badge">${q.provider}</span></td>
              <td>${
                q.quota?.remaining !== null && q.quota?.remaining !== undefined
                  ? `${q.quota.remaining.toLocaleString()} ${q.quota.unit || ""}`
                  : `<span style="color: var(--text-muted);">Unlimited / Unmetered</span>`
              }</td>
              <td>${
                q.is_exhausted
                  ? `<span class="badge badge-danger">Exhausted</span>`
                  : `<span class="badge badge-success">OK</span>`
              }</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`
      }
    </div>
  `;

  return renderLayout({
    title: "Usage Analytics",
    activeTab: "usage",
    content,
    port,
  });
}
