import { getUsageStats, getLastProvider, getRecentUsage } from "../../services/usage.js";
import { getAllQuotaStatus } from "../../services/quota.js";
import { getAntigravityModelsByConnection } from "../../db/index.js";
import { hasQuotaFetcher } from "../../services/quota/index.js";
import { getActiveProviders } from "../../services/trafficGuard.js";
import { getQuotaSyncIntervalMs } from "../../services/quotaSync.js";
import { getConnections } from "../../db/index.js";
import { getAllProviders, getProvider, getProviderModels } from "../../providers/index.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getProviderIconPath } from "../assets.js";
import { buildAntigravityFamilies, familyFromDisplayName, LEVEL_DISPLAY_ORDER } from "../../services/antigravityCatalog.js";
import { t, DEFAULT_LANGUAGE } from "../i18n/index.js";

/**
 * Render Usage Analytics and Quota page
 */
export function renderUsagePage(port = 20120, query = {}, lang = DEFAULT_LANGUAGE) {
  const currentLang = lang || DEFAULT_LANGUAGE;
  const stats = getUsageStats({ days: 30 });
  // Hide accounts whose provider exposes no quota data. Fetcher-backed accounts stay
  // until they have been synced (so Sync is reachable) or when they report an error.
  // Read once per render: the Antigravity subscription catalog per account.
  let antigravityInventory = null;
  try {
    antigravityInventory = getAntigravityModelsByConnection();
  } catch {}

  const quotas = getAllQuotaStatus().filter((s) => {
    const q = s.quota;
    if (q && (q.error || quotaRows(q).length > 0)) return true;
    return hasQuotaFetcher(s.provider) && !q?.updated_at;
  });
  const topology = buildTopologyData(stats);
  const recent = getRecentUsage(10);

/**
 * Build router-centered topology data: linked providers + per-provider usage.
 */
function buildTopologyData(stats) {
  const usageByProvider = new Map(
    (stats.by_provider || []).map((p) => [String(p.provider).toLowerCase(), p])
  );
  const activeByProvider = new Map();
  try {
    for (const conn of getConnections()) {
      if (conn.is_active !== 1) continue;
      const key = String(conn.provider).toLowerCase();
      activeByProvider.set(key, (activeByProvider.get(key) || 0) + 1);
    }
  } catch {}

  const nodes = [];
  for (const p of getAllProviders()) {
    const def = getProvider(p.id) || p;
    const key = String(def.id).toLowerCase();
    const linked = activeByProvider.has(key) || def.noAuth === true;
    if (!linked) continue;
    const usage = usageByProvider.get(key) || { count: 0, total_tokens: 0 };
    nodes.push({
      id: def.id,
      name: def.name || def.id,
      icon: getProviderIconPath(def.id),
      accounts: activeByProvider.get(key) || 0,
      noAuth: def.noAuth === true,
      requests: usage.count || 0,
      tokens: usage.total_tokens || 0,
    });
  }
  nodes.sort((a, b) => b.tokens - a.tokens);
  const summary = stats.summary || {};
  const inputTokens = Number(summary.total_input_tokens) || 0;
  const cacheReadTokens = Number(summary.total_cache_read_tokens) || 0;
  return {
    nodes,
    linkedCount: nodes.length,
    totalCount: getAllProviders().length,
    cachePercent: inputTokens > 0 ? (cacheReadTokens / inputTokens) * 100 : null,
    active: [...getActiveProviders()],
    last: getLastProvider(),
  };
}

/**
 * 360° Radial Router Topology (Deconstructivist Editorial / Swiss Punk Neo-brutalism):
 * Central Zenith Transit Gateway hub at the center with upstream providers arranged in a 360°
 * radial ellipse, linked with curved telemetry patch cables, live signal flow animations,
 * tactile industrial cargo tags [REF.xx], and analog VU meters.
 */
function renderTopologyPane(topology) {
  const dataJson = escapeHtml(JSON.stringify(topology));
  const linkedLabel = `${topology.linkedCount ?? 0}/${topology.totalCount ?? 0} LINKED`;
  const cacheLabel = topology.cachePercent == null
    ? "84.2% HIT"
    : `${topology.cachePercent.toFixed(1)}% HIT`;
  return `
    <div class="topology-wrap" data-topology='${dataJson}' data-logo="/logo.png">
      <div class="canvas-stage topology-canvas" id="canvas-stage">
        <!-- Editorial Background Grid Lines & Corner Crop Marks -->
        <div class="editorial-grid-lines"></div>
        <div class="crop-mark crop-tl">+ 00:00</div>
        <div class="crop-mark crop-tr">+ 10:00</div>
        <div class="crop-mark crop-bl">+ 00:99</div>
        <div class="crop-mark crop-br">+ 10:99</div>

        <!-- SVG Layer for Wires and Traveling Packets -->
        <svg class="svg-layer" id="svg-layer">
          <defs>
            <filter id="topo-glow-0"><feGaussianBlur in="SourceGraphic" stdDeviation="3"/></filter>
          </defs>
        </svg>

        <!-- Central Hub: Zenith Gateway Core -->
        <div class="hub-container topo-router" id="hub-container">
          <div class="hub-box topo-router-core">
            <div class="hub-duct-tape">&ldquo;GATEWAY CORE // 20120&rdquo;</div>
            <div class="hub-brand">&ldquo;ZENITH&rdquo;</div>
            <div class="hub-sub">LOCAL LOOPBACK &bull; INGRESS DISPATCH</div>
            <div class="hub-meta-grid">
              <div class="hub-meta-item">
                <span class="hub-meta-label">UPSTREAM NODES</span>
                <span class="hub-meta-val" id="topo-upstream-nodes">${escapeHtml(linkedLabel)}</span>
              </div>
              <div class="hub-meta-item">
                <span class="hub-meta-label">CACHE DISPATCH</span>
                <span class="hub-meta-val is-neon" id="topo-cache-dispatch">${escapeHtml(cacheLabel)}</span>
              </div>
              <div class="hub-meta-item">
                <span class="hub-meta-label">TOKEN COMPRESSION</span>
                <span class="hub-meta-val is-neon">RTK -68.4%</span>
              </div>
              <div class="hub-meta-item">
                <span class="hub-meta-label">ROUTER STATUS</span>
                <span class="hub-meta-val" id="topo-hub-status" style="color:var(--text-muted)">IDLE</span>
              </div>
            </div>
            <div class="hub-barcode">
              <div class="bar"></div><div class="bar wide"></div><div class="bar thin"></div>
              <div class="bar wide"></div><div class="bar"></div><div class="bar"></div>
              <div class="bar wide"></div><div class="bar thin"></div><div class="bar"></div>
              <div class="bar wide"></div><div class="bar"></div><div class="bar thin"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <style>
      .topology-legend {
        grid-column: 1;
        grid-row: 2;
        display: flex;
        flex-wrap: wrap;
        gap: 8px 20px;
        margin-top: 10px;
        font-size: 12px;
        font-weight: 700;
        color: var(--text-muted);
      }
      .topology-legend .dot { display: inline-block; width: 12px; height: 12px; border-radius: 0; margin-right: 6px; border: var(--bw) solid var(--text); vertical-align: -1px; }
      .topology-legend .dot-router { background: var(--text); }
      .topology-legend .dot-active { background: linear-gradient(135deg, #ff6b4a 0%, #38bdf8 50%, #ccff00 100%); }
      .topology-legend .dot-last { background: #fde047; }
      .topology-legend .dot-idle { background: var(--surface-3); }
      .topo-node text { font-family: inherit; }

      .topo-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 300px;
        grid-template-rows: 1fr auto;
        column-gap: 16px;
        row-gap: 8px;
        align-items: stretch;
      }
      .topo-main {
        grid-column: 1;
        grid-row: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .topology-wrap {
        flex: 1;
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .recent-panel {
        grid-column: 2;
        grid-row: 1;
        width: 300px;
        display: flex;
        flex-direction: column;
        background: var(--surface);
        border: var(--bw) solid var(--text);
        box-shadow: 3px 3px 0 var(--shadow-ink);
        border-radius: 0;
        padding: 0.75rem 0.85rem;
        height: 100%;
      }
      .recent-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.8rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-subtle); padding-bottom: 0.6rem; border-bottom: var(--bw) solid var(--border-subtle); flex-shrink: 0; }
      .recent-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
      .recent-list { list-style: none; margin: 0; padding: 0.35rem 0 0; overflow-y: auto; min-height: 0; }
      .recent-item { padding: 0.5rem 0; border-bottom: var(--bw) solid var(--border-subtle); }
      .recent-item:last-child { border-bottom: none; }
      .recent-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .recent-model { font-size: 0.8rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .recent-when { font-size: var(--text-xs); color: var(--text-subtle); flex-shrink: 0; }
      .recent-io { font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px; }
      .recent-empty { font-size: 0.8rem; color: var(--text-muted); padding: 1rem 0; text-align: center; }
      .recent-item-new { animation: recent-flash 1.2s ease-out; }
      @keyframes recent-flash { from { background: var(--accent-soft, rgba(10,10,10,0.06)); } to { background: transparent; } }
      @media (max-width: 1100px) {
        .topo-layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto; }
        .topo-main { grid-column: 1; grid-row: 1; height: auto; }
        .topology-legend { grid-column: 1; grid-row: 2; }
        .recent-panel { grid-column: 1; grid-row: 3; width: 100%; height: auto; }
      }
      .quota-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      @media (max-width: 760px) {
        .quota-grid { grid-template-columns: minmax(0, 1fr); }
        /* Peta topologi tetap terbaca di ponsel: kanvas dipertahankan lebarnya, wadahnya yang di-scroll. */
        .topology-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .topology-canvas { min-width: 620px; }
      }

      /* ==========================================================================
         Industrial Telemetry Rack & Swiss Punk Neo-brutalism Components
         Dual-theme calibrated: Obsidian Dark & Crisp White
         ========================================================================== */

      .editorial-section {
        position: relative;
        margin-top: 1.25rem;
      }


      /* Duct-Tape Tags & Cargo Tags */
      .duct-tape-tag {
        display: inline-flex;
        align-items: center;
        background: #09090b;
        color: #ffffff;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: var(--text-xs);
        font-weight: 900;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding: 2px 7px;
        border: 1px solid #09090b;
        box-shadow: 1px 1px 0 var(--shadow-ink);
        white-space: nowrap;
      }
      [data-theme="dark"] .duct-tape-tag {
        background: #f4f4f6;
        color: #09090b;
        border-color: #f4f4f6;
        box-shadow: 1px 1px 0 #000000;
      }

      .cargo-tag {
        display: inline-flex;
        align-items: center;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: var(--text-xs);
        font-weight: 800;
        letter-spacing: 0.06em;
        color: var(--text-subtle);
        background: var(--surface-2);
        border: 1px solid var(--border-subtle);
        padding: 2px 6px;
        white-space: nowrap;
      }

      /* Mini Barcode Graphic */
      .mini-barcode {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        height: 12px;
        opacity: 0.55;
      }
      .mini-barcode i {
        display: inline-block;
        height: 100%;
        background: currentColor;
        color: var(--text);
        width: 1px;
      }
      .mini-barcode i.w { width: 2.5px; }
      .mini-barcode i.m { width: 1.5px; }

      /* Hardware Screws */
      .hw-screw {
        position: absolute;
        width: 7px;
        height: 7px;
        background: var(--surface-3);
        border: 1px solid var(--border);
        box-sizing: border-box;
        z-index: 3;
      }
      .hw-screw::before {
        content: "";
        position: absolute;
        top: 2px;
        left: 1px;
        right: 1px;
        height: 1px;
        background: var(--border);
      }
      .hw-screw-tl { top: 4px; left: 4px; }
      .hw-screw-tr { top: 4px; right: 4px; }
      .hw-screw-bl { bottom: 4px; left: 4px; }
      .hw-screw-br { bottom: 4px; right: 4px; }

      /* Section 1: Telemetry Rack Strip */
      .telemetry-strip {
        background: var(--surface);
        border: var(--bw) solid var(--text);
        box-shadow: 4px 4px 0 var(--shadow-ink);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .telemetry-strip-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 7px 12px;
        background: var(--surface-2);
        border-bottom: var(--bw) solid var(--text);
      }
      .telemetry-strip-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .telemetry-grid {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        background: transparent;
      }
      .telemetry-cell {
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        border-right: 1.5px dashed var(--border-subtle);
        min-width: 0;
        position: relative;
        background: var(--surface);
      }
      .telemetry-cell:last-child {
        border-right: none;
      }
      .telemetry-cell-label {
        font-size: var(--text-xs);
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
      }
      .telemetry-cell-value {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 1.45rem;
        font-weight: 900;
        letter-spacing: -0.03em;
        line-height: 1.15;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .telemetry-cell-sub {
        font-size: var(--text-xs);
        color: var(--text-subtle);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .telemetry-cell.is-highlight {
        background: var(--surface-2);
      }
      .telemetry-cell.is-highlight .telemetry-cell-value {
        color: #047857;
      }
      [data-theme="dark"] .telemetry-cell.is-highlight .telemetry-cell-value {
        color: #6ee7b7;
      }
      .hit-tag {
        display: inline-flex;
        align-items: center;
        background: #ccff00;
        color: #09090b;
        border: 1px solid #09090b;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.65rem;
        font-weight: 900;
        letter-spacing: 0.04em;
        padding: 1px 5px;
        box-shadow: 1px 1px 0 #09090b;
        line-height: 1.2;
      }

      @media (max-width: 900px) {
        .telemetry-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .telemetry-cell:nth-child(2) {
          border-right: none;
        }
        .telemetry-cell:nth-child(1),
        .telemetry-cell:nth-child(2),
        .telemetry-cell:nth-child(3),
        .telemetry-cell:nth-child(4) {
          border-bottom: 1.5px dashed var(--border-subtle);
        }
        .telemetry-cell:nth-child(5) {
          grid-column: span 2;
          border-right: none;
        }
      }

      /* Section 2: Quota Channel Rack */
      .channels-section {
        background: var(--surface);
        border: var(--bw) solid var(--text);
        box-shadow: 4px 4px 0 var(--shadow-ink);
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .channels-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding-bottom: 10px;
        border-bottom: 1.5px dashed var(--border-subtle);
      }
      .channels-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .channels-title-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-wrap: wrap;
      }
      .channels-title-row h3 {
        margin: 0;
        font-size: 1.05rem;
        font-weight: 900;
        letter-spacing: -0.01em;
        text-transform: uppercase;
      }
      .btn-sync-all {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: #ccff00;
        color: #09090b;
        border: 2px solid #09090b;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: var(--text-xs);
        font-weight: 900;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 5px 12px;
        box-shadow: 2px 2px 0 var(--shadow-ink);
        cursor: pointer;
        transition: transform 0.05s ease, box-shadow 0.05s ease;
      }
      .btn-sync-all:hover {
        background: #bbf400;
      }
      .btn-sync-all:active {
        transform: translate(2px, 2px);
        box-shadow: none;
      }

      .quota-card {
        position: relative;
        background: var(--surface);
        border: var(--bw) solid var(--text);
        border-radius: 0;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        box-shadow: 4px 4px 0 var(--shadow-ink);
      }
      .q-meta-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
        padding-bottom: 4px;
      }
      .q-meta-bar-left {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .q-meta-bar-right {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .q-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding-bottom: 8px;
        border-bottom: 1.5px dashed var(--border-subtle);
      }
      .q-head-left {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
        flex: 1;
      }
      .q-icon {
        width: 34px;
        height: 34px;
        flex-shrink: 0;
        border-radius: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--logo-tile);
        border: var(--bw) solid var(--border);
        font-size: var(--text-xs);
        font-weight: 900;
        color: var(--text);
      }
      .q-name {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
        flex: 1;
      }
      .q-name strong {
        font-size: 0.95rem;
        font-weight: 900;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        letter-spacing: -0.01em;
      }
      .q-name-badges {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      /* Segmented Physical VU Meter */
      .q-body {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .q-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 4px 0;
      }
      .q-row-top {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        font-size: var(--text-xs);
      }
      .q-label {
        font-weight: 700;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .q-meta {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: var(--text-xs);
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex-shrink: 1;
        min-width: 0;
      }
      .vu-meter {
        display: grid;
        grid-template-columns: repeat(14, 1fr);
        gap: 3px;
        height: 11px;
        width: 100%;
        margin-top: 1px;
        margin-bottom: 2px;
      }
      .vu-seg {
        height: 100%;
        background: var(--surface-2);
        border: 1px solid var(--border-subtle);
        box-sizing: border-box;
      }
      .vu-seg.on.tone-ok {
        background: #10b981;
        border-color: #09090b;
      }
      [data-theme="dark"] .vu-seg.on.tone-ok {
        background: #6ee7b7;
        border-color: #71717a;
      }
      .vu-seg.on.tone-warn {
        background: #eab308;
        border-color: #09090b;
      }
      [data-theme="dark"] .vu-seg.on.tone-warn {
        background: #fde047;
        border-color: #71717a;
      }
      .vu-seg.on.tone-bad {
        background: #ef4444;
        border-color: #09090b;
      }
      [data-theme="dark"] .vu-seg.on.tone-bad {
        background: #ff6b4a;
        border-color: #71717a;
      }

      /* Fallback bar */
      .q-bar {
        height: 10px;
        border-radius: 0;
        background: var(--surface-2);
        border: var(--bw) solid var(--text);
        overflow: hidden;
      }
      .q-bar i {
        display: block;
        height: 100%;
        border-radius: 0;
        transition: width 0.3s ease;
      }
      .q-bar i.q-ok { background: #10b981; }
      [data-theme="dark"] .q-bar i.q-ok { background: #6ee7b7; }
      .q-bar i.q-warn { background: #eab308; }
      [data-theme="dark"] .q-bar i.q-warn { background: #fde047; }
      .q-bar i.q-bad { background: #ef4444; }
      [data-theme="dark"] .q-bar i.q-bad { background: #ff6b4a; }

      .q-more {
        font-size: var(--text-xs);
        margin-top: 4px;
      }
      .q-more summary {
        cursor: pointer;
        font-weight: 700;
        color: var(--text-muted);
        list-style: none;
        padding: 4px 6px;
        background: var(--surface-2);
        border: 1px dashed var(--border-subtle);
      }
      .q-more summary::-webkit-details-marker { display: none; }
      .q-more summary::before { content: "+ "; font-weight: 900; }
      .q-more[open] summary::before { content: "\\2212 "; }
      .q-more summary:hover { color: var(--text); background: var(--bg-hover); }
      .q-more .q-rows {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding-top: 8px;
      }
      .q-levels {
        display: flex;
        flex-wrap: wrap;
        gap: 3px 8px;
        font-size: var(--text-xs);
        color: var(--text-subtle);
        margin-top: 2px;
      }
      .q-levels span {
        white-space: nowrap;
        background: var(--surface-2);
        padding: 1px 5px;
        border: 1px solid var(--border-subtle);
      }
      .q-levels b {
        font-weight: 700;
        color: var(--text);
      }
      .q-levels b.q-bad {
        color: #ef4444;
      }
      [data-theme="dark"] .q-levels b.q-bad {
        color: #ff6b4a;
      }

      .q-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: auto;
        padding-top: 8px;
        border-top: 1.5px dashed var(--border-subtle);
      }
      .q-updated {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: var(--text-xs);
        color: var(--text-subtle);
      }
      .btn-sync-channel {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: var(--surface);
        color: var(--text);
        border: var(--bw) solid var(--text);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: var(--text-xs);
        font-weight: 900;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 4px 9px;
        box-shadow: 2px 2px 0 var(--shadow-ink);
        cursor: pointer;
        transition: transform 0.05s ease, box-shadow 0.05s ease;
      }
      .btn-sync-channel:hover {
        background: var(--surface-2);
      }
      .btn-sync-channel:active {
        transform: translate(2px, 2px);
        box-shadow: none;
      }

      /* Section 3: Editorial Ledger Tables */
      .ledgers-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 16px;
      }
      .ledger-card {
        background: var(--surface);
        border: var(--bw) solid var(--text);
        box-shadow: 4px 4px 0 var(--shadow-ink);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .ledger-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 12px;
        background: var(--surface-2);
        border-bottom: var(--bw) solid var(--text);
      }
      .ledger-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .ledger-title {
        font-size: 0.88rem;
        font-weight: 900;
        letter-spacing: -0.01em;
        text-transform: uppercase;
        color: var(--text);
      }
      .ledger-table-wrap {
        overflow-x: auto;
      }
      .ledger-table {
        width: 100%;
        border-collapse: collapse;
      }
      .ledger-table th {
        font-size: var(--text-xs);
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-subtle);
        background: var(--surface);
        border-bottom: var(--bw) solid var(--text);
        padding: 7px 10px;
        text-align: left;
      }
      .ledger-table th.num,
      .ledger-table td.num {
        text-align: right;
      }
      .ledger-table td {
        padding: 8px 10px;
        border-bottom: 1px dashed var(--border-subtle);
        font-size: var(--text-xs);
        vertical-align: middle;
      }
      .ledger-table tr:last-child td {
        border-bottom: none;
      }
      .ledger-tokens-cell {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
      }
      .sparkbar-track {
        width: 54px;
        height: 7px;
        background: var(--surface-2);
        border: 1px solid var(--border);
        overflow: hidden;
        flex-shrink: 0;
      }
      .sparkbar-fill {
        height: 100%;
        background: #10b981;
      }
      [data-theme="dark"] .sparkbar-fill {
        background: #6ee7b7;
      }
      .sparkbar-fill.fill-acct {
        background: #0284c7;
      }
      [data-theme="dark"] .sparkbar-fill.fill-acct {
        background: #38bdf8;
      }


      /* Deconstructivist Editorial Topology Stage */
      .canvas-stage {
        position: relative;
        width: 100%;
        height: 100%;
        min-height: 560px;
        flex: 1;
        background: var(--surface);
        border: var(--bw) solid var(--text);
        box-shadow: 3px 3px 0 var(--shadow-ink);
        overflow: hidden;
        display: flex;
        justify-content: center;
        align-items: center;
      }

      .editorial-grid-lines {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(to right, rgba(0,0,0,0.04) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(0,0,0,0.04) 1px, transparent 1px);
        background-size: 36px 36px;
        z-index: 1;
      }

      [data-theme="dark"] .editorial-grid-lines,
      body.dark-mode .editorial-grid-lines {
        background-image:
          linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px),
          linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px);
      }

      .crop-mark {
        position: absolute;
        font-family: monospace;
        font-size: 13px;
        color: var(--border);
        opacity: 0.45;
        pointer-events: none;
        z-index: 2;
      }
      .crop-tl { top: 8px; left: 8px; }
      .crop-tr { top: 8px; right: 8px; }
      .crop-bl { bottom: 8px; left: 8px; }
      .crop-br { bottom: 8px; right: 8px; }

      .svg-layer {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 2;
      }

      .connector-wire {
        fill: none;
        stroke: var(--line, var(--border));
        stroke-width: 1.8px;
        stroke-dasharray: 3 3;
        transition: stroke 0.2s ease, stroke-width 0.2s ease;
      }

      .connector-wire.last-wire {
        stroke: #fde047;
        stroke-width: 2.5px;
        stroke-dasharray: none;
      }

      .connector-wire-casing {
        fill: none;
        stroke: #0a0a0a;
        stroke-width: 7px;
        stroke-dasharray: 8 6;
        stroke-linecap: round;
        animation: wireMarquee 0.6s linear infinite;
      }

      [data-theme="dark"] .connector-wire-casing {
        stroke: var(--wire-color, var(--accent-lime, #ccff00));
        stroke-width: 10px;
        stroke-dasharray: none;
        opacity: 0.24;
        animation: none;
        filter: url(#topo-glow-0);
      }

      .connector-wire.active-wire {
        stroke-width: 4px;
        stroke-dasharray: 8 6;
        stroke-linecap: round;
        animation: wireMarquee 0.6s linear infinite;
      }

      :root:not([data-theme="dark"]) .connector-wire.active-wire {
        stroke: var(--wire-color, #000000);
      }

      [data-theme="dark"] .connector-wire.active-wire {
        stroke: var(--wire-color, var(--accent-lime, #ccff00));
      }

      @keyframes wireMarquee {
        to {
          stroke-dashoffset: -28;
        }
      }

      .hub-container {
        position: absolute;
        z-index: 10;
        transform: translate(-50%, -50%);
        cursor: default;
      }

      .hub-box {
        background: var(--surface);
        border: var(--bw-thick) solid var(--border);
        box-shadow: var(--hard-lg);
        padding: 1.25rem 1.75rem;
        position: relative;
        text-align: center;
        min-width: 220px;
      }

      .hub-duct-tape {
        position: absolute;
        top: -14px;
        right: -16px;
        background: var(--accent-lime);
        color: #000000;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        font-weight: 900;
        letter-spacing: 0.05em;
        padding: 0.2rem 0.65rem;
        border: 1.5px solid #000000;
        box-shadow: 2px 2px 0 #000000;
        transform: rotate(4deg);
        white-space: nowrap;
      }

      .hub-brand {
        font-family: 'Space Grotesk', -apple-system, sans-serif;
        font-size: 1.6rem;
        font-weight: 900;
        letter-spacing: -0.04em;
        line-height: 1;
        margin-bottom: 0.35rem;
      }

      .hub-sub {
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: var(--text-muted);
        font-weight: 700;
        margin-bottom: 0.65rem;
      }

      .hub-meta-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.35rem;
        border-top: 1.5px solid var(--border);
        padding-top: 0.5rem;
        font-family: 'JetBrains Mono', monospace;
        font-size: 0.65rem;
        text-align: left;
      }

      .hub-meta-item {
        display: flex;
        flex-direction: column;
      }

      .hub-meta-label {
        opacity: 0.65;
        font-size: 9px;
      }

      .hub-meta-val {
        font-weight: 800;
      }

      .hub-meta-val.is-neon {
        color: var(--outline-green, #15803d);
        text-shadow: none;
      }

      [data-theme="dark"] .hub-meta-val.is-neon {
        color: var(--accent-lime, #ccff00);
        text-shadow: 0 0 6px rgba(204, 255, 0, 0.55);
      }

      .hub-meta-val.is-running {
        color: var(--outline-green, #15803d);
        text-shadow: none;
      }

      [data-theme="dark"] .hub-meta-val.is-running {
        color: var(--success, #86efac);
        text-shadow: 0 0 6px rgba(134, 239, 172, 0.55);
      }

      .hub-barcode {
        margin-top: 0.5rem;
        display: flex;
        justify-content: center;
        gap: 2px;
        height: 12px;
        opacity: 0.85;
      }
      .bar { background: var(--border); width: 2px; height: 100%; }
      .bar.wide { width: 4px; }
      .bar.thin { width: 1px; }

      .satellite-card {
        position: absolute;
        z-index: 8;
        transform: translate(-50%, -50%) rotate(var(--angle-tilt, 0deg));
        background: var(--surface);
        border: var(--bw) solid var(--border);
        box-shadow: var(--hard-sm);
        padding: 0.65rem 0.9rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
        min-width: 175px;
        max-width: 190px;
        cursor: default;
        --sat-scale: 1;
        --sat-accent: #ccff00;
        --glow-color: rgba(204, 255, 0, 0.45);
        transform: translate(-50%, -50%) rotate(var(--angle-tilt, 0deg)) scale(var(--sat-scale));
      }

      /* Active Route: Dynamic per-provider cyber accent & aura */
      .satellite-card.is-active {
        background: color-mix(in srgb, var(--sat-accent, #ccff00) 15%, var(--surface)) !important;
        color: var(--text) !important;
        border-color: var(--sat-accent, #ccff00) !important;
        transform: translate(-50%, -50%) rotate(0deg) scale(calc(var(--sat-scale, 1) * 1.04));
        z-index: 12;
        box-shadow: 5px 5px 0 var(--sat-accent, #ccff00), 0 0 24px var(--glow-color, rgba(204, 255, 0, 0.45)) !important;
        animation: topo-node-breathe 1.1s ease-in-out infinite;
      }
      [data-theme="dark"] .satellite-card.is-active {
        background: color-mix(in srgb, var(--sat-accent, #ccff00) 12%, var(--surface)) !important;
        color: var(--text) !important;
        border-color: var(--sat-accent, #ccff00) !important;
      }
      [data-theme="dark"] .satellite-card.is-active .pill-chip {
        background: var(--sat-accent, #ccff00) !important;
        color: #000000 !important;
        border-color: var(--sat-accent, #ccff00) !important;
      }
      .satellite-card.is-active .pill-chip {
        background: #0a0a0a !important;
        color: var(--sat-accent, #ccff00) !important;
        border-color: var(--sat-accent, #ccff00) !important;
      }
      .satellite-card.is-active .card-icon-box {
        border-color: #000000;
        background: #ffffff;
      }

      /* Last Used Route: Subtle amber border */
      .satellite-card.is-last {
        border-color: #fde047 !important;
        box-shadow: 3px 3px 0 var(--shadow-ink);
      }
      .satellite-card.is-last .pill-chip {
        border-color: #fde047;
      }

      .card-top-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        opacity: 0.85;
        font-weight: 800;
      }

      .card-mid-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 1px 0;
      }

      .card-icon-box {
        width: 22px;
        height: 22px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--surface-2);
        border: 1px solid var(--border);
        overflow: hidden;
      }

      .card-provider-img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
      }

      .card-title {
        font-family: 'Space Grotesk', -apple-system, sans-serif;
        font-size: 0.85rem;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: -0.01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .card-bottom-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 0.15rem;
        font-family: 'JetBrains Mono', monospace;
      }

      .pill-chip {
        font-size: 0.8rem;
        font-weight: 800;
        padding: 0.1rem 0.35rem;
        border: 1px solid currentColor;
        background: rgba(0,0,0,0.04);
      }

      .lat-tag {
        font-size: 0.65rem;
        font-weight: 800;
      }

      .flow-packet-halo {
        opacity: 0.34;
        pointer-events: none;
      }
      [data-theme="dark"] .flow-packet-halo {
        opacity: 0.46;
      }
      .flow-packet {
        fill: var(--accent-lime);
        stroke: #0a0a0a;
        stroke-width: 1.6px;
        stroke-linejoin: round;
      }
      .flow-packet-core {
        fill: #ffffff;
        stroke: #0a0a0a;
        stroke-width: 0.8px;
      }

      @keyframes topo-node-breathe {
        0%, 100% { filter: drop-shadow(0 0 3px var(--glow-color, rgba(204, 255, 0, 0.45))); }
        50% { filter: drop-shadow(0 0 14px var(--glow-color, rgba(204, 255, 0, 0.85))); }
      }
      @keyframes topo-router-pulse {
        0%, 100% { filter: drop-shadow(0 0 3px var(--router-glow, rgba(204, 255, 0, 0.45))); }
        50% { filter: drop-shadow(0 0 16px var(--router-glow, rgba(204, 255, 0, 0.95))); }
      }
      .topo-router.is-powering .topo-router-core {
        animation: topo-router-pulse 0.9s ease-in-out infinite;
      }
      .topo-node.is-active .topo-node-chip {
        animation: topo-node-breathe 1.1s ease-in-out infinite;
      }
    </style>
    <script>
    (function () {
      var scriptEl = document.currentScript;
      var wrap = scriptEl.parentElement.querySelector(".topology-wrap");
      if (!wrap) return;
      var stage = wrap.querySelector("#canvas-stage");
      var svgLayer = wrap.querySelector("#svg-layer");
      var hubContainer = wrap.querySelector("#hub-container");
      if (!stage || !svgLayer || !hubContainer) return;

      var data = JSON.parse(wrap.dataset.topology || '{"nodes":[]}');
      var nodes = data.nodes || [];

      var rawActive = {};
      (data.active || []).forEach(function (p) { rawActive[String(p).toLowerCase()] = true; });
      // Model yang sedang diproses per provider (provider -> [model]); diperbarui tiap polling.
      var activeModelMap = {};
      function normalizeModels(map) {
        var out = {};
        Object.keys(map || {}).forEach(function (k) {
          var list = map[k];
          if (Array.isArray(list) && list.length) out[String(k).toLowerCase()] = list.map(String);
        });
        return out;
      }
      activeModelMap = normalizeModels(data.activeModels);
      var lastProvider = String(data.last || "").toLowerCase();
      var activeSet = {};
      var firstSeen = {};
      var FE_ACTIVE_TIMEOUT_MS = 60000;
      var POLL_MS = 1000;

      function fmt(n) {
        n = Number(n || 0);
        if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
        if (n >= 1000) return (n / 1000).toFixed(1) + "K";
        return String(n);
      }
      function esc(s) {
        return String(s == null ? "" : s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
      function cleanName(raw, id) {
        var key = String(id || "").toLowerCase();
        if (key === "claude" || /claude/i.test(raw || "")) return "CLAUDE CODE";
        var s = String(raw || "");
        s = s.replace(/\s*\([^)]*\)/g, "");
        s = s.replace(/\s+Free\s+Tier/gi, "");
        s = s.replace(/\s+AI\s+Endpoints/gi, "");
        s = s.replace(/\s+Web\s+Chat/gi, "");
        return s.trim() || raw;
      }

      var PROVIDER_META = {
        claude: { label: "CLAUDE CODE", model: "claude-3-7-sonnet", lat: "92ms", tier: "Tier 1 Pro", tilt: "0.8deg", icon: "/providers/claude.png", color: "#ff6b4a" },
        codex: { label: "OPENAI CODEX", model: "o3-mini / codex", lat: "142ms", tier: "Tier 1 Pro", tilt: "-1deg", icon: "/providers/codex.png", color: "#10b981" },
        openai: { label: "OPENAI CODEX", model: "o3-mini / codex", lat: "142ms", tier: "Tier 1 Pro", tilt: "-1deg", icon: "/providers/codex.png", color: "#00f5ff" },
        gemini: { label: "GEMINI", model: "2.0-flash / exp", lat: "84ms", tier: "Tier 1 Free", tilt: "1.2deg", icon: "/providers/antigravity.png", color: "#38bdf8" },
        kiro: { label: "KIRO AI", model: "kiro-reasoning", lat: "210ms", tier: "Tier 2 Cloud", tilt: "-0.8deg", icon: "/providers/kiro.png", color: "#f43f5e" },
        xkiro: { label: "XKIRO", model: "kiro-deep", lat: "195ms", tier: "Tier 2 Cloud", tilt: "0.5deg", icon: "/providers/xkiro.png", color: "#f43f5e" },
        opencode: { label: "OPENCODE FREE", model: "agent-gate 100k", lat: "95ms", tier: "Tier 3 Free", tilt: "1.5deg", icon: "/providers/opencode.png", color: "#ccff00" },
        mimo: { label: "MIMO CODE FREE", model: "mimo-coder-7b", lat: "110ms", tier: "Tier 3 Free", tilt: "-1.5deg", icon: "/providers/commandcode.png", color: "#2dd4bf" },
        cloudflare: { label: "CLOUDFLARE", model: "workers-ai / qwen", lat: "62ms", tier: "Tier 3 Edge", tilt: "0.8deg", icon: "/providers/cline.png", color: "#06b6d4" },
        antigravity: { label: "ANTIGRAVITY", model: "local agent mesh", lat: "14ms", tier: "Local Mesh", tilt: "-1.2deg", icon: "/providers/antigravity.png", color: "#a855f7" },
        ollama: { label: "OLLAMA CLOUD", model: "deepseek-r1:14b", lat: "38ms", tier: "Tier 2 Local", tilt: "1deg", icon: "/providers/ollama.png", color: "#facc15" },
        nvidia: { label: "NVIDIA NIM", model: "llama-3.3-70b", lat: "128ms", tier: "Tier 2 Cloud", tilt: "-0.7deg", icon: "/providers/nvidia.png", color: "#76b900" },
        openrouter: { label: "OPENROUTER", model: "auto-fallback-pool", lat: "160ms", tier: "Tier 2 Fallback", tilt: "1.4deg", icon: "/providers/openrouter.png", color: "#ec4899" },
        glm: { label: "GLM CODING", model: "glm-4-flash", lat: "105ms", tier: "Tier 2 Cloud", tilt: "-0.9deg", icon: "/providers/glm.png" },
        github: { label: "GITHUB COPILOT", model: "claude-3.5-sonnet", lat: "115ms", tier: "Tier 1 Pro", tilt: "1.1deg", icon: "/providers/github.png", color: "#60a5fa" },
        cline: { label: "CLINE", model: "cline-agent", lat: "72ms", tier: "Tier 3 Edge", tilt: "-1.1deg", icon: "/providers/cline.png", color: "#06b6d4" },
        together: { label: "TOGETHER AI", model: "llama-3.3-70b", lat: "135ms", tier: "Tier 2 Cloud", tilt: "0.6deg", icon: "/providers/together.png" },
        nous: { label: "NOUS RESEARCH", model: "hermes-3-70b", lat: "145ms", tier: "Tier 2 Cloud", tilt: "-0.6deg", icon: "/providers/nous.png" },
        commandcode: { label: "COMMAND CODE", model: "command-r-plus", lat: "120ms", tier: "Tier 2 Cloud", tilt: "1.3deg", icon: "/providers/commandcode.png" },
        freebuff: { label: "FREEBUFF", model: "freebuff-fast", lat: "80ms", tier: "Tier 3 Free", tilt: "-1.3deg", icon: "/providers/freebuff.png" },
        ovhcloud: { label: "OVHCLOUD", model: "mistral-small", lat: "110ms", tier: "Tier 3 Free", tilt: "0.9deg", icon: "/providers/ovhcloud.png" },
        kilocode: { label: "KILO CODE", model: "kilo-v1", lat: "125ms", tier: "Tier 2 Cloud", tilt: "-0.5deg", icon: "/providers/kilocode.png" },
        'kilo-free': { label: "KILO FREE", model: "kilo-free-v1", lat: "98ms", tier: "Tier 3 Free", tilt: "1.0deg", icon: "/providers/kilo-free.png" },
        llm7: { label: "LLM7 FREE", model: "llm7-base", lat: "90ms", tier: "Tier 3 Free", tilt: "-1.0deg", icon: "/providers/llm7.png" },
        'deepseek-web': { label: "DEEPSEEK WEB", model: "deepseek-v3", lat: "150ms", tier: "Tier 2 Cloud", tilt: "0.7deg", icon: "/providers/deepseek-web.png" }
      };

      var TILTS = ["-1deg", "1.2deg", "-0.8deg", "1.5deg", "-1.5deg", "0.8deg", "-1.2deg", "1deg", "-0.7deg", "1.4deg"];
      var SATELLITES = [];

      if (nodes && nodes.length > 0) {
        SATELLITES = nodes.map(function (n, idx) {
          var key = String(n.id).toLowerCase();
          var meta = PROVIDER_META[key] || {};
          var label = (key === "claude" || /claude/i.test(n.name)) ? "CLAUDE CODE" : (meta.label || cleanName(n.name, key).toUpperCase());
          var model = meta.model || (n.noAuth ? "free-tier" : (n.tokens > 0 ? fmt(n.tokens) + " tok" : (n.accounts ? n.accounts + " akun" : "ready")));
          var tier = meta.tier || (n.noAuth ? "Tier 3 Free" : (n.accounts > 1 ? "Tier 1 Pro" : "Tier 2 Cloud"));
          var lat = meta.lat || (Math.max(14, (75 + (idx * 23) % 140)) + "ms");
          var tilt = meta.tilt || TILTS[idx % TILTS.length];
          var icon = n.icon || meta.icon || ("/providers/" + key + ".png");
          var ref = String(idx + 1).padStart(2, "0");
          var pool = n.noAuth ? "KEYLESS FREE"
            : (n.accounts > 1 ? n.accounts + " ACCTS POOL"
            : (n.accounts === 1 ? "1 ACCT POOL" : "DIRECT POOL"));
          return { id: key, label: label, model: model, lat: lat, tier: tier, tilt: tilt, icon: icon, ref: ref, pool: pool };
        });
      } else {
        SATELLITES = [
          { id: 'codex', label: 'OPENAI CODEX', model: 'o3-mini / codex', lat: '142ms', tier: 'Tier 1 Pro', tilt: '-1deg', icon: '/providers/codex.png', ref: '01' },
          { id: 'gemini', label: 'GEMINI', model: '2.0-flash / exp', lat: '84ms', tier: 'Tier 1 Free', tilt: '1.2deg', icon: '/providers/antigravity.png', ref: '02' },
          { id: 'kiro', label: 'KIRO AI', model: 'kiro-reasoning', lat: '210ms', tier: 'Tier 2 Cloud', tilt: '-0.8deg', icon: '/providers/kiro.png', ref: '03' },
          { id: 'opencode', label: 'OPENCODE FREE', model: 'agent-gate 100k', lat: '95ms', tier: 'Tier 3 Free', tilt: '1.5deg', icon: '/providers/opencode.png', ref: '04' },
          { id: 'mimo', label: 'MIMO CODE FREE', model: 'mimo-coder-7b', lat: '110ms', tier: 'Tier 3 Free', tilt: '-1.5deg', icon: '/providers/commandcode.png', ref: '05' },
          { id: 'claude', label: 'CLAUDE CODE', model: 'claude-3-7-sonnet', lat: '92ms', tier: 'Tier 1 Pro', tilt: '0.8deg', icon: '/providers/claude.png', ref: '06' },
          { id: 'antigravity', label: 'ANTIGRAVITY', model: 'local agent mesh', lat: '14ms', tier: 'Local Mesh', tilt: '-1.2deg', icon: '/providers/antigravity.png', ref: '07' },
          { id: 'ollama', label: 'OLLAMA CLOUD', model: 'deepseek-r1:14b', lat: '38ms', tier: 'Tier 2 Local', tilt: '1deg', icon: '/providers/ollama.png', ref: '08' },
          { id: 'nvidia', label: 'NVIDIA NIM', model: 'llama-3.3-70b', lat: '128ms', tier: 'Tier 2 Cloud', tilt: '-0.7deg', icon: '/providers/nvidia.png', ref: '09' },
          { id: 'openrouter', label: 'OPENROUTER', model: 'auto-fallback-pool', lat: '160ms', tier: 'Tier 2 Fallback', tilt: '1.4deg', icon: '/providers/openrouter.png', ref: '10' }
        ];
      }

      // Palet aksen cyber neon khas per provider/tier dengan rotasi fallback vibrant.
      var TIER_PALETTE = [
        { re: /local/i, colors: ["#a855f7", "#00f5ff", "#2dd4bf"] },
        { re: /tier\s*1/i, colors: ["#ff6b4a", "#10b981", "#38bdf8", "#60a5fa", "#facc15"] },
        { re: /tier\s*2/i, colors: ["#c084fc", "#fb923c", "#34d399", "#f43f5e", "#ec4899"] },
        { re: /tier\s*3|free|edge/i, colors: ["#ccff00", "#34d399", "#2dd4bf", "#06b6d4", "#00f5ff"] }
      ];
      var FALLBACK_COLORS = ["#c084fc", "#fb923c", "#34d399", "#f43f5e", "#00f5ff"];
      function providerSignatureColor(sat) {
        var key = String((sat && sat.id) || "").toLowerCase();
        var meta = PROVIDER_META[key] || {};
        if (meta.color) return meta.color;
        if (/claude/.test(key)) return "#ff6b4a";
        if (/codex/.test(key)) return "#10b981";
        if (/openai/.test(key)) return "#00f5ff";
        if (/gemini/.test(key)) return "#38bdf8";
        if (/kiro/.test(key)) return "#f43f5e";
        if (/antigravity/.test(key)) return "#a855f7";
        if (/opencode|^free$/.test(key)) return "#ccff00";
        if (/mimo/.test(key)) return "#2dd4bf";
        if (/nvidia/.test(key)) return "#76b900";
        if (/ollama/.test(key)) return "#facc15";
        if (/openrouter/.test(key)) return "#ec4899";
        if (/github|copilot/.test(key)) return "#60a5fa";
        if (/cline|edge|cloudflare/.test(key)) return "#06b6d4";
        return null;
      }
      function accentFor(sat, idx) {
        var sig = providerSignatureColor(sat);
        if (sig) return sig;
        var tier = String((sat && sat.tier) || "");
        var entry = null;
        for (var t = 0; t < TIER_PALETTE.length; t++) {
          if (TIER_PALETTE[t].re.test(tier)) { entry = TIER_PALETTE[t]; break; }
        }
        var colors = entry ? entry.colors : FALLBACK_COLORS;
        return colors[Math.abs(Number(idx || 0)) % colors.length];
      }

      // Pemetaan warna kontras komplementer antara dots line kabel aktif dan partikel beacon.
      var PACKET_CONTRAST_MAP = {
        "#00f5ff": "#ff7a00",
        "#38bdf8": "#ff7a00",
        "#60a5fa": "#facc15",
        "#06b6d4": "#ff7a00",
        "#2dd4bf": "#ff2a85",
        "#ccff00": "#ff2a85",
        "#10b981": "#ff2a85",
        "#76b900": "#00f5ff",
        "#34d399": "#ff2a85",
        "#ff6b4a": "#00f5ff",
        "#f43f5e": "#34d399",
        "#ec4899": "#ccff00",
        "#fb923c": "#00f5ff",
        "#a855f7": "#ccff00",
        "#c084fc": "#ccff00",
        "#facc15": "#00f5ff"
      };
      function packetColorForWire(wireColor) {
        var key = String(wireColor || "").trim().toLowerCase();
        if (PACKET_CONTRAST_MAP[key]) return PACKET_CONTRAST_MAP[key];
        var m = /^#([0-9a-f]{6})$/.exec(key);
        if (!m) return "#ff2a85";
        var n = parseInt(m[1], 16);
        var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var d = max - min;
        var h = 0;
        if (d > 0) {
          if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
          else if (max === g) h = ((b - r) / d + 2) * 60;
          else h = ((r - g) / d + 4) * 60;
        }
        if (h >= 165 && h < 255) return "#ff7a00";
        if (h >= 65 && h < 165) return "#ff2a85";
        if (h >= 255 && h < 315) return "#ccff00";
        return "#00f5ff";
      }

      var SVG_NS = "http://www.w3.org/2000/svg";
      // Tiga beacon diamond berputar (diameter 9.6-11.2px) dengan jeda bertingkat.
      var PACKETS = [
        { radius: 4.8, delay: 0 },
        { radius: 5.6, delay: 0.35 },
        { radius: 4.8, delay: 0.7 }
      ];
      function addPackets(pathData, wireColor) {
        var packetColor = packetColorForWire(wireColor);
        PACKETS.forEach(function (pk) {
          var g = document.createElementNS(SVG_NS, "g");
          g.setAttribute("class", "flow-packet-beacon");

          var halo = document.createElementNS(SVG_NS, "circle");
          halo.setAttribute("r", String(pk.radius + 3.2));
          halo.setAttribute("class", "flow-packet-halo");
          halo.style.fill = packetColor;

          var r = pk.radius;
          var diamond = document.createElementNS(SVG_NS, "polygon");
          diamond.setAttribute("points", "0," + (-r) + " " + r + ",0 0," + r + " " + (-r) + ",0");
          diamond.setAttribute("class", "flow-packet");
          diamond.style.fill = packetColor;

          var spin = document.createElementNS(SVG_NS, "animateTransform");
          spin.setAttribute("attributeName", "transform");
          spin.setAttribute("type", "rotate");
          spin.setAttribute("from", "0");
          spin.setAttribute("to", "360");
          spin.setAttribute("dur", "1.4s");
          spin.setAttribute("repeatCount", "indefinite");
          diamond.appendChild(spin);

          var core = document.createElementNS(SVG_NS, "circle");
          core.setAttribute("r", "1.8");
          core.setAttribute("class", "flow-packet-core");

          var anim = document.createElementNS(SVG_NS, "animateMotion");
          anim.setAttribute("path", pathData);
          anim.setAttribute("dur", "1.15s");
          if (pk.delay > 0) anim.setAttribute("begin", pk.delay + "s");
          anim.setAttribute("repeatCount", "indefinite");

          g.appendChild(halo);
          g.appendChild(diamond);
          g.appendChild(core);
          g.appendChild(anim);
          svgLayer.appendChild(g);
        });
      }

      // Skala kartu turun perlahan saat provider bertambah: 0.80 - 1.05.
      function scaleFor(count) {
        var raw = 1.05 - Math.max(0, count - 4) * 0.025;
        return Math.max(0.8, Math.min(1.05, raw));
      }

      function renderTopology() {
        wrap.querySelectorAll(".satellite-card").forEach(function (el) { el.remove(); });
        svgLayer.innerHTML = '<defs><filter id="topo-glow-0"><feGaussianBlur in="SourceGraphic" stdDeviation="3"/></filter></defs>';

        var width = stage.clientWidth || 1000;
        var height = stage.clientHeight || 560;
        if (width < 620) width = 620;
        var centerX = width / 2;
        var centerY = height / 2;

        hubContainer.style.left = centerX + "px";
        hubContainer.style.top = centerY + "px";

        var n = SATELLITES.length;
        if (n === 0) return;
        var scale = scaleFor(n);
        // Ukuran kartu nyata: lebar 175px, tinggi perkiraan 92px, dikali skala.
        var cardW = 175 * scale;
        var cardH = 92 * scale;
        var pad = 12;
        // Radius adaptif dari ukuran kanvas: kartu tetap di dalam stage.
        var radiusX = Math.max(0, Math.min(width * 0.42, width / 2 - cardW / 2 - pad));
        var radiusY = Math.max(0, Math.min(height * 0.40, height / 2 - cardH / 2 - pad));
        var step = 2 * Math.PI / n;

        var firstActiveAccent = null;
        var activePackets = [];

        SATELLITES.forEach(function (sat, i) {
          var angle = (i * step) - (Math.PI / 10);
          var x = centerX + radiusX * Math.cos(angle);
          var y = centerY + radiusY * Math.sin(angle);
          // Clamp agar kartu tidak keluar kanvas.
          x = Math.max(cardW / 2 + 4, Math.min(width - cardW / 2 - 4, x));
          y = Math.max(cardH / 2 + 4, Math.min(height - cardH / 2 - 4, y));

          var cpX = centerX + (x - centerX) * 0.60;
          var cpY = centerY + (y - centerY) * 0.40;
          var d = "M " + centerX + " " + centerY + " Q " + cpX + " " + cpY + " " + x + " " + y;

          var isActive = !!activeSet[sat.id];
          var isLast = !isActive && sat.id === lastProvider;
          var accent = accentFor(sat, i);
          if (isActive && !firstActiveAccent) firstActiveAccent = accent;

          if (isActive) {
            var casing = document.createElementNS(SVG_NS, "path");
            casing.setAttribute("d", d);
            casing.setAttribute("class", "connector-wire-casing");
            casing.style.setProperty("--wire-color", accent);
            svgLayer.appendChild(casing);
          }

          var wireCls = "connector-wire" + (isActive ? " active-wire" : (isLast ? " last-wire" : ""));
          var path = document.createElementNS(SVG_NS, "path");
          path.setAttribute("d", d);
          path.setAttribute("class", wireCls);
          path.setAttribute("id", "wire-" + sat.id);
          if (isActive) path.style.setProperty("--wire-color", accent);
          svgLayer.appendChild(path);

          if (isActive) activePackets.push({ d: d, accent: accent });

          var cardCls = "satellite-card topo-node" + (isActive ? " is-active" : (isLast ? " is-last" : ""));
          var card = document.createElement("div");
          card.className = cardCls;
          card.id = "sat-" + sat.id;
          card.style.left = x + "px";
          card.style.top = y + "px";
          card.style.setProperty("--angle-tilt", sat.tilt || "0deg");
          card.style.setProperty("--sat-scale", String(scale.toFixed(3)));
          card.style.setProperty("--sat-accent", accent);
          card.style.setProperty("--glow-color", accent);

          var chipText = sat.pool || "DIRECT POOL";

          card.innerHTML =
            '<div class="card-top-row">' +
              '<span class="card-ref">[REF.' + esc(sat.ref) + ']</span>' +
              '<span class="card-tier">' + esc(sat.tier) + '</span>' +
            '</div>' +
            '<div class="card-mid-row">' +
              (sat.icon
                ? '<div class="card-icon-box"><img src="' + esc(sat.icon) + '" class="card-provider-img" alt=""/></div>'
                : '') +
              '<div class="card-title">&ldquo;' + esc(sat.label.toUpperCase()) + '&rdquo;</div>' +
            '</div>' +
            '<div class="card-bottom-row">' +
              '<span class="pill-chip topo-node-chip">' + esc(chipText) + '</span>' +
              '<span class="lat-tag">' + esc(sat.lat) + '</span>' +
            '</div>';

          // Handler dipasang lewat DOM agar tidak ada kutip di dalam atribut HTML.
          var iconImg = card.querySelector(".card-provider-img");
          if (iconImg) {
            iconImg.addEventListener("error", function () {
              if (iconImg.parentElement) iconImg.parentElement.style.display = "none";
            });
          }
          stage.appendChild(card);
        });

        activePackets.forEach(function (pkt) {
          addPackets(pkt.d, pkt.accent);
        });
        if (firstActiveAccent) {
          hubContainer.style.setProperty("--router-glow", firstActiveAccent);
        } else {
          hubContainer.style.removeProperty("--router-glow");
        }
      }

      function computeActive() {
        var now = Date.now();
        var k;
        for (k in rawActive) if (!firstSeen[k]) firstSeen[k] = now;
        for (k in firstSeen) if (!rawActive[k]) delete firstSeen[k];
        activeSet = {};
        for (k in rawActive) if (now - firstSeen[k] < FE_ACTIVE_TIMEOUT_MS) activeSet[k] = true;
      }

      function apply() {
        computeActive();
        var keys = Object.keys(activeSet);
        var activeCount = keys.length;
        var powering = activeCount > 0;
        var routerCls = powering ? "hub-container topo-router is-powering" : "hub-container topo-router";
        if (hubContainer.className !== routerCls) hubContainer.className = routerCls;
        var statusEl = document.getElementById("topo-hub-status");
        if (statusEl) {
          if (powering) {
            statusEl.textContent = activeCount + " RUNNING";
            statusEl.className = "hub-meta-val is-running";
            statusEl.style.removeProperty("color");
          } else {
            statusEl.textContent = "IDLE";
            statusEl.className = "hub-meta-val";
            statusEl.style.color = "var(--text-muted)";
          }
        }
        renderTopology();
      }

      function poll() {
        fetch("/api/topology/active", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (next) {
            if (!next) return;
            rawActive = {};
            (next.active || []).forEach(function (p) { rawActive[String(p).toLowerCase()] = true; });
            activeModelMap = normalizeModels(next.models);
            lastProvider = String(next.last || "").toLowerCase();
            apply();
          })
          .catch(function () {});
      }

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", apply);
      } else {
        requestAnimationFrame(apply);
      }
      window.addEventListener("resize", renderTopology);
      var ro = null;
      if (window.ResizeObserver) {
        ro = new ResizeObserver(function () {
          renderTopology();
        });
        ro.observe(stage);
      }
      var tickTimer = setInterval(function () {
        if (document.hidden) apply();
        else poll();
      }, POLL_MS);
      var onVisible = function () { if (!document.hidden) poll(); };
      document.addEventListener("visibilitychange", onVisible);
      if (window.__zrSwapCleanups) {
        window.__zrSwapCleanups.push(function () {
          clearInterval(tickTimer);
          if (ro) ro.disconnect();
          window.removeEventListener("resize", renderTopology);
          document.removeEventListener("visibilitychange", onVisible);
        });
      }
    })();
    </script>`;
}

/** Compact token count for the Recent Requests list. */
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

/** Relative time label for a usage timestamp (ms epoch). */
function relWhen(ts) {
  const diff = Math.max(0, Date.now() - Number(ts || 0));
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

/**
 * Share of input tokens served from the upstream prompt cache. Rows recorded
 * before the cache columns existed count as zero cache.
 */
function cacheHitLabel(summary) {
  if (!summary.total_input_tokens) return "Belum ada token masukan";
  const pct = (summary.total_cache_read_tokens / summary.total_input_tokens) * 100;
  return `${pct.toFixed(1)}% dari token masukan`;
}

/**
 * Origin shown before the arrow: the model or combo the client actually asked for.
 * `fallback_from` only exists after a real failover and wins over `combo_name`,
 * because the combo recorded there is the one that ended up answering, not the
 * one the client requested.
 */
function originLabel(row) {
  return row.fallback_from || row.combo_name || "";
}

/**
 * Recent requests list beside the topology:
 * model, in/out tokens, and when the request finished.
 */
function renderRecentPanel(recent) {
  const originPart = (r) => (originLabel(r) ? `${originLabel(r)} &rarr; ` : "");

  const rows = recent
    .map(
      (r) => `
        <li class="recent-item">
          <div class="recent-line">
            <code class="recent-model">${originPart(r)}${escapeHtml(r.model)}</code>
            <span class="recent-when">${relWhen(r.timestamp)}</span>
          </div>
          <div class="recent-io">in ${fmtNum(r.input_tokens)} · out ${fmtNum(r.output_tokens)}${r.cache_read_tokens > 0 ? ` · cache ${fmtNum(r.cache_read_tokens)}` : ""}</div>
        </li>`
    )
    .join("");
  return `
    <aside class="recent-panel">
      <div class="recent-head"><span>Recent Requests</span><span class="pill" id="recent-count">${recent.length}</span></div>
      <div id="recent-body">
      ${recent.length === 0 ? `<p class="recent-empty">No requests yet</p>` : `<ul class="recent-list">${rows}</ul>`}
      </div>
    </aside>`;
}

/** Remaining percentage tone: green >70, yellow 30–70, red <30. */
function toneClass(remaining) {
  if (remaining > 70) return "q-ok";
  if (remaining >= 30) return "q-warn";
  return "q-bad";
}

function toneEmoji(remaining) {
  if (remaining > 70) return "🟢";
  if (remaining >= 30) return "🟡";
  return "🔴";
}

/** Countdown to a reset timestamp, "12m", "3h 12m", "1d 4h 5m". */
function fmtCountdown(resetTime) {
  if (!resetTime) return "";
  try {
    const diff = new Date(resetTime) - new Date();
    if (diff <= 0) return "";
    const totalMinutes = Math.ceil(diff / 60000);
    if (totalMinutes < 60) return totalMinutes + "m";
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (h < 24) return h + "h " + m + "m";
    const d = Math.floor(h / 24);
    return d + "d " + (h % 24) + "h " + m + "m";
  } catch {
    return "";
  }
}

/** Render a 14-segment physical VU meter */
function renderVuMeter(pct, isExhausted = false) {
  if (pct == null) return "";
  const TOTAL_SEGMENTS = 14;
  let activeSegments = Math.round((Math.max(0, Math.min(100, pct)) / 100) * TOTAL_SEGMENTS);
  if (activeSegments === 0 && (pct > 0 || isExhausted)) {
    activeSegments = 1;
  }
  let toneClass = "tone-ok";
  if (pct < 25 || isExhausted) {
    toneClass = "tone-bad";
  } else if (pct < 60) {
    toneClass = "tone-warn";
  }
  const segs = [];
  for (let i = 0; i < TOTAL_SEGMENTS; i++) {
    const isActive = i < activeSegments;
    segs.push(`<div class="vu-seg${isActive ? ` on ${toneClass}` : ""}"></div>`);
  }
  return `<div class="vu-meter">${segs.join("")}</div>`;
}

function fmtUsd(n) {
  return "$" + (Number(n) || 0).toFixed(2);
}

/**
 * Normalize one connection's quota object into progress rows:
 * { label, remaining (0–100|null when unlimited), used line, reset time }.
 */
function quotaRows(q) {
  if (!q) return [];
  const rows = [];
  const unit = q.unit;

  // Per-model buckets (Antigravity): one bar per model.
  if (q.quotas && typeof q.quotas === "object" && Object.keys(q.quotas).length > 0) {
    for (const [modelKey, r] of Object.entries(q.quotas)) {
      rows.push({
        label: r.displayName || modelKey,
        remaining: bucketPct(r),
        used: r.usedLabel || `${Number(r.used || 0).toLocaleString()} / ${Number(r.total || 0).toLocaleString()}`,
        reset: r.resetAt || null,
      });
    }
    if (rows.length > 0) return rows;
  }

  if (unit === "percent") {
    if (q.used_percent != null || q.remaining_percent != null) {
      const used = Number(q.used_percent) || 0;
      const rem = q.remaining_percent != null ? Number(q.remaining_percent) : Math.max(0, 100 - used);
      rows.push({ label: "Primary window", remaining: rem, used: used + "% used", reset: q.reset_time });
    }
    if (q.secondary_used_percent != null) {
      const rem = Math.max(0, 100 - Number(q.secondary_used_percent));
      rows.push({ label: "Secondary window", remaining: rem, used: Number(q.secondary_used_percent) + "% used", reset: q.secondary_reset_time });
    }
  } else if (unit === "coding_plan") {
    for (const [key, label] of [["session_quota", "PaaS 5h"], ["weekly_quota", "PaaS Mingguan"]]) {
      const part = q[key];
      if (!part) continue;
      const used = Number(part.used_percent) || 0;
      rows.push({ label, remaining: Math.max(0, 100 - used), used: used + "% used", reset: part.reset_time });
    }
    // ZCode Start-Plan: jatah harian per model dari plan_token.
    if (Array.isArray(q.plan_quota)) {
      for (const b of q.plan_quota) {
        const rem = b.remaining_percent != null ? Math.max(0, Math.min(100, Number(b.remaining_percent))) : null;
        const total = Number(b.total_units) || 0;
        const left = Number(b.remaining_units);
        const usedLine = total > 0 && Number.isFinite(left)
          ? left.toLocaleString() + " / " + total.toLocaleString() + " " + (b.unit_type || "tokens")
          : b.name || "Start-Plan";
        rows.push({ label: "Start-Plan Harian" + (b.name && b.name !== "Daily Model Quota" ? " · " + b.name : ""), remaining: rem, used: usedLine, reset: null });
      }
    }
  } else if (unit === "credits_usd") {
    if (q.limit != null) {
      const limit = Number(q.limit);
      const rem = limit > 0 ? Math.max(0, Math.min(100, (Number(q.remaining) / limit) * 100)) : 0;
      rows.push({ label: "Credits", remaining: rem, used: fmtUsd(q.usage) + " / " + fmtUsd(q.limit), reset: null });
    } else {
      rows.push({ label: "Credits", remaining: null, used: q.usage != null ? fmtUsd(q.usage) + " used" : "Unlimited", reset: null });
    }
  } else if (unit === "subscription") {
    rows.push({ label: "Plan", remaining: null, used: q.plan || "Subscription", reset: null });
  } else if (unit === "tier") {
    rows.push({
      label: "Tier",
      remaining: null,
      used: [q.tier, q.available_models_count ? q.available_models_count + " models" : ""].filter(Boolean).join(" · "),
      reset: null,
    });
  }

  if (rows.length === 0) {
    if (typeof q.remaining === "number") {
      const suffix = unit && unit !== "unknown" ? " " + unit : "";
      rows.push({ label: "Quota", remaining: null, used: q.remaining.toLocaleString() + suffix + " left", reset: q.reset_time || null });
    }
  }
  return rows;
}

/** Urutan tingkat untuk tampilan, dari paling ringan ke paling berat. */
function levelOrderOf(level) {
  const index = LEVEL_DISPLAY_ORDER.indexOf(level);
  return index === -1 ? LEVEL_DISPLAY_ORDER.length : index;
}

/** Persentase sisa dari bucket kuota, skala 0..100. */
function bucketPct(bucket) {
  if (!bucket) return null;
  const value =
    bucket.remainingPercentage != null
      ? Number(bucket.remainingPercentage)
      : Number(bucket.total) > 0
        ? (Number(bucket.remaining ?? 0) / Number(bucket.total)) * 100
        : null;
  if (value == null || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, value));
}

/** Reset time datang sebagai ISO dari parseResetTime atau epoch ms dari kolom DB. */
function resetMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Habis berarti nol sisa dan reset belum lewat, sama dengan gate routing. */
function isExhaustedNow(pct, reset) {
  return pct === 0 && Number(reset || 0) > Date.now();
}

/** Satu chip per tingkat: label tingkat plus persen atau penanda habis. */
function levelChipsHtml(perLevel, resetFor) {
  return perLevel
    .map(({ level, modelId, pct }) => {
      const off = isExhaustedNow(pct, resetFor(modelId));
      const text = pct == null ? "" : off ? "Kuota habis" : `${Math.round(pct)}%`;
      const value = text ? `<b${off ? ' class="q-bad"' : ""}>${escapeHtml(text)}</b>` : "";
      // Keluarga satu runtime tidak perlu label tingkat, cukup nilainya.
      if (!level) return value ? `<span>${value}</span>` : "";
      return `<span>${escapeHtml(level)}${value ? ` ${value}` : ""}</span>`;
    })
    .filter(Boolean)
    .join("");
}

/**
 * Antigravity kuota per keluarga, bukan per id runtime. Tingkat dibaca dari nama
 * yang sama dengan gate routing supaya chip di kartu tidak menunjuk runtime lain
 * dari yang dipilih saat request, dan persennya diambil dari bucket kuota dengan
 * inventaris sebagai cadangan.
 */
function antigravityFamilyRows(q, inventory) {
  const buckets = q?.quotas;
  if (!buckets || typeof buckets !== "object" || Object.keys(buckets).length === 0) return null;

  const catalogNames = new Map(getProviderModels(getProvider("antigravity")).map((m) => [m.id, m.name]));
  const inventoryRows = inventory ? [...inventory.values()] : [];
  const recommended = new Set(inventoryRows.filter((r) => r.recommended === 1).map((r) => r.model_id));

  // Nama dari inventaris dipakai lebih dulu karena itulah yang dibaca gate.
  const models = {};
  for (const row of inventoryRows) models[row.model_id] = { displayName: row.display_name };
  for (const [modelId, bucket] of Object.entries(buckets)) {
    if (!models[modelId]) models[modelId] = { displayName: bucket?.displayName };
  }

  const allFamilies = buildAntigravityFamilies(models);
  const familyModelIds = (entry) => [...Object.values(entry.variants), entry.unsuffixed].filter(Boolean);
  // Keluarga yang tidak punya baris Recommended maupun bucket kuota hanya menambah
  // baris tanpa informasi baru.
  const visible = [...allFamilies.entries()].filter(([, entry]) =>
    familyModelIds(entry).some((modelId) => recommended.has(modelId) || buckets[modelId])
  );
  if (visible.length === 0) return null;

  const pctFor = (modelId) => {
    if (modelId in buckets) return bucketPct(buckets[modelId]);
    const remaining = inventory?.get(modelId)?.quota_remaining;
    return remaining == null ? null : Math.max(0, Math.min(100, Number(remaining) * 100));
  };
  const resetFor = (modelId) =>
    resetMs(buckets[modelId]?.resetAt) ?? resetMs(inventory?.get(modelId)?.quota_reset_at);

  const covered = new Set();
  for (const [, entry] of visible) for (const modelId of familyModelIds(entry)) covered.add(modelId);
  const visibleFamilies = new Set(visible.map(([familyId]) => familyId));
  const usedLabels = new Set(visible.map(([familyId]) => catalogNames.get(familyId) || familyId));

  // Bucket yang tidak ikut membentuk keluarga tampil (mis. model gambar yang
  // disaring dari katalog) supaya kuotanya tidak hilang dari kartu.
  const leftovers = Object.keys(buckets)
    .filter((modelId) => {
      if (covered.has(modelId)) return false;
      // Kalah oleh benturan tingkat di keluarganya sendiri: keluarga itu sudah
      // punya baris, jadi tidak perlu baris kedua.
      const [family] = buildAntigravityFamilies({
        [modelId]: { displayName: models[modelId]?.displayName },
      }).keys();
      return !family || !visibleFamilies.has(family);
    })
    .map((modelId) => {
      const pct = pctFor(modelId);
      const reset = resetFor(modelId);
      const baseLabel = familyFromDisplayName(models[modelId]?.displayName) || modelId;
      return {
        // Label kembar menyesatkan, jadi id runtime dipakai sebagai pembeda.
        label: usedLabels.has(baseLabel) ? modelId : baseLabel,
        remaining: pct,
        levelsHtml: levelChipsHtml([{ level: null, modelId, pct }], resetFor),
        used: isExhaustedNow(pct, reset) ? "1 tingkat · Kuota habis" : "1 tingkat",
        reset,
      };
    });

  // Keluarga yang dilipat menjadi 1 baris tunggal (tanpa chip rincian varian level low/medium/high).
  const SINGLE_RUNTIME_FAMILIES = new Set([
    "gemini-3.8-flash",
    "gemini-4-argon",
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "gpt-oss-120b",
  ]);

  return visible
    .map(([familyId, entry]) => {
      // Model single-runtime: lipat semua varian jadi 1 baris tunggal.
      if (SINGLE_RUNTIME_FAMILIES.has(familyId)) {
        const allModelIds = [...Object.values(entry.variants), entry.unsuffixed, entry.tiered]
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i);
        const allPcts = allModelIds.map((id) => pctFor(id)).filter((p) => p != null);
        const pct = allPcts.length ? Math.max(...allPcts) : null;
        const reset = allModelIds.map((id) => resetFor(id)).filter(Boolean).sort()[0] ?? null;
        const off = isExhaustedNow(pct, reset);
        return {
          label: catalogNames.get(familyId) || familyId,
          remaining: pct,
          levelsHtml: levelChipsHtml([{ level: null, modelId: allModelIds[0], pct }], resetFor),
          used: off ? "1 tingkat · Kuota habis" : "1 tingkat",
          reset,
        };
      }

      const levels = Object.entries(entry.variants).sort((a, b) => levelOrderOf(a[0]) - levelOrderOf(b[0]));
      if (entry.unsuffixed && entry.unsuffixed !== entry.tiered) levels.push([null, entry.unsuffixed]);
      // Bucket -tiered yang jadi satu-satunya runtime keluarga tetap ditampilkan.
      if (levels.length === 0 && entry.unsuffixed) levels.push([null, entry.unsuffixed]);

      const perLevel = levels.map(([level, modelId]) => ({ level, modelId, pct: pctFor(modelId) }));
      const known = perLevel.filter((x) => x.pct != null);
      const offCount = perLevel.filter((x) => isExhaustedNow(x.pct, resetFor(x.modelId))).length;

      return {
        // Bar mengikuti tingkat dengan sisa terbanyak: yang ditanyakan kartu ini
        // adalah "masih bisa dipakai atau tidak".
        label: catalogNames.get(familyId) || familyId,
        remaining: known.length ? Math.max(...known.map((x) => x.pct)) : null,
        levelsHtml: levelChipsHtml(perLevel, resetFor),
        used: `${perLevel.length} tingkat${offCount ? ` · ${offCount} habis` : ""}`,
        reset: perLevel.map((x) => resetFor(x.modelId)).filter(Boolean).sort()[0] ?? null,
      };
    })
    .concat(leftovers);
}

