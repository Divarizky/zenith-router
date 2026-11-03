import { getConnections } from "../../db/index.js";
import { isConnectionFullyCooledDown } from "../../services/auth.js";
import { isConnectionExhausted } from "../../services/quota.js";
import { getUsageStats } from "../../services/usage.js";
import { getAvailableModels } from "../../providers/index.js";
import { listCombos } from "../../services/combos.js";
import { isFreeModel } from "../../services/managedCombos.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getLocalBaseUrl } from "../../security.js";

/**
 * Render Overview Dashboard page with Live Console Logs and Bento HUD
 */
export function renderOverviewPage(port = 20120) {
  const connections = getConnections();
  const activeCount = connections.filter(
    (c) => (c.is_active !== 0) && !isConnectionFullyCooledDown(c) && !isConnectionExhausted(c)
  ).length;

  const usageToday = getUsageStats({ days: 1 });
  let models = [];
  try {
    models = getAvailableModels({ all: true });
  } catch {
    models = [];
  }

  let allCombos = [];
  try {
    allCombos = listCombos();
  } catch {
    allCombos = [];
  }
  const zenithCombos = allCombos.filter((c) => c.name && c.name.startsWith("zenith-"));
  const smartCombo = zenithCombos.find((c) => c.name === "zenith-smart");
  const fastCombo = zenithCombos.find((c) => c.name === "zenith-fast");
  const freeCombo = zenithCombos.find((c) => c.name === "zenith-free");

  const smartModels = smartCombo && Array.isArray(smartCombo.models) ? smartCombo.models : [];
  const fastModels = fastCombo && Array.isArray(fastCombo.models) ? fastCombo.models : [];
  const freeModels = freeCombo && Array.isArray(freeCombo.models) ? freeCombo.models : [];

  const freeModelsCount = models.filter((m) => isFreeModel(m)).length;
  const baseUrl = escapeHtml(getLocalBaseUrl(port));

  const content = `
    <!-- Top Metrics Grid (01, 02, 03, 04) -->
    <div class="grid" style="margin-bottom: 1.5rem;">
      <div class="card stat">
        <span class="stat-index">01</span>
        <div class="label">Status Gateway</div>
        <div class="value" style="font-size: 1.5rem;">
          <span class="pill pill-success" style="font-size: var(--text-xs); font-weight: 800; border: var(--bw) solid var(--line); box-shadow: 2px 2px 0 var(--shadow-ink);">
            <span class="dot dot-success" style="width:7px;height:7px;display:inline-block;"></span> Aktif
          </span>
        </div>
        <div class="sub">Port ${port} &middot; 127.0.0.1</div>
      </div>
      <div class="card stat">
        <span class="stat-index">02</span>
        <div class="label">Koneksi Aktif</div>
        <div class="value">${activeCount} <span style="font-size: 1rem; color: var(--text-muted); font-weight: 600;">/ ${connections.length}</span></div>
        <div class="sub">Akun terkonfigurasi</div>
      </div>
      <div class="card stat">
        <span class="stat-index">03</span>
        <div class="label">Token &amp; Permintaan Hari Ini</div>
        <div class="value">${usageToday.summary.total_tokens.toLocaleString()} <span style="font-size: 1rem; color: var(--text-muted); font-weight: 600;">tok</span></div>
        <div class="sub">${usageToday.summary.total_requests} permintaan tercatat</div>
      </div>
      <div class="card stat">
        <span class="stat-index">04</span>
        <div class="label">Total Model Gratis / Managed Combos</div>
        <div class="value">${freeModelsCount} <span style="font-size: 1rem; color: var(--text-muted); font-weight: 600;">gratis</span> / ${zenithCombos.length} <span style="font-size: 1rem; color: var(--text-muted); font-weight: 600;">combos</span></div>
        <div class="sub"><a href="/dashboard/providers" style="color: inherit; text-decoration: underline;">Kelola di Providers &amp; Combos &rarr;</a></div>
      </div>
    </div>

    <!-- Split Bento Section (2 Kolom) -->
    <div class="bento-split-grid">
      <!-- Kolom Kiri: Client Integration Endpoints -->
      <div class="card bento-card client-endpoints-card">
        <div class="card-header-neo">
          <div>
            <h3 style="margin: 0; font-size: 1rem; font-weight: 900; letter-spacing: 0.02em; text-transform: uppercase;">Client Integration Endpoints</h3>
            <p style="margin: 0.25rem 0 0; font-size: var(--text-xs); color: var(--text-muted);">Integrasikan tool AI dan coding agent ke endpoint lokal Zenith Router</p>
          </div>
          <span class="pill pill-info" style="font-size: var(--text-xs); font-weight: 800; border: var(--bw) solid var(--line); box-shadow: 2px 2px 0 var(--shadow-ink);">Local Loopback</span>
        </div>

        <div style="margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
          <!-- 1. OpenAI Chat -->
          <div class="endpoint-item">
            <div class="endpoint-meta">
              <div class="endpoint-title-row">
                <span class="method-tag method-post">POST</span>
                <span class="endpoint-name">OpenAI Chat</span>
                <span class="endpoint-desc">&mdash; Cursor, Continue, Aider, Open WebUI</span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm copy-btn" onclick="copyEndpoint(this, '${baseUrl}/v1/chat/completions')">Salin</button>
            </div>
            <div class="endpoint-code-box">
              <code>${baseUrl}/v1/chat/completions</code>
            </div>
          </div>

          <!-- 2. Claude Messages -->
          <div class="endpoint-item">
            <div class="endpoint-meta">
              <div class="endpoint-title-row">
                <span class="method-tag method-post">POST</span>
                <span class="endpoint-name">Claude Messages</span>
                <span class="endpoint-desc">&mdash; Claude Code, Anthropic SDK</span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm copy-btn" onclick="copyEndpoint(this, '${baseUrl}/v1/messages')">Salin</button>
            </div>
            <div class="endpoint-code-box">
              <code>${baseUrl}/v1/messages</code>
            </div>
          </div>

          <!-- 3. Responses API -->
          <div class="endpoint-item">
            <div class="endpoint-meta">
              <div class="endpoint-title-row">
                <span class="method-tag method-post">POST</span>
                <span class="endpoint-name">Responses API</span>
                <span class="endpoint-desc">&mdash; OpenAI format</span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm copy-btn" onclick="copyEndpoint(this, '${baseUrl}/v1/responses')">Salin</button>
            </div>
            <div class="endpoint-code-box">
              <code>${baseUrl}/v1/responses</code>
            </div>
          </div>

          <!-- 4. Models Catalog -->
          <div class="endpoint-item">
            <div class="endpoint-meta">
              <div class="endpoint-title-row">
                <span class="method-tag method-get">GET</span>
                <span class="endpoint-name">Models Catalog</span>
                <span class="endpoint-desc">&mdash; Katalog model &amp; info kuota</span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm copy-btn" onclick="copyEndpoint(this, '${baseUrl}/v1/models')">Salin</button>
            </div>
            <div class="endpoint-code-box">
              <code>${baseUrl}/v1/models</code>
            </div>
          </div>
        </div>
      </div>

      <!-- Kolom Kanan: Widget Managed Super-Combos -->
      <div class="card bento-card managed-combos-card">
        <div class="card-header-neo">
          <div>
            <h3 style="margin: 0; font-size: 1rem; font-weight: 900; letter-spacing: 0.02em; text-transform: uppercase;">Managed Super-Combos</h3>
            <p style="margin: 0.25rem 0 0; font-size: var(--text-xs); color: var(--text-muted);">Routing multi-provider otomatis tier gratis</p>
          </div>
          <span class="pill pill-lime" style="font-size: var(--text-xs); font-weight: 800; border: var(--bw) solid var(--line); box-shadow: 2px 2px 0 var(--shadow-ink); color: #0a0a0a;">100% Free Tier</span>
        </div>

        <div style="margin-top: 1rem; display: flex; flex-direction: column; gap: 0.75rem;">
          <!-- zenith-smart -->
          <div class="combo-tier-box">
            <div class="combo-tier-header">
              <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <span class="combo-tier-badge smart">zenith-smart</span>
                <span class="combo-tier-sub">Coding Cerdas &amp; Reasoning</span>
              </div>
              <span class="combo-tier-count">${smartModels.length} Model</span>
            </div>
            <div class="combo-chips">
              ${smartModels.length > 0 ? smartModels.slice(0, 3).map((m, idx) => `
                <div class="combo-chip" title="${escapeHtml(m)}">
                  <span class="chip-rank">#${idx + 1}</span>
                  <code class="chip-id">${escapeHtml(m)}</code>
                </div>
              `).join("") : `<div class="combo-empty-hint">Belum ada model aktif terdaftar</div>`}
            </div>
          </div>

          <!-- zenith-fast -->
          <div class="combo-tier-box">
            <div class="combo-tier-header">
              <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <span class="combo-tier-badge fast">zenith-fast</span>
                <span class="combo-tier-sub">Autocomplete &amp; Edit Cepat</span>
              </div>
              <span class="combo-tier-count">${fastModels.length} Model</span>
            </div>
            <div class="combo-chips">
              ${fastModels.length > 0 ? fastModels.slice(0, 3).map((m, idx) => `
                <div class="combo-chip" title="${escapeHtml(m)}">
                  <span class="chip-rank">#${idx + 1}</span>
                  <code class="chip-id">${escapeHtml(m)}</code>
                </div>
              `).join("") : `<div class="combo-empty-hint">Belum ada model aktif terdaftar</div>`}
            </div>
          </div>

          <!-- zenith-free -->
          <div class="combo-tier-box">
            <div class="combo-tier-header">
              <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                <span class="combo-tier-badge free">zenith-free</span>
                <span class="combo-tier-sub">Koleksi Lengkap Agentic Gate</span>
              </div>
              <span class="combo-tier-count">${freeModels.length} Model Lolos</span>
            </div>
            <div class="combo-free-desc">
              <div style="margin-bottom: 0.35rem;">
                <strong>${freeModels.length} model gratis</strong> memenuhi kualifikasi agentic (konteks &ge; 100k token &amp; mendukung tool calling).
              </div>
              ${freeModels.length > 0 ? `
                <div class="combo-chips">
                  ${freeModels.slice(0, 3).map((m, idx) => `
                    <div class="combo-chip" title="${escapeHtml(m)}">
                      <span class="chip-rank">#${idx + 1}</span>
                      <code class="chip-id">${escapeHtml(m)}</code>
                    </div>
                  `).join("")}
                </div>
              ` : ""}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Live Console Log Card -->
    <div class="card console-log-card" style="padding: 0; overflow: hidden; margin-bottom: 2rem;">
      <div class="window-header window-header-blue" style="flex-wrap: wrap;" aria-label="Console Log">
        <div style="display: flex; align-items: center; gap: 0.65rem;">
          <span class="window-title" style="color: #ffffff; font-weight: 900;">CONSOLE.LOG</span>
          <span id="log-status" class="pill pill-success" style="font-size: var(--text-xs); border: 1.5px solid #000000; box-shadow: 2px 2px 0 #000000;">
            <span class="dot dot-success" style="width:6px;height:6px;"></span>
            Connecting...
          </span>
        </div>

        <div style="display: flex; align-items: center; gap: 0.6rem;">
          <input
            type="text"
            id="log-filter"
            placeholder="Saring log..."
            style="width: 160px; padding: 0.25rem 0.6rem; font-size: var(--text-xs); border-radius: 0; background: var(--surface); color: var(--text); border: 1.5px solid #000000; box-shadow: 2px 2px 0 #000000;"
            oninput="applyLogFilter()"
          />
          <label style="display: inline-flex; align-items: center; gap: 0.35rem; font-size: var(--text-xs); color: #ffffff; font-weight: 800; cursor: pointer; user-select: none;">
            <input type="checkbox" id="log-autoscroll" checked style="width: 13px; height: 13px; accent-color: #2563eb; cursor: pointer;" />
            Auto-scroll
          </label>
          <button type="button" class="btn btn-sm" onclick="clearLogs()" style="font-size: var(--text-xs); padding: 0.25rem 0.65rem; background: #ffffff; color: #000000; border: 1.5px solid #000000; box-shadow: 2px 2px 0 #000000; font-weight: 800;">
            Clear
          </button>
        </div>
        <div class="window-controls" aria-hidden="true"><span>_</span><span>&#9633;</span><span class="wc-close">&#10005;</span></div>
      </div>

      <div
        id="console-terminal"
        style="height: 380px; overflow-y: auto; background: #080808; padding: 0.85rem 1rem; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: var(--text-xs); line-height: 1.5; color: #d4d4d4;"
      >
        <div id="log-entries" style="display: flex; flex-direction: column; gap: 2px;">
          <div class="log-empty" style="color: #a3a3a3; padding: 1rem 0; text-align: center;">Menunggu log aktivitas gateway...</div>
        </div>
      </div>
    </div>

    <script>
      window.copyEndpoint = function(btn, text) {
        function showFeedback() {
          var original = btn.textContent;
          btn.textContent = 'Tersalin!';
          btn.classList.add('btn-copied');
          setTimeout(function() {
            btn.textContent = original;
            btn.classList.remove('btn-copied');
          }, 1800);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(showFeedback).catch(function() {
            fallbackCopy(text, showFeedback);
          });
        } else {
          fallbackCopy(text, showFeedback);
        }
      };
      function fallbackCopy(text, cb) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          cb();
        } catch (e) {}
      }

      (function () {
        var terminal = document.getElementById('console-terminal');
        var entries = document.getElementById('log-entries');
        var statusBadge = document.getElementById('log-status');
        var filterInput = document.getElementById('log-filter');
        var autoscrollCheck = document.getElementById('log-autoscroll');
        var maxLogs = 500;
        var allLogs = [];
        var es = null;

        var LEVEL_COLORS = {
          log: '#a3a3a3',
          info: 'var(--info)',
          route: 'var(--accent-lime)',
          routing: 'var(--accent-lime)',
          usage: 'var(--success)',
          warn: 'var(--warning)',
          warning: 'var(--warning)',
          error: 'var(--danger)',
          debug: 'var(--text-subtle)',
          combo: 'var(--accent-pink, #ffb3d9)',
          fallback: 'var(--warning)',
          traffic: 'var(--traffic)'
        };

        function escapeLogHtml(str) {
          if (!str) return '';
          return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        }

        function formatLocalTime(date) {
          var d = date || new Date();
          var pad = function (n) { return String(n).padStart(2, '0'); };
          return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }

        function parseLogLine(raw) {
          if (raw === null || raw === undefined) return null;
          if (typeof raw === 'object') {
            var tsObj = raw.timestamp || '';
            if (typeof tsObj === 'string' && tsObj.includes('T')) {
              tsObj = tsObj.split('T')[1]?.replace('Z', '') || tsObj;
            }
            return {
              timestamp: tsObj || formatLocalTime(new Date()),
              level: String(raw.level || 'LOG').toUpperCase(),
              message: String(raw.message || ''),
              requestId: raw.requestId ? String(raw.requestId) : '',
              model: raw.model ? String(raw.model) : ''
            };
          }

          var str = String(raw).trim();
          if (!str) return null;

          var ts = '';
          var level = 'LOG';
          var msg = str;

          var tsMatch = msg.match(/^\\[(\\d{1,2}:\\d{2}(?::\\d{2})?)\\]\\s*/);
          if (tsMatch) {
            ts = tsMatch[1];
            msg = msg.slice(tsMatch[0].length);
          } else {
            ts = formatLocalTime(new Date());
          }

          var tagMatch = msg.match(/^\\[([A-Za-z0-9_-]+)\\]\\s*/);
          if (tagMatch) {
            level = tagMatch[1].toUpperCase();
            msg = msg.slice(tagMatch[0].length);

            if (level === 'LOG' || level === 'INFO') {
              var subTagMatch = msg.match(/^\\[([A-Z0-9_-]+)\\]\\s*/);
              if (subTagMatch) {
                level = subTagMatch[1].toUpperCase();
                msg = msg.slice(subTagMatch[0].length);
              }
            }
          }

          return {
            timestamp: ts,
            level: level,
            message: msg,
            requestId: '',
            model: ''
          };
        }

        function formatLogEntry(log) {
          var ts = log.timestamp ? (log.timestamp.includes('T') ? log.timestamp.split('T')[1].replace('Z', '') : log.timestamp) : formatLocalTime(new Date());
          var rawLevel = log.level || 'LOG';
          var levelKey = rawLevel.toLowerCase();
          var color = LEVEL_COLORS[levelKey] || 'var(--text)';
          var msg = escapeLogHtml(log.message || '');
          var reqId = log.requestId ? '<span style="color:var(--text-subtle); margin-right:4px;">[' + escapeLogHtml(log.requestId.slice(-6)) + ']</span>' : '';
          var model = log.model ? '<span style="color:var(--accent-lime); margin-right:4px;">(' + escapeLogHtml(log.model) + ')</span>' : '';

          return '<div class="log-line" data-level="' + escapeLogHtml(levelKey) + '" style="display:flex; gap:0.5rem; word-break:break-all;">' +
            '<span style="color:var(--text-subtle); flex-shrink:0;">' + escapeLogHtml(ts) + '</span>' +
            '<span style="color:' + color + '; font-weight:800; text-transform:uppercase; flex-shrink:0; min-width:56px;">' + escapeLogHtml(rawLevel) + '</span>' +
            '<div>' + reqId + model + msg + '</div>' +
            '</div>';
        }

        function filterEntry(log, query) {
          if (!query) return true;
          var q = query.toLowerCase();
          return (log.message && log.message.toLowerCase().includes(q)) ||
                 (log.level && log.level.toLowerCase().includes(q)) ||
                 (log.model && log.model.toLowerCase().includes(q)) ||
                 (log.requestId && log.requestId.toLowerCase().includes(q)) ||
                 (log.timestamp && log.timestamp.toLowerCase().includes(q));
        }

        window.applyLogFilter = function () {
          var query = filterInput.value.trim();
          entries.innerHTML = '';
          var filtered = allLogs.filter(function (l) { return filterEntry(l, query); });
          if (filtered.length === 0) {
            entries.innerHTML = '<div class="log-empty" style="color:var(--text-subtle); padding:1rem 0; text-align:center;">' +
              (allLogs.length === 0 ? 'Menunggu log aktivitas gateway...' : 'Tidak ada log yang cocok dengan filter.') + '</div>';
            return;
          }
          filtered.forEach(function (log) {
            entries.insertAdjacentHTML('beforeend', formatLogEntry(log));
          });
          if (autoscrollCheck.checked) {
            terminal.scrollTop = terminal.scrollHeight;
          }
        };

        window.clearLogs = function () {
          allLogs = [];
          entries.innerHTML = '<div class="log-empty" style="color:var(--text-subtle); padding:1rem 0; text-align:center;">Log dibersihkan. Menunggu log baru...</div>';
        };

        function addLogEntry(log) {
          if (!log) return;
          var emptyMsg = entries.querySelector('.log-empty');
          if (emptyMsg) emptyMsg.remove();

          allLogs.push(log);
          if (allLogs.length > maxLogs) allLogs.shift();

          if (filterEntry(log, filterInput.value.trim())) {
            entries.insertAdjacentHTML('beforeend', formatLogEntry(log));
            while (entries.children.length > maxLogs) {
              entries.removeChild(entries.firstElementChild);
            }
            if (autoscrollCheck.checked) {
              terminal.scrollTop = terminal.scrollHeight;
            }
          }
        }

        function handleIncomingData(data) {
          if (!data) return;

          // Event type: "init" with initial backlog
          if (data.type === 'init' && Array.isArray(data.logs)) {
            allLogs = [];
            entries.innerHTML = '';
            if (data.logs.length === 0) {
              entries.innerHTML = '<div class="log-empty" style="color:var(--text-subtle); padding:1rem 0; text-align:center;">Menunggu log aktivitas gateway...</div>';
            } else {
              data.logs.forEach(function (item) {
                var parsed = parseLogLine(item);
                if (parsed) addLogEntry(parsed);
              });
            }
            return;
          }

          // Event type: "lines" with batched new lines
          if (data.type === 'lines' && Array.isArray(data.lines)) {
            data.lines.forEach(function (item) {
              var parsed = parseLogLine(item);
              if (parsed) addLogEntry(parsed);
            });
            return;
          }

          // Event type: "clear"
          if (data.type === 'clear') {
            window.clearLogs();
            return;
          }

          // Array of logs
          if (Array.isArray(data)) {
            data.forEach(function (item) {
              var parsed = parseLogLine(item);
              if (parsed) addLogEntry(parsed);
            });
            return;
          }

          // Single log line / object
          var parsed = parseLogLine(data);
          if (parsed) addLogEntry(parsed);
        }

        function connectSSE() {
          if (es) es.close();
          es = new EventSource('/api/console-logs/stream');

          es.onopen = function () {
            statusBadge.className = 'pill pill-success';
            statusBadge.style.fontSize = 'var(--text-xs)';
            statusBadge.style.border = '1.5px solid #000000';
            statusBadge.style.boxShadow = '2px 2px 0 #000000';
            statusBadge.innerHTML = '<span class="dot dot-success" style="width:6px;height:6px;"></span> Live';
          };

          es.onmessage = function (e) {
            try {
              if (!e.data || !e.data.trim()) return;
              var data = JSON.parse(e.data);
              handleIncomingData(data);
            } catch (err) {
              if (e.data && e.data.trim()) {
                var parsed = parseLogLine(e.data);
                if (parsed) addLogEntry(parsed);
              }
            }
          };

          es.onerror = function () {
            statusBadge.className = 'pill pill-danger';
            statusBadge.style.fontSize = 'var(--text-xs)';
            statusBadge.style.border = '1.5px solid #000000';
            statusBadge.style.boxShadow = '2px 2px 0 #000000';
            statusBadge.innerHTML = '<span class="dot dot-danger" style="width:6px;height:6px;"></span> Reconnecting';
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
