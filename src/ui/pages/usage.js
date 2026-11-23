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
  return {
    nodes,
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
  return `
    <div class="topology-wrap" data-topology='${dataJson}' data-logo="/logo.png">
      <svg class="topology-canvas" width="100%" role="img" aria-label="Router topology"></svg>
    </div>
    <style>
      .topology-legend { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 12px; font-size: 12px; font-weight: 700; color: var(--text-muted); }
      .topology-legend .dot { display: inline-block; width: 12px; height: 12px; border-radius: 0; margin-right: 6px; border: var(--bw) solid var(--text); vertical-align: -1px; }
      .topology-legend .dot-router { background: var(--text); }
      .topology-legend .dot-active { background: #86efac; }
      .topology-legend .dot-last { background: #fde047; }
      .topology-legend .dot-idle { background: #93c5fd; }
      .topo-node text { font-family: inherit; }

      .topo-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 300px;
        grid-template-rows: auto auto;
        column-gap: 16px;
        row-gap: 8px;
        align-items: stretch;
      }
      .topo-main { grid-column: 1; grid-row: 1; min-width: 0; display: flex; flex-direction: column; }
      .topology-wrap { flex: 1; display: flex; flex-direction: column; }
      .topology-canvas { display: block; width: 100%; flex: 1; background: var(--surface); border: var(--bw) solid var(--text); border-radius: 0; }
      .recent-panel { grid-column: 2; grid-row: 1; width: 300px; display: flex; flex-direction: column; background: var(--surface); border: var(--bw) solid var(--text); border-radius: 0; padding: 0.75rem 0.85rem; }
      .topology-legend { grid-column: 1; grid-row: 2; }
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
        .topo-main { grid-column: 1; grid-row: 1; }
        .topology-legend { grid-column: 1; grid-row: 2; }
        .recent-panel { grid-column: 1; grid-row: 3; width: 100%; }
      }
      .quota-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      @media (max-width: 760px) {
        .quota-grid { grid-template-columns: minmax(0, 1fr); }
        /* Peta topologi tetap terbaca di ponsel: kanvas dipertahankan lebarnya, wadahnya yang di-scroll. */
        .topology-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
        .topology-canvas { min-width: 620px; }
      }
      .quota-card { background: var(--surface); border: var(--bw) solid var(--line); border-radius: 0; padding: 0.75rem 0.9rem; display: flex; flex-direction: column; gap: 0.6rem; box-shadow: 3px 3px 0 var(--shadow-ink); }
      .q-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .q-icon { width: 34px; height: 34px; flex-shrink: 0; border-radius: 0; display: flex; align-items: center; justify-content: center; background: var(--logo-tile); border: var(--bw) solid var(--line); font-size: var(--text-xs); font-weight: 800; color: var(--text); }
      .q-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; flex: 1; }
      .q-name strong { font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .q-body { display: flex; flex-direction: column; gap: 0.5rem; }
      .q-row { display: flex; flex-direction: column; gap: 3px; }
      .q-row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--text-xs); }
      .q-label { font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .q-meta { font-size: var(--text-xs); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; min-width: 0; }
      .q-pct { font-size: var(--text-xs); font-weight: 600; }
      .q-pct.q-ok { color: var(--text); }
      .q-pct.q-warn { color: var(--text); }
      .q-pct.q-bad { color: var(--text); }
      .q-bar { height: 8px; border-radius: 0; background: var(--surface-2); border: var(--bw) solid var(--text); overflow: hidden; }
      .q-bar i { display: block; height: 100%; border-radius: 0; transition: width 0.3s ease; }
      .q-bar i.q-ok { background: var(--success); }
      .q-bar i.q-warn { background: var(--warning); }
      .q-bar i.q-bad { background: var(--danger); }
      .q-more { font-size: var(--text-xs); }
      .q-more summary { cursor: pointer; color: var(--text-muted); list-style: none; padding: 2px 0; }
      .q-more summary::-webkit-details-marker { display: none; }
      .q-more summary::before { content: "+ "; font-weight: 700; }
      .q-more[open] summary::before { content: "\\2212 "; }
      .q-more summary:hover { color: var(--text); }
      .q-more .q-rows { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.5rem; }
      .q-levels { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: var(--text-xs); color: var(--text-subtle); }
      .q-levels span { white-space: nowrap; }
      .q-levels b { font-weight: 600; color: var(--text-muted); }
      .q-levels b.q-bad { color: var(--text); }
      .q-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 0.5rem; border-top: 1px solid var(--border-subtle); }
      .q-updated { font-size: var(--text-xs); color: var(--text-subtle); }

      /* Deconstructivist Radial 360 & Signal Wave Animations */
      @keyframes dashFlow {
        to { stroke-dashoffset: -32; }
      }
      @keyframes topo-node-breathe {
        0%, 100% {
          filter: drop-shadow(0 0 2px var(--glow-color, #86efac));
        }
        50% {
          filter: drop-shadow(0 0 10px var(--glow-color, #86efac));
        }
      }
      @keyframes topo-router-pulse {
        0%, 100% {
          filter: drop-shadow(0 0 2px rgba(134, 239, 172, 0.4));
        }
        50% {
          filter: drop-shadow(0 0 12px rgba(134, 239, 172, 0.95));
        }
      }
      @keyframes router-led-strobe {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.2; }
      }
      @keyframes vu-pulse {
        0%, 100% { opacity: 0.35; }
        50% { opacity: 1; }
      }
      .wire-active {
        stroke-dasharray: 6 10;
        animation: dashFlow 0.6s linear infinite;
      }
      .topo-node.is-active .topo-node-chip {
        animation: topo-node-breathe 1.1s ease-in-out infinite;
      }
      .topo-node.is-active .vu-bar-active {
        animation: vu-pulse 0.7s ease-in-out infinite;
      }
      .topo-router.is-powering .topo-router-core {
        animation: topo-router-pulse 0.9s ease-in-out infinite;
      }
      .topo-router.is-powering .topo-router-strip {
        animation: router-led-strobe 0.6s steps(2) infinite;
      }
    </style>
    <script>
    (function () {
      var scriptEl = document.currentScript;
      var wrap = scriptEl.parentElement.querySelector(".topology-wrap");
      if (!wrap) return;
      var svg = wrap.querySelector("svg");
      var logo = wrap.dataset.logo || "/logo.png";
      var data = JSON.parse(wrap.dataset.topology || '{"nodes":[]}');
      var nodes = data.nodes || [];

      var rawActive = {};
      (data.active || []).forEach(function (p) { rawActive[String(p).toLowerCase()] = true; });
      var lastProvider = String(data.last || "").toLowerCase();
      var activeSet = {};
      var firstSeen = {};
      var FE_ACTIVE_TIMEOUT_MS = 60000;
      var POLL_MS = 1000;
      var refs = [];

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
      function initials(name) {
        var words = String(name || "?").split(/\s+/).filter(Boolean);
        return (words.slice(0, 2).map(function (w) { return w[0]; }).join("") || "?").toUpperCase();
      }
      function cleanName(raw) {
        var s = String(raw || "");
        s = s.replace(/\s*\([^)]*\)/g, "");
        s = s.replace(/\s+Free\s+Tier/gi, "");
        s = s.replace(/\s+AI\s+Endpoints/gi, "");
        s = s.replace(/\s+Web\s+Chat/gi, "");
        return s.trim() || raw;
      }

      // 360° Radial Hub-and-Spoke Geometry (Anti-Overlap Deconstructivist Matrix)
      var W = 1000;
      var H = 620;
      var centerX = W / 2;
      var centerY = H / 2;

      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      var NS = "http://www.w3.org/2000/svg";

      var PALETTE = ["#f472b6", "#86efac", "#93c5fd", "#fb923c", "#fde047", "#c084fc", "#67e8f9", "#fca5a5"];
      function colorFor(id, i) {
        var h = 0;
        for (var k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) >>> 0;
        return PALETTE[(h + i) % PALETTE.length];
      }

      var defs = document.createElementNS(NS, "defs");
      var tracesG = document.createElementNS(NS, "g");
      var nodesG = document.createElementNS(NS, "g");

      // Filter SVG Glow untuk compatibilitas test & active glow
      nodes.forEach(function (n, idx) {
        var filterId = "topo-glow-" + idx;
        var glowFilter = document.createElementNS(NS, "filter");
        glowFilter.setAttribute("id", filterId);
        glowFilter.innerHTML = '<feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>';
        defs.appendChild(glowFilter);
      });

      // Dot-matrix blueprint grid
      var pattern = document.createElementNS(NS, "pattern");
      pattern.setAttribute("id", "patchbay-grid");
      pattern.setAttribute("width", "24");
      pattern.setAttribute("height", "24");
      pattern.setAttribute("patternUnits", "userSpaceOnUse");
      pattern.innerHTML = '<circle cx="3" cy="3" r="1.3" fill="var(--line)" opacity="0.22"/>';
      defs.appendChild(pattern);

      svg.appendChild(defs);

      // Background rect
      var bgRect = document.createElementNS(NS, "rect");
      bgRect.setAttribute("width", W);
      bgRect.setAttribute("height", H);
      bgRect.setAttribute("fill", "url(#patchbay-grid)");
      svg.appendChild(bgRect);

      // Corner industrial registration marks (+)
      function addCropMark(x, y, label) {
        var g = document.createElementNS(NS, "g");
        g.setAttribute("transform", "translate(" + x + "," + y + ")");
        g.innerHTML =
          '<line x1="-8" y1="0" x2="8" y2="0" stroke="var(--line)" stroke-width="1.5" opacity="0.45"/>' +
          '<line x1="0" y1="-8" x2="0" y2="8" stroke="var(--line)" stroke-width="1.5" opacity="0.45"/>' +
          '<text x="12" y="4" font-size="8.5" font-family="monospace" font-weight="700" fill="var(--text-subtle)" opacity="0.6">' + esc(label) + '</text>';
        svg.appendChild(g);
      }
      addCropMark(20, 20, "00:00 [TL]");
      addCropMark(W - 75, 20, "10:00 [TR]");
      addCropMark(20, H - 20, "00:99 [BL]");
      addCropMark(W - 75, H - 20, "10:99 [BR]");

      svg.appendChild(tracesG);
      svg.appendChild(nodesG);

      // Central Zenith Gateway Hub (Master Matrix) di Titik Pusat (centerX, centerY)
      var ROUTER_W = 224;
      var ROUTER_H = 84;
      var routerX = centerX - ROUTER_W / 2;
      var routerY = centerY - ROUTER_H / 2;
      var rHW = ROUTER_W / 2;
      var rHH = ROUTER_H / 2;

      var router = document.createElementNS(NS, "g");
      router.setAttribute("class", "topo-router");
      router.innerHTML =
        '<rect x="' + (routerX + 4) + '" y="' + (routerY + 4) + '" width="' + ROUTER_W + '" height="' + ROUTER_H + '" fill="var(--shadow-ink)" rx="0"/>' +
        '<g class="topo-router-core">' +
          '<rect x="' + routerX + '" y="' + routerY + '" width="' + ROUTER_W + '" height="' + ROUTER_H + '" fill="var(--surface)" stroke="var(--text)" stroke-width="2.5" rx="0"/>' +
          '<rect class="topo-router-strip" x="' + routerX + '" y="' + routerY + '" width="6" height="' + ROUTER_H + '" fill="var(--success)"/>' +
          // Lakban Neon Lime Virtual di pojok kanan atas hub (bebas tabrakan dengan kabel node atas)
          '<g transform="translate(' + (routerX + ROUTER_W - 100) + ',' + (routerY - 9) + ') rotate(1.5)">' +
            '<rect width="96" height="18" fill="var(--accent-lime, #ccff00)" stroke="var(--text)" stroke-width="1.2" rx="0"/>' +
            '<text x="48" y="13" text-anchor="middle" font-size="8.5" font-family="monospace" font-weight="900" fill="#0a0a0a">&ldquo;CORE // 20120&rdquo;</text>' +
          '</g>' +
          // Logo & Brand
          '<image x="' + (routerX + 16) + '" y="' + (routerY + 22) + '" width="38" height="38" preserveAspectRatio="xMidYMid meet" href="' + logo + '"/>' +
          '<text x="' + (routerX + 62) + '" y="' + (routerY + 38) + '" font-size="13" font-weight="900" letter-spacing="0.04em" fill="var(--text)">&ldquo;ZENITH&rdquo;</text>' +
          '<text x="' + (routerX + 62) + '" y="' + (routerY + 54) + '" font-size="9" font-family="monospace" font-weight="700" fill="var(--text-subtle)">TRANSIT GATEWAY CORE</text>' +
          // Status Badge di Hub
          '<rect class="topo-router-badge-bg" x="' + (routerX + 62) + '" y="' + (routerY + 60) + '" width="72" height="15" fill="var(--surface-2)" stroke="var(--line)" stroke-width="1" rx="0"/>' +
          '<text class="topo-router-badge-txt" x="' + (routerX + 98) + '" y="' + (routerY + 71) + '" text-anchor="middle" font-size="8.5" font-weight="900" font-family="monospace" fill="var(--text-muted)">IDLE</text>' +
        '</g>';
      nodesG.appendChild(router);
      var routerBadgeBg = router.querySelector(".topo-router-badge-bg");
      var routerBadgeTxt = router.querySelector(".topo-router-badge-txt");

      // 360° Radial Provider Satellites
      var totalNodes = nodes.length;
      var radiusX = totalNodes <= 6 ? 335 : 375;
      var radiusY = totalNodes <= 6 ? 195 : 225;
      var CARD_W = Math.max(148, Math.min(176, 215 - totalNodes * 4));
      var CARD_H = 62;
      var cardHW = CARD_W / 2;
      var cardHH = CARD_H / 2;

      for (var i = 0; i < totalNodes; i++) {
        var n = nodes[i];
        var color = colorFor(n.id, i);
        var key = String(n.id).toLowerCase();

        // Sudut 360° radial merata dari atas berputar searah jarum jam
        var angle = (i * (2 * Math.PI / totalNodes)) - (Math.PI / 2);
        var satCenterX = centerX + radiusX * Math.cos(angle);
        var satCenterY = centerY + radiusY * Math.sin(angle);

        var cardX = Math.max(10, Math.min(W - CARD_W - 10, satCenterX - cardHW));
        var cardY = Math.max(10, Math.min(H - CARD_H - 10, satCenterY - cardHH));

        // Titik potong presisi pada perimeter Router Hub (outer border)
        var dx = satCenterX - centerX;
        var dy = satCenterY - centerY;
        var hubEdgeX, hubEdgeY;
        if (Math.abs(dx) * rHH > Math.abs(dy) * rHW) {
          hubEdgeX = dx > 0 ? (centerX + rHW) : (centerX - rHW);
          hubEdgeY = centerY + (dy / Math.abs(dx)) * rHW;
        } else {
          hubEdgeY = dy > 0 ? (centerY + rHH) : (centerY - rHH);
          hubEdgeX = centerX + (dx / Math.abs(dy)) * rHH;
        }

        // Titik potong presisi pada perimeter Card Provider (outer border)
        var cdx = centerX - satCenterX;
        var cdy = centerY - satCenterY;
        var cardEdgeX, cardEdgeY;
        if (Math.abs(cdx) * cardHH > Math.abs(cdy) * cardHW) {
          cardEdgeX = cdx > 0 ? (cardX + CARD_W) : cardX;
          cardEdgeY = cardY + cardHH + (cdy / Math.abs(cdx)) * cardHW;
          cardEdgeY = Math.max(cardY + 8, Math.min(cardY + CARD_H - 8, cardEdgeY));
        } else {
          cardEdgeY = cdy > 0 ? (cardY + CARD_H) : cardY;
          cardEdgeX = cardX + cardHW + (cdx / Math.abs(cdy)) * cardHH;
          cardEdgeX = Math.max(cardX + 8, Math.min(cardX + CARD_W - 8, cardEdgeX));
        }

        // Bezier S-Curve organic anti-overlap (9Router dynamic curve)
        var cp1x, cp1y, cp2x, cp2y;
        if (Math.abs(cardEdgeX - hubEdgeX) > Math.abs(cardEdgeY - hubEdgeY)) {
          cp1x = hubEdgeX + (cardEdgeX - hubEdgeX) * 0.45;
          cp1y = hubEdgeY;
          cp2x = hubEdgeX + (cardEdgeX - hubEdgeX) * 0.55;
          cp2y = cardEdgeY;
        } else {
          cp1x = hubEdgeX;
          cp1y = hubEdgeY + (cardEdgeY - hubEdgeY) * 0.45;
          cp2x = cardEdgeX;
          cp2y = hubEdgeY + (cardEdgeY - hubEdgeY) * 0.55;
        }

        var d = "M " + hubEdgeX + " " + hubEdgeY +
                " C " + cp1x + " " + cp1y + ", " + cp2x + " " + cp2y + ", " + cardEdgeX + " " + cardEdgeY;

        // Trace Wire Group: Shadow -> Base Cable -> Active Cable -> Traveling Packet
        var traceG = document.createElementNS(NS, "g");
        traceG.innerHTML =
          '<path class="patch-cable-shadow" d="' + d + '" stroke="var(--shadow-ink)" stroke-width="4.5" fill="none" stroke-linecap="round"/>' +
          '<path class="patch-cable-base" d="' + d + '" stroke="var(--line)" stroke-width="2" fill="none" stroke-linecap="round" stroke-dasharray="3 3"/>' +
          '<path class="patch-cable-active wire-active" d="' + d + '" stroke="' + color + '" stroke-width="3.5" fill="none" stroke-linecap="round" style="display:none;"/>' +
          '<g class="patch-cable-packet" style="display:none;">' +
            '<rect width="8" height="8" x="-4" y="-4" fill="#86efac" stroke="var(--text)" stroke-width="1.2">' +
              '<animateMotion path="' + d + '" dur="1s" repeatCount="indefinite"/>' +
            '</rect>' +
          '</g>';
        tracesG.appendChild(traceG);

        var cableBase = traceG.querySelector(".patch-cable-base");
        var cableActive = traceG.querySelector(".patch-cable-active");
        var cablePacket = traceG.querySelector(".patch-cable-packet");

        // Socket Jacks konsentris di perimeter Hub & Card (di dalam nodesG agar selalu di atas kabel)
        var routerJack = document.createElementNS(NS, "g");
        routerJack.innerHTML =
          '<circle cx="' + hubEdgeX + '" cy="' + hubEdgeY + '" r="4.5" fill="var(--text)"/>' +
          '<circle class="router-jack-ring" cx="' + hubEdgeX + '" cy="' + hubEdgeY + '" r="2.2" fill="var(--surface-3)"/>';
        nodesG.appendChild(routerJack);
        var routerJackRing = routerJack.querySelector(".router-jack-ring");

        var providerJack = document.createElementNS(NS, "g");
        providerJack.innerHTML =
          '<circle cx="' + cardEdgeX + '" cy="' + cardEdgeY + '" r="4" fill="var(--text)"/>' +
          '<circle class="provider-jack-ring" cx="' + cardEdgeX + '" cy="' + cardEdgeY + '" r="1.8" fill="var(--surface-3)"/>';
        nodesG.appendChild(providerJack);
        var providerJackRing = providerJack.querySelector(".provider-jack-ring");

        // Provider Card Node (Deconstructivist Editorial dengan perlindungan overlap)
        var g = document.createElementNS(NS, "g");
        g.setAttribute("class", "topo-node");
        g.setAttribute("transform", "translate(" + cardX + "," + cardY + ")");

        var iconClipId = "chip-icon-" + i;
        var iconClip = document.createElementNS(NS, "clipPath");
        iconClip.setAttribute("id", iconClipId);
        iconClip.innerHTML = '<rect x="8" y="16" width="20" height="20" rx="0"/>';
        defs.appendChild(iconClip);

        // Title clip path untuk mencegah teks panjang menabrak VU-meter atau border
        var titleClipId = "title-clip-" + i;
        var titleClip = document.createElementNS(NS, "clipPath");
        titleClip.setAttribute("id", titleClipId);
        titleClip.innerHTML = '<rect x="34" y="16" width="' + (CARD_W - 74) + '" height="20" rx="0"/>';
        defs.appendChild(titleClip);

        var sub = n.noAuth && !n.accounts ? "NO-AUTH" : n.accounts + " AKUN";
        var tokenStr = fmt(n.tokens) + " TKN";
        var refCode = "REF." + String(i + 1).padStart(2, "0");
        var displayName = cleanName(n.name).toUpperCase();

        g.innerHTML =
          '<rect class="topo-node-shadow" x="3" y="3" width="' + CARD_W + '" height="' + CARD_H + '" fill="var(--shadow-ink)" rx="0"/>' +
          '<g class="topo-node-chip">' +
            '<rect class="topo-chip-body" x="0" y="0" width="' + CARD_W + '" height="' + CARD_H + '" fill="var(--surface)" stroke="var(--text)" stroke-width="2" rx="0"/>' +
            '<rect x="0" y="0" width="5" height="' + CARD_H + '" fill="' + color + '"/>' +
            // Header Mikro [REF.01] & Sub Akun
            '<text x="10" y="12" font-size="8.5" font-family="monospace" font-weight="700" fill="var(--text-subtle)">[' + esc(refCode) + ']</text>' +
            '<text x="' + (CARD_W - 10) + '" y="12" text-anchor="end" font-size="8.5" font-family="monospace" font-weight="700" fill="var(--text-subtle)">' + esc(sub) + '</text>' +
            // Ikon Provider
            (n.icon
              ? '<rect x="8" y="16" width="20" height="20" fill="var(--surface-2)" stroke="var(--line)" stroke-width="1"/>' +
                '<image href="' + esc(n.icon) + '" x="8" y="16" width="20" height="20" preserveAspectRatio="xMidYMid meet" clip-path="url(#' + iconClipId + ')"/>'
              : '<rect x="8" y="16" width="20" height="20" fill="' + color + '"/>' +
                '<text x="18" y="30" text-anchor="middle" font-size="10" font-weight="900" fill="var(--text)">' + esc(initials(n.name)) + '</text>') +
            // Nama Provider bertanda kutip dengan clip-path pelindung overlap
            '<g clip-path="url(#' + titleClipId + ')">' +
              '<text class="topo-chip-title" x="34" y="30" font-size="10" font-weight="900" fill="var(--text)">&ldquo;' + esc(displayName) + '&rdquo;</text>' +
            '</g>' +
            // Analog VU-Meter 4-bar di pojok kanan atas kartu (posisi aman bebas benturan)
            '<g class="vu-meter" transform="translate(' + (CARD_W - 34) + ', 22)">' +
              '<rect class="vu-bar" x="0" y="0" width="3" height="8" fill="var(--line)" opacity="0.25"/>' +
              '<rect class="vu-bar" x="5" y="0" width="3" height="8" fill="var(--line)" opacity="0.25"/>' +
              '<rect class="vu-bar" x="10" y="0" width="3" height="8" fill="var(--line)" opacity="0.25"/>' +
              '<rect class="vu-bar" x="15" y="0" width="3" height="8" fill="var(--line)" opacity="0.25"/>' +
            '</g>' +
            // Divider Line
            '<line x1="0" y1="41" x2="' + CARD_W + '" y2="41" stroke="var(--line)" stroke-width="1"/>' +
            // Footer: Token Count + Status Badge
            '<text x="10" y="54" font-size="8.5" font-family="monospace" font-weight="bold" fill="var(--text-muted)">' + esc(tokenStr) + '</text>' +
            '<g class="topo-badge-live" style="display:none">' +
              '<rect x="' + (CARD_W - 48) + '" y="44" width="40" height="13" fill="#86efac" stroke="var(--text)" stroke-width="1.2"/>' +
              '<text x="' + (CARD_W - 28) + '" y="53.5" text-anchor="middle" font-size="8" font-family="monospace" font-weight="900" fill="var(--text)">LIVE</text>' +
            '</g>' +
            '<g class="topo-badge-last" style="display:none">' +
              '<rect x="' + (CARD_W - 48) + '" y="44" width="40" height="13" fill="#fde047" stroke="var(--text)" stroke-width="1.2"/>' +
              '<text x="' + (CARD_W - 28) + '" y="53.5" text-anchor="middle" font-size="8" font-family="monospace" font-weight="900" fill="var(--text)">LAST</text>' +
            '</g>' +
            '<g class="topo-badge-idle">' +
              '<rect x="' + (CARD_W - 48) + '" y="44" width="40" height="13" fill="var(--surface-2)" stroke="var(--line)" stroke-width="1"/>' +
              '<text x="' + (CARD_W - 28) + '" y="53.5" text-anchor="middle" font-size="8" font-family="monospace" font-weight="bold" fill="var(--text-muted)">IDLE</text>' +
            '</g>' +
          '</g>';
        nodesG.appendChild(g);

        var vuBars = g.querySelectorAll(".vu-bar");

        refs.push({
          key: key,
          color: color,
          g: g,
          chip: g.querySelector(".topo-node-chip"),
          body: g.querySelector(".topo-chip-body"),
          badgeLive: g.querySelector(".topo-badge-live"),
          badgeLast: g.querySelector(".topo-badge-last"),
          badgeIdle: g.querySelector(".topo-badge-idle"),
          cableBase: cableBase,
          cableActive: cableActive,
          cablePacket: cablePacket,
          routerJackRing: routerJackRing,
          providerJackRing: providerJackRing,
          vuBars: vuBars,
        });
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
        var activeCount = 0;
        refs.forEach(function (r) {
          var isActive = !!activeSet[r.key];
          if (isActive) activeCount++;
          var isLast = !isActive && r.key === lastProvider;
          var isIdle = !isActive && !isLast;

          var cls = isActive ? "topo-node is-active" : "topo-node";
          if (r.g.getAttribute("class") !== cls) r.g.setAttribute("class", cls);

          r.body.style.stroke = isActive ? r.color : (isLast ? "#fde047" : "var(--text)");
          r.body.setAttribute("stroke-width", isActive ? "2.5" : (isLast ? "2.5" : "2"));
          if (isActive) {
            r.chip.style.setProperty("--glow-color", r.color);
          } else {
            r.chip.style.removeProperty("--glow-color");
          }

          r.badgeLive.style.display = isActive ? "" : "none";
          r.badgeLast.style.display = isLast ? "" : "none";
          r.badgeIdle.style.display = isIdle ? "" : "none";

          r.cableActive.style.display = isActive ? "" : "none";
          if (r.cablePacket) r.cablePacket.style.display = isActive ? "" : "none";
          r.cableBase.setAttribute("stroke", isActive ? r.color : (isLast ? "#fde047" : "var(--line)"));
          r.cableBase.setAttribute("stroke-width", isActive ? "3" : (isLast ? "2.5" : "1.8"));
          r.cableBase.setAttribute("stroke-dasharray", isIdle ? "3 3" : "none");
          r.cableBase.style.filter = isActive ? "drop-shadow(0 0 6px " + r.color + ")" : "none";

          var ringColor = isActive ? r.color : (isLast ? "#fde047" : "var(--surface-3)");
          if (r.routerJackRing) r.routerJackRing.setAttribute("fill", ringColor);
          if (r.providerJackRing) r.providerJackRing.setAttribute("fill", ringColor);

          r.vuBars.forEach(function (bar, bIdx) {
            if (isActive) {
              bar.setAttribute("fill", "#86efac");
              bar.setAttribute("opacity", (0.5 + bIdx * 0.15).toFixed(2));
              bar.setAttribute("class", "vu-bar vu-bar-active");
            } else {
              bar.setAttribute("fill", "var(--line)");
              bar.setAttribute("opacity", "0.25");
              bar.setAttribute("class", "vu-bar");
            }
          });
        });

        var powering = activeCount > 0;
        var routerCls = powering ? "topo-router is-powering" : "topo-router";
        if (router.getAttribute("class") !== routerCls) router.setAttribute("class", routerCls);
        if (powering) {
          routerBadgeBg.setAttribute("fill", "#86efac");
          routerBadgeBg.setAttribute("stroke", "var(--text)");
          routerBadgeTxt.setAttribute("fill", "var(--text)");
          routerBadgeTxt.textContent = activeCount + " RUNNING";
        } else {
          routerBadgeBg.setAttribute("fill", "var(--surface-2)");
          routerBadgeBg.setAttribute("stroke", "var(--line)");
          routerBadgeTxt.setAttribute("fill", "var(--text-muted)");
          routerBadgeTxt.textContent = "IDLE";
        }
      }

      function poll() {
        fetch("/api/topology/active", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (next) {
            if (!next) return;
            rawActive = {};
            (next.active || []).forEach(function (p) { rawActive[String(p).toLowerCase()] = true; });
            lastProvider = String(next.last || "").toLowerCase();
            apply();
          })
          .catch(function () {});
      }

      apply();
      var tickTimer = setInterval(function () {
        if (document.hidden) apply();
        else poll();
      }, POLL_MS);
      var onVisible = function () { if (!document.hidden) poll(); };
      document.addEventListener("visibilitychange", onVisible);
      if (window.__zrSwapCleanups) {
        window.__zrSwapCleanups.push(function () {
          clearInterval(tickTimer);
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
function renderQuotaCard(s, antigravityInventory = null) {
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
    return `
        <div class="q-row">
          <div class="q-row-top">
            <span class="q-label">${escapeHtml(r.label)}</span>
            <span class="q-meta" title="${escapeHtml(meta)}">${escapeHtml(meta)}</span>
          </div>
          ${unlimited ? "" : `<div class="q-bar"><i class="${tone}" style="width: ${pct}%"></i></div>`}
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

  return `
    <div class="quota-card">
      <div class="q-head">
        <div class="q-icon">${iconHtml}</div>
        <div class="q-name">
          <strong>${escapeHtml(s.name || s.provider)}</strong>
          <span class="pill">${escapeHtml(s.provider)}</span>
          ${planPillHtml}
        </div>
        ${statusPill}
      </div>
      <div class="q-body">${body}</div>
      <div class="q-foot">
        <span class="q-updated">${updated}</span>
        <form action="/dashboard/quota/sync" method="POST" style="margin: 0;">
          <input type="hidden" name="id" value="${Number(s.id) || 0}" />
          <button type="submit" class="btn btn-sm">Sync</button>
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
  const quotaHeader = `
      <div class="card-head">
        <div>
          <h3>${escapeHtml(t("usage.quotas_title", {}, currentLang))}</h3>
          <p class="hint" style="margin-top: 0.25rem;">${autoSyncLabel}. ${currentLang === "en" ? "Icon button refreshes all accounts now." : "Tombol ikon menyegarkan semua akun sekarang."}</p>
        </div>
        <form action="/dashboard/quota/sync/all" method="POST" style="margin: 0;">
          <button type="submit" class="btn btn-sm btn-icon" title="${escapeHtml(t("usage.sync_all_title", {}, currentLang))}" aria-label="${escapeHtml(t("usage.sync_all_title", {}, currentLang))}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 4v4h-4"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 20v-4h4"/></svg>
          </button>
        </form>
      </div>`;
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

    <div class="grid">
      <div class="card stat">
        <div class="label">${escapeHtml(t("usage.stat_total_requests", {}, currentLang))}</div>
        <div class="value">${stats.summary.total_requests}</div>
        <div class="sub">${t("usage.stat_avg_duration", { duration: stats.summary.avg_duration_ms }, currentLang)}</div>
      </div>
      <div class="card stat">
        <div class="label">${escapeHtml(t("usage.stat_input_tokens", {}, currentLang))}</div>
        <div class="value">${stats.summary.total_input_tokens.toLocaleString()}</div>
        <div class="sub">${escapeHtml(t("usage.stat_input_sub", {}, currentLang))}</div>
      </div>
      <div class="card stat">
        <div class="label">${escapeHtml(t("usage.stat_output_tokens", {}, currentLang))}</div>
        <div class="value">${stats.summary.total_output_tokens.toLocaleString()}</div>
        <div class="sub">${escapeHtml(t("usage.stat_output_sub", {}, currentLang))}</div>
      </div>
      <div class="card stat">
        <div class="label">${escapeHtml(t("usage.stat_combined_tokens", {}, currentLang))}</div>
        <div class="value">${stats.summary.total_tokens.toLocaleString()}</div>
        <div class="sub">${escapeHtml(t("usage.stat_combined_sub", {}, currentLang))}</div>
      </div>
      <div class="card stat">
        <div class="label">${escapeHtml(t("usage.stat_cache_tokens", {}, currentLang))}</div>
        <div class="value">${stats.summary.total_cache_read_tokens.toLocaleString()}</div>
        <div class="sub">${cacheHitLabel(stats.summary)}</div>
      </div>
    </div>

    <div class="card">
      ${quotaHeader}
      ${
        quotas.length === 0
          ? `<div class="empty"><p class="big">${escapeHtml(t("usage.empty_quotas", {}, currentLang))}</p><p>${escapeHtml(t("usage.empty_quotas_hint", {}, currentLang))}</p></div>`
          : `<div class="quota-grid">${quotas.map((q) => renderQuotaCard(q, antigravityInventory)).join("")}</div>`
      }
    </div>

    <div class="card">
      <h3>${escapeHtml(t("usage.token_by_model", {}, currentLang))}</h3>
      ${
        stats.by_model.length === 0
          ? `<div class="empty"><p class="big">${escapeHtml(t("usage.empty_usage", {}, currentLang))}</p><p>${escapeHtml(t("usage.empty_usage_hint", {}, currentLang))}</p></div>`
          : `<table>
        <thead>
          <tr><th>${escapeHtml(t("usage.col_model", {}, currentLang))}</th><th>${escapeHtml(t("usage.col_requests", {}, currentLang))}</th><th>${escapeHtml(t("usage.col_total_tokens", {}, currentLang))}</th></tr>
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

    ${
      stats.by_account && stats.by_account.length > 0
        ? `<div class="card">
      <h3>${escapeHtml(t("usage.token_by_account", {}, currentLang))}</h3>
      <table>
        <thead>
          <tr><th>${escapeHtml(t("usage.col_account", {}, currentLang))}</th><th>${escapeHtml(t("usage.col_provider", {}, currentLang))}</th><th>${escapeHtml(t("usage.col_requests", {}, currentLang))}</th><th>${escapeHtml(t("usage.col_total_tokens", {}, currentLang))}</th></tr>
        </thead>
        <tbody>
          ${stats.by_account
            .map(
              (a) => `
            <tr>
              <td><code>${escapeHtml(a.name || "direct")}</code></td>
              <td><span class="pill">${escapeHtml(a.provider || "-")}</span></td>
              <td>${a.count}</td>
              <td><strong>${a.total_tokens.toLocaleString()}</strong></td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>`
        : ""
    }
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
