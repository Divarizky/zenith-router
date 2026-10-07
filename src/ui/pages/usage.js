import { getUsageStats } from "../../services/usage.js";
import { getAllQuotaStatus } from "../../services/quota.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";

/**
 * Render Usage Analytics and Quota page
 */
export function renderUsagePage(port = 20120) {
  const stats = getUsageStats({ days: 30 });
  const quotas = getAllQuotaStatus();

  const content = `
    <div class="grid">
      <div class="card stat">
        <div class="label">Total Requests (30d)</div>
        <div class="value">${stats.summary.total_requests}</div>
        <div class="sub">Avg: ${stats.summary.avg_duration_ms}ms</div>
      </div>
      <div class="card stat">
        <div class="label">Input Tokens</div>
        <div class="value">${stats.summary.total_input_tokens.toLocaleString()}</div>
        <div class="sub">Prompt context</div>
      </div>
      <div class="card stat">
        <div class="label">Output Tokens</div>
        <div class="value">${stats.summary.total_output_tokens.toLocaleString()}</div>
        <div class="sub">Generated content</div>
      </div>
      <div class="card stat">
        <div class="label">Total Tokens</div>
        <div class="value">${stats.summary.total_tokens.toLocaleString()}</div>
        <div class="sub">Combined usage</div>
      </div>
    </div>

    <div class="card">
      <h3>Account Quotas & Balance</h3>
      ${
        quotas.length === 0
          ? `<div class="empty"><p class="big">No accounts configured</p><p>Tambahkan connection untuk melihat kuota.</p></div>`
          : `<table>
        <thead>
          <tr><th>Account</th><th>Provider</th><th>Remaining Quota</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${quotas
            .map(
              (q) => `
            <tr>
              <td><strong>${escapeHtml(q.name)}</strong></td>
              <td><span class="pill">${escapeHtml(q.provider)}</span></td>
              <td>${
                q.quota?.remaining !== null && q.quota?.remaining !== undefined
                  ? `${escapeHtml(Number(q.quota.remaining).toLocaleString())} ${escapeHtml(q.quota.unit || "")}`
                  : `<span class="hint">Unlimited / Unmetered</span>`
              }</td>
              <td>${
                q.is_exhausted
                  ? `<span class="pill pill-danger">Exhausted</span>`
                  : `<span class="pill pill-success">OK</span>`
              }</td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`
      }
    </div>

    <div class="card">
      <h3>Token Consumption by Model</h3>
      ${
        stats.by_model.length === 0
          ? `<div class="empty"><p class="big">No usage records yet</p><p>Kirim request ke /v1 untuk melihat statistik.</p></div>`
          : `<table>
        <thead>
          <tr><th>Model</th><th>Requests</th><th>Total Tokens</th></tr>
        </thead>
        <tbody>
          ${stats.by_model
            .map(
              (m) => `
            <tr>
              <td><code>${escapeHtml(m.model)}</code></td>
              <td>${m.count}</td>
              <td><strong>${m.total_tokens.toLocaleString()}</strong></td>
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
