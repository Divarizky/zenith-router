import { getConnections } from "../../db/index.js";
import { isConnectionFullyCooledDown } from "../../services/auth.js";
import { isConnectionExhausted } from "../../services/quota.js";
import { getUsageStats } from "../../services/usage.js";
import { getAvailableModels } from "../../providers/index.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getLocalBaseUrl } from "../../security.js";

/**
 * Render Overview Dashboard page with Live Console Logs
 */
export function renderOverviewPage(port = 20120) {
  const connections = getConnections();
  const activeCount = connections.filter(
    (c) => c.is_active === 1 && !isConnectionFullyCooledDown(c) && !isConnectionExhausted(c)
  ).length;

  const usageToday = getUsageStats({ days: 1 });
  const models = getAvailableModels();
  const baseUrl = escapeHtml(getLocalBaseUrl(port));

  const content = `
    <div class="grid">
      <div class="card stat">
        <div class="label">Status Gateway</div>
        <div class="value" style="font-size: 1.5rem;">Aktif</div>
        <div class="sub">Port ${port}</div>
      </div>
      <div class="card stat">
        <div class="label">Koneksi Aktif</div>
        <div class="value">${activeCount} <span style="font-size: 1rem; color: var(--text-muted);">/ ${connections.length}</span></div>
        <div class="sub">Akun terkonfigurasi</div>
      </div>
      <div class="card stat">
        <div class="label">Token Dipakai (Hari Ini)</div>
        <div class="value">${usageToday.summary.total_tokens.toLocaleString()}</div>
        <div class="sub">${usageToday.summary.total_requests} permintaan</div>
      </div>
      <div class="card stat">
        <div class="label">Model Tersedia</div>
        <div class="value">${models.length}</div>
        <div class="sub"><a href="/dashboard/providers" style="color: inherit;">Kelola di Penyedia</a></div>
      </div>
    </div>


    <div class="card" style="margin-bottom: 1.5rem;">
      <h3>Client Integration Endpoints</h3>
      <table style="margin-top: 0.5rem;">
        <tbody>
          <tr><td style="width: 160px;"><strong>OpenAI Chat</strong></td><td><code>${baseUrl}/v1/chat/completions</code></td></tr>
          <tr><td><strong>Claude Messages</strong></td><td><code>${baseUrl}/v1/messages</code></td></tr>
          <tr><td><strong>Responses API</strong></td><td><code>${baseUrl}/v1/responses</code></td></tr>
          <tr><td><strong>Penemuan Model</strong></td><td><code>${baseUrl}/v1/models</code></td></tr>
        </tbody>
      </table>
    </div>

    <!-- Live Console Log Card -->
    <div class="card console-log-card" style="padding: 0; overflow: hidden; margin-bottom: 2rem;">
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 0.85rem 1rem; border-bottom: 1px solid var(--border); background: var(--surface-2); flex-wrap: wrap; gap: 0.5rem;">
        <div style="display: flex; align-items: center; gap: 0.65rem;">
          <h3 style="font-size: 0.95rem; margin: 0; font-weight: 600;">Console Log</h3>
          <span id="log-status" class="badge" style="background: rgba(52,211,153,0.12); color: var(--success); font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: 999px; display: inline-flex; align-items: center; gap: 0.35rem;">
            <span style="width: 6px; height: 6px; border-radius: 50%; background: var(--success);"></span>
            Connecting...
          </span>
        </div>

        <div style="display: flex; align-items: center; gap: 0.6rem;">
          <input
            type="text"
            id="log-filter"
            placeholder="Saring log..."
            style="width: 160px; padding: 0.25rem 0.6rem; font-size: 0.78rem; border-radius: 6px; background: #0d0d0d;"
            oninput="applyLogFilter()"
          />
          <label style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; color: var(--text-muted); cursor: pointer; user-select: none;">
            <input type="checkbox" id="log-autoscroll" checked style="width: 13px; height: 13px; accent-color: var(--accent); cursor: pointer;" />
            Auto-scroll
          </label>
          <button type="button" class="btn btn-sm" onclick="clearLogs()" style="font-size: 0.75rem; padding: 0.25rem 0.65rem;">
            Clear
          </button>
        </div>
      </div>

      <div
        id="console-terminal"
        style="height: 380px; overflow-y: auto; background: #080808; padding: 0.85rem 1rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.78rem; line-height: 1.5; color: #d4d4d4;"
      >
        <div id="log-entries" style="display: flex; flex-direction: column; gap: 2px;">
          <div class="log-empty" style="color: var(--text-subtle); padding: 1rem 0; text-align: center;">Menunggu log aktivitas gateway...</div>
        </div>
      </div>
    </div>

    <script>
      (function() {
        const terminal = document.getElementById('console-terminal');
        const container = document.getElementById('log-entries');
        const statusBadge = document.getElementById('log-status');
        const autoScrollCheck = document.getElementById('log-autoscroll');
        const filterInput = document.getElementById('log-filter');
        let allLogs = [];
        let es = null;

        function colorizeLine(text) {
          const div = document.createElement('div');
          div.className = 'log-line';
          div.style.wordBreak = 'break-all';
          div.style.whiteSpace = 'pre-wrap';

          let color = '#d4d4d4';
          if (text.includes('[ERROR]')) color = '#f87171';
          else if (text.includes('[WARN]')) color = '#fbbf24';
          else if (text.includes('[INFO]')) color = '#60a5fa';
          else if (text.includes('[DEBUG]')) color = '#c084fc';
          else if (text.includes('Zenith Router') || text.includes('[zenith]') || text.includes('Dashboard:')) color = '#34d399';

          div.style.color = color;
          div.textContent = text;
          return div;
        }

        function renderLogs() {
          const filter = (filterInput.value || '').toLowerCase();
          container.innerHTML = '';
          const filtered = filter ? allLogs.filter(l => l.toLowerCase().includes(filter)) : allLogs;

          if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'log-empty';
            empty.style.color = 'var(--text-subtle)';
            empty.style.padding = '1rem 0';
            empty.style.textAlign = 'center';
            empty.textContent = filter ? 'Tidak ada log yang cocok dengan filter.' : 'Menunggu log aktivitas gateway...';
            container.appendChild(empty);
            return;
          }

          for (const line of filtered) {
            container.appendChild(colorizeLine(line));
          }

          if (autoScrollCheck.checked) {
            terminal.scrollTop = terminal.scrollHeight;
          }
        }

        window.applyLogFilter = function() {
          renderLogs();
        };

        window.clearLogs = async function() {
          try {
            await fetch('/api/console-logs', { method: 'DELETE' });
            allLogs = [];
            renderLogs();
          } catch (e) {
            console.error('Failed to clear logs:', e);
          }
        };

        function connectSSE() {
          if (es) es.close();
          es = new EventSource('/api/console-logs/stream');

          es.onopen = function() {
            statusBadge.style.background = 'rgba(52,211,153,0.12)';
            statusBadge.style.color = 'var(--success)';
            statusBadge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:var(--success);"></span> Live';
          };

          es.onmessage = function(e) {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === 'init') {
                allLogs = msg.logs || [];
                renderLogs();
              } else if (msg.type === 'lines') {
                if (msg.lines && msg.lines.length) {
                  allLogs.push(...msg.lines);
                  if (allLogs.length > 1000) allLogs = allLogs.slice(-1000);
                  renderLogs();
                }
              } else if (msg.type === 'clear') {
                allLogs = [];
                renderLogs();
              }
            } catch (err) {}
          };

          es.onerror = function() {
            statusBadge.style.background = 'rgba(248,113,113,0.12)';
            statusBadge.style.color = 'var(--danger)';
            statusBadge.innerHTML = '<span style="width:6px;height:6px;border-radius:50%;background:var(--danger);"></span> Offline';
          };
        }

        connectSSE();
        if (window.__zrSwapCleanups) {
          window.__zrSwapCleanups.push(function () { if (es) { es.close(); es = null; } });
        }
      })();
    </script>
  `;

  return renderLayout({
    title: "Overview",
    activeTab: "overview",
    content,
    port,
  });
}