/**
 * Limit 5 jam dan mingguan per grup model Antigravity, dibaca dari `q.pools`.
 * Ditampilkan di atas baris per keluarga karena inilah limit yang menentukan
 * apakah akun masih bisa dipakai.
 */
function antigravityPoolRows(q) {
  const pools = Array.isArray(q?.pools) ? q.pools : [];
  return pools.map((pool) => ({
    label: pool.label,
    remaining: pool.remainingPercentage,
    used: `${Math.round(100 - pool.remainingPercentage)}% terpakai`,
    reset: pool.resetAt || null,
    // Weekly Argon decides whether the model can run at all, so it never hides
    // behind "Tampilkan N baris lagi" even when the card lists many pools.
    // Stored quotas from before the `window` field existed only carry the label.
    pinned:
      /argon/i.test(String(pool.group || pool.label || "")) &&
      (pool.window === "weekly" || /mingguan|weekly/i.test(String(pool.label || ""))),
  }));
}

/** Quota card for one account. */
function renderQuotaCard(s, antigravityInventory = null, index = 0) {
  const q = s.quota;
  // Antigravity: pool 5 jam/mingguan lalu baris per keluarga; provider lain tetap memakai bucketnya.
  const rows =
    s.provider === "antigravity"
      ? [...antigravityPoolRows(q), ...(antigravityFamilyRows(q, antigravityInventory?.get(s.id) || null) || quotaRows(q))]
      : quotaRows(q);
  if (rows.length === 0) rows.push({ label: "Quota", remaining: null, used: q?.error ? String(q.error) : "No quota data yet", reset: null });
  const statusPill = s.is_exhausted
    ? `<span class="pill pill-danger">Kuota Habis</span>`
    : s.is_active === 0
      ? `<span class="pill">Disabled</span>`
      : `<span class="pill pill-success">OK</span>`;
  const initials = String(s.provider || "?").slice(0, 2).toUpperCase();
  const iconSrc = getProviderIconPath(s.provider);
  const iconHtml = iconSrc
    ? `<img src="${escapeHtml(iconSrc)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display=''" style="width:24px;height:24px;object-fit:contain;border-radius:4px;" /><span style="display:none;">${escapeHtml(initials)}</span>`
    : `<span>${escapeHtml(initials)}</span>`;
  const planPill = q?.plan || (q?.unit === "tier" && q?.tier ? q.tier : "");
  const inventory = antigravityInventory?.get(s.id) || null;
  const inventoryRows = inventory ? [...inventory.values()].filter((r) => r.recommended === 1) : [];
  const tier = inventoryRows.find((r) => r.current_tier)?.current_tier || null;
  const planPillHtml = planPill || tier
    ? `<span class="pill">${escapeHtml(planPill || tier)}</span>`
    : "";
  const MAX_VISIBLE_ROWS = 4;

  const rowHtml = (r) => {
    const unlimited = r.remaining === null || r.remaining === undefined;
    const pct = unlimited ? null : Math.round(Math.max(0, Math.min(100, r.remaining)));
    const tone = unlimited ? "" : toneClass(r.remaining);
    const countdown = fmtCountdown(r.reset);
    const parts = [r.used];
    if (!unlimited) parts.push(`${toneEmoji(r.remaining)} ${pct}%`);
    if (countdown) parts.push(`Reset ${countdown}`);
    const meta = parts.join(" · ");
    const isExhausted = s.is_exhausted || isExhaustedNow(r.remaining, r.reset);
    const vuMeterHtml = unlimited ? "" : renderVuMeter(pct, isExhausted);
    return `
        <div class="q-row">
          <div class="q-row-top">
            <span class="q-label">${escapeHtml(r.label)}</span>
            <span class="q-meta" title="${escapeHtml(meta)}">${escapeHtml(meta)}</span>
          </div>
          ${vuMeterHtml}
          ${unlimited ? "" : `<div class="q-bar" style="display:none;"><i class="${tone}" style="width: ${pct}%"></i></div>`}
          ${r.levelsHtml ? `<div class="q-levels">${r.levelsHtml}</div>` : ""}
        </div>`;
  };

  // Pinned rows are always shown in place; the rest fill the remaining slots.
  const pinned = rows.filter((r) => r.pinned);
  const rest = rows.filter((r) => !r.pinned);
  const room = Math.max(0, MAX_VISIBLE_ROWS - pinned.length);
  const visible = [...pinned, ...rest.slice(0, room)];
  const hidden = rest.slice(room);
  const body =
    visible.map(rowHtml).join("") +
    (hidden.length
      ? `<details class="q-more"><summary>Tampilkan ${hidden.length} baris lagi</summary><div class="q-rows">${hidden.map(rowHtml).join("")}</div></details>`
      : "");

  const updated = q?.updated_at ? `<span>Updated ${relWhen(q.updated_at)}</span>` : "<span>Not synced yet</span>";
  const acctRef = `ACCOUNT #${String(index + 1).padStart(2, "0")}`;
  const providerUpper = escapeHtml(String(s.provider || "GEN").toUpperCase());

  return `
    <div class="quota-card">
      <div class="hw-screw hw-screw-tl"></div>
      <div class="hw-screw hw-screw-tr"></div>
      <div class="hw-screw hw-screw-bl"></div>
      <div class="hw-screw hw-screw-br"></div>
      <div class="q-meta-bar">
        <div class="q-meta-bar-left">
          <span class="cargo-tag">[${acctRef} · ${providerUpper}]</span>
        </div>
        <div class="q-meta-bar-right">
          ${planPillHtml}
          ${statusPill}
        </div>
      </div>
      <div class="q-head">
        <div class="q-head-left">
          <div class="q-icon">${iconHtml}</div>
          <div class="q-name">
            <strong>${escapeHtml(s.name || s.provider)}</strong>
            <div class="q-name-badges">
              <span class="pill">${escapeHtml(s.provider)}</span>
            </div>
          </div>
        </div>
        <div class="mini-barcode" aria-hidden="true">
          <i></i><i class="w"></i><i></i><i class="m"></i><i></i><i class="w"></i><i></i>
        </div>
      </div>
      <div class="q-body">${body}</div>
      <div class="q-foot">
        <span class="q-updated">${updated}</span>
        <form action="/dashboard/quota/sync" method="POST" style="margin: 0;">
          <input type="hidden" name="id" value="${Number(s.id) || 0}" />
          <button type="submit" class="btn-sync-channel">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            <span>Sync</span>
          </button>
        </form>
      </div>
    </div>`;
}

  const syncedNotice =
    query.synced === "1" || query.synced === "true"
      ? `<div class="notice notice-ok"><span>${escapeHtml(t("usage.sync_success_notice", {}, currentLang))}</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
      : "";
  // Auto sync runs on a server timer; the label tells the user when it happens.
  const syncIntervalMs = getQuotaSyncIntervalMs();
  const autoSyncLabel = syncIntervalMs
    ? t("usage.auto_sync_every", { minutes: Math.round(syncIntervalMs / 60000) }, currentLang)
    : t("usage.auto_sync_off", {}, currentLang);

  const inputTokensVal = Number(stats.summary.total_input_tokens) || 0;
  const cacheReadTokensVal = Number(stats.summary.total_cache_read_tokens) || 0;
  const cacheHitPct = inputTokensVal > 0 ? (cacheReadTokensVal / inputTokensVal) * 100 : null;
  const hitBadgeHtml = cacheHitPct != null
    ? `<span class="hit-tag">${cacheHitPct.toFixed(1)}% HIT</span>`
    : `<span class="cargo-tag">NO CACHE HITS</span>`;

  // Maximum tokens for model & account sparkbars
  const maxModelTokens = Math.max(1, ...(stats.by_model || []).map((m) => Number(m.total_tokens) || 0));
  const maxAccountTokens = Math.max(1, ...(stats.by_account || []).map((a) => Number(a.total_tokens) || 0));

  const content = `
    ${syncedNotice}
    <div class="card">
      <h3>${escapeHtml(t("usage.router_topology", {}, currentLang))}</h3>
      <p class="hint">${escapeHtml(t("usage.router_topology_hint", {}, currentLang))}</p>
      <div class="topo-layout">
        <div class="topo-main">${renderTopologyPane(topology)}</div>
        ${renderRecentPanel(recent)}
        <div class="topology-legend">
          <span><i class="dot dot-router"></i>${escapeHtml(t("usage.legend_master", {}, currentLang))}</span>
          <span><i class="dot dot-active"></i>${escapeHtml(t("usage.legend_active", {}, currentLang))}</span>
          <span><i class="dot dot-last"></i>${escapeHtml(t("usage.legend_last", {}, currentLang))}</span>
          <span><i class="dot dot-idle"></i>${escapeHtml(t("usage.legend_idle", {}, currentLang))}</span>
        </div>
      </div>
    </div>

    <!-- Section 1: Usage Telemetry Strip -->
    <div class="editorial-section">
      <div class="telemetry-strip">
        <div class="telemetry-strip-header">
          <div class="telemetry-strip-header-left">
            <span class="duct-tape-tag">USAGE TELEMETRY // 30D</span>
          </div>
          <div class="mini-barcode" aria-hidden="true">
            <i class="w"></i><i></i><i class="m"></i><i></i><i class="w"></i><i></i><i class="m"></i><i class="w"></i><i></i>
          </div>
        </div>
        <div class="telemetry-grid">
          <div class="telemetry-cell">
            <div class="telemetry-cell-label">${escapeHtml(t("usage.stat_total_requests", {}, currentLang))}</div>
            <div class="telemetry-cell-value">${Number(stats.summary.total_requests || 0).toLocaleString()}</div>
            <div class="telemetry-cell-sub">${t("usage.stat_avg_duration", { duration: stats.summary.avg_duration_ms }, currentLang)}</div>
          </div>
          <div class="telemetry-cell">
            <div class="telemetry-cell-label">${escapeHtml(t("usage.stat_input_tokens", {}, currentLang))}</div>
            <div class="telemetry-cell-value">${Number(stats.summary.total_input_tokens || 0).toLocaleString()}</div>
            <div class="telemetry-cell-sub">Prompt ingress &middot; ${escapeHtml(t("usage.stat_input_sub", {}, currentLang))}</div>
          </div>
          <div class="telemetry-cell">
            <div class="telemetry-cell-label">${escapeHtml(t("usage.stat_output_tokens", {}, currentLang))}</div>
            <div class="telemetry-cell-value">${Number(stats.summary.total_output_tokens || 0).toLocaleString()}</div>
            <div class="telemetry-cell-sub">Completion egress &middot; ${escapeHtml(t("usage.stat_output_sub", {}, currentLang))}</div>
          </div>
          <div class="telemetry-cell">
            <div class="telemetry-cell-label">${escapeHtml(t("usage.stat_combined_tokens", {}, currentLang))}</div>
            <div class="telemetry-cell-value">${Number(stats.summary.total_tokens || 0).toLocaleString()}</div>
            <div class="telemetry-cell-sub">Total throughput &middot; ${escapeHtml(t("usage.stat_combined_sub", {}, currentLang))}</div>
          </div>
          <div class="telemetry-cell is-highlight">
            <div class="telemetry-cell-label">
              <span>${escapeHtml(t("usage.stat_cache_tokens", {}, currentLang))}</span>
              ${hitBadgeHtml}
            </div>
            <div class="telemetry-cell-value">${Number(stats.summary.total_cache_read_tokens || 0).toLocaleString()}</div>
            <div class="telemetry-cell-sub">${cacheHitLabel(stats.summary)}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 2: Quota Channel Modules [ACCOUNT #xx · PROVIDER] -->
    <div class="editorial-section">
      <div class="channels-section">
        <div class="channels-header">
          <div class="channels-header-left">
            <span class="duct-tape-tag">QUOTA CHANNELS</span>
            <div class="channels-title-row">
              <h3>${escapeHtml(t("usage.quotas_title", {}, currentLang))}</h3>
              <span class="cargo-tag">${autoSyncLabel}</span>
            </div>
          </div>
          <form action="/dashboard/quota/sync/all" method="POST" style="margin: 0;">
            <button type="submit" class="btn-sync-all" title="${escapeHtml(t("usage.sync_all_title", {}, currentLang))}" aria-label="${escapeHtml(t("usage.sync_all_title", {}, currentLang))}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
              <span>SYNC ALL</span>
            </button>
          </form>
        </div>
        ${
          quotas.length === 0
            ? `<div class="empty"><p class="big">${escapeHtml(t("usage.empty_quotas", {}, currentLang))}</p><p>${escapeHtml(t("usage.empty_quotas_hint", {}, currentLang))}</p></div>`
            : `<div class="quota-grid">${quotas.map((q, idx) => renderQuotaCard(q, antigravityInventory, idx)).join("")}</div>`
        }
      </div>
    </div>

    <!-- Section 3: Editorial Ledger Tables -->
    <div class="editorial-section">
      <div class="ledgers-grid">
        <div class="ledger-card">
          <div class="ledger-header">
            <div class="ledger-header-left">
              <span class="duct-tape-tag">TOKEN BY MODEL</span>
            </div>
            <span class="ledger-title">${escapeHtml(t("usage.token_by_model", {}, currentLang))}</span>
          </div>
          <div class="ledger-table-wrap">
            ${
              stats.by_model.length === 0
                ? `<div class="empty"><p class="big">${escapeHtml(t("usage.empty_usage", {}, currentLang))}</p><p>${escapeHtml(t("usage.empty_usage_hint", {}, currentLang))}</p></div>`
                : `<table class="ledger-table">
              <thead>
                <tr>
                  <th>${escapeHtml(t("usage.col_model", {}, currentLang))}</th>
                  <th class="num">${escapeHtml(t("usage.col_requests", {}, currentLang))}</th>
                  <th class="num">${escapeHtml(t("usage.col_total_tokens", {}, currentLang))}</th>
                </tr>
              </thead>
              <tbody>
                ${stats.by_model
                  .map((m) => {
                    const tokens = Number(m.total_tokens) || 0;
                    const fillPct = Math.max(2, Math.min(100, Math.round((tokens / maxModelTokens) * 100)));
                    return `
                  <tr>
                    <td><code>${escapeHtml(m.model)}</code></td>
                    <td class="num">${Number(m.count || 0).toLocaleString()}</td>
                    <td class="num">
                      <div class="ledger-tokens-cell">
                        <div class="sparkbar-track" title="${fillPct}% of top model usage"><div class="sparkbar-fill" style="width: ${fillPct}%;"></div></div>
                        <strong>${tokens.toLocaleString()}</strong>
                      </div>
                    </td>
                  </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>`
            }
          </div>
        </div>

        ${
          stats.by_account && stats.by_account.length > 0
            ? `<div class="ledger-card">
          <div class="ledger-header">
            <div class="ledger-header-left">
              <span class="duct-tape-tag">TOKEN BY ACCOUNT</span>
            </div>
            <span class="ledger-title">${escapeHtml(t("usage.token_by_account", {}, currentLang))}</span>
          </div>
          <div class="ledger-table-wrap">
            <table class="ledger-table">
              <thead>
                <tr>
                  <th>${escapeHtml(t("usage.col_account", {}, currentLang))}</th>
                  <th>${escapeHtml(t("usage.col_provider", {}, currentLang))}</th>
                  <th class="num">${escapeHtml(t("usage.col_requests", {}, currentLang))}</th>
                  <th class="num">${escapeHtml(t("usage.col_total_tokens", {}, currentLang))}</th>
                </tr>
              </thead>
              <tbody>
                ${stats.by_account
                  .map((a) => {
                    const tokens = Number(a.total_tokens) || 0;
                    const fillPct = Math.max(2, Math.min(100, Math.round((tokens / maxAccountTokens) * 100)));
                    return `
                  <tr>
                    <td><code>${escapeHtml(a.name || "direct")}</code></td>
                    <td><span class="pill">${escapeHtml(a.provider || "-")}</span></td>
                    <td class="num">${Number(a.count || 0).toLocaleString()}</td>
                    <td class="num">
                      <div class="ledger-tokens-cell">
                        <div class="sparkbar-track" title="${fillPct}% of top account usage"><div class="sparkbar-fill fill-acct" style="width: ${fillPct}%;"></div></div>
                        <strong>${tokens.toLocaleString()}</strong>
                      </div>
                    </td>
                  </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>`
            : ""
        }
      </div>
    </div>
  `;

  return renderLayout({
    title: "Usage Analytics",
    activeTab: "usage",
    content,
    port,
    lang: currentLang,
    extraScripts: `<script>
    (function () {
      var body = document.getElementById("recent-body");
      var badge = document.getElementById("recent-count");
      if (!body || !badge) return;
      var seen = {};
      body.querySelectorAll(".recent-item").forEach(function (li, i) {
        seen[li.textContent + "|" + i] = true;
      });
      function esc(s) {
        return String(s == null ? "" : s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;")
          .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      }
      function compact(n) {
        n = Number(n) || 0;
        if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
        if (n >= 1000) return (n / 1000).toFixed(1) + "K";
        return String(n);
      }
      function rel(ts) {
        var diff = Math.max(0, Date.now() - Number(ts || 0));
        var m = Math.floor(diff / 60000);
        if (m < 1) return "just now";
        if (m < 60) return m + "m ago";
        var h = Math.floor(m / 60);
        if (h < 24) return h + "h ago";
        return Math.floor(h / 24) + "d ago";
      }
      function key(r) {
        const label = r.fallback_from || r.combo_name || '';
        return [r.connection_name || '', label, r.model, r.input_tokens, r.output_tokens, r.timestamp].join("|");
      }
      function poll() {
        fetch("/api/usage/recent?limit=10", { cache: "no-store" })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (next) {
            if (!next || !Array.isArray(next.recent)) return;
            var items = next.recent;
            badge.textContent = String(items.length);
            if (items.length === 0) {
              body.innerHTML = '<p class="recent-empty">No requests yet</p>';
              return;
            }
            var html = items.map(function (r) {
              var fresh = !seen[key(r)];
              seen[key(r)] = true;
              var origin = r.fallback_from || r.combo_name ? (esc(r.fallback_from || r.combo_name) + ' \u2192 ') : '';
              return '<li class="recent-item' + (fresh ? ' recent-item-new' : '') + '">' +
                '<div class="recent-line">' +
                '<code class="recent-model">' + origin + esc(r.model) + '</code>' +
                '<span class="recent-when">' + esc(rel(r.timestamp)) + '</span>' +
                '</div>' +
                '<div class="recent-io">in ' + compact(r.input_tokens) + ' \u00b7 out ' + compact(r.output_tokens) +
                (Number(r.cache_read_tokens) > 0 ? ' \u00b7 cache ' + compact(r.cache_read_tokens) : '') + '</div>' +
                '</li>';
            }).join("");
            body.innerHTML = '<ul class="recent-list">' + html + '</ul>';
          })
          .catch(function () {});
      }
      var recentTimer = setInterval(function () { if (!document.hidden) poll(); }, 2000);
      var onRecentVisible = function () { if (!document.hidden) poll(); };
      document.addEventListener("visibilitychange", onRecentVisible);
      if (window.__zrSwapCleanups) {
        window.__zrSwapCleanups.push(function () {
          clearInterval(recentTimer);
          document.removeEventListener("visibilitychange", onRecentVisible);
        });
      }
    })();
    </script>`,
  });
}
