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

/**
 * Render Usage Analytics and Quota page
 */
export function renderUsagePage(port = 20120, query = {}) {
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
 * Router-centered topology pane: router core in
 * the middle, provider cards on an ellipse, electric particle edges for
 * in-flight providers, orange for last used, dim for idle.
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
      @media (max-width: 760px) { .quota-grid { grid-template-columns: minmax(0, 1fr); } }
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

      /* Neobrutalist Eurorack Patchbay & Voltage Step Pulse Animations (Opsi 2) */
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
      @keyframes pcb-pulse-dash {
        to { stroke-dashoffset: -28; }
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
        var words = String(name || "?").split(/\\s+/).filter(Boolean);
        return (words.slice(0, 2).map(function (w) { return w[0]; }).join("") || "?").toUpperCase();
      }

      // Distribusi nodes: Authenticated (Cluster Atas) vs Keyless/Local (Cluster Bawah)
      var authedNodes = [];
      var keylessNodes = [];
      nodes.forEach(function (n) {
        if (n.noAuth || !n.accounts) keylessNodes.push(n);
        else authedNodes.push(n);
      });
      if (authedNodes.length === 0 && keylessNodes.length > 0) {
        var half = Math.ceil(keylessNodes.length / 2);
        authedNodes = keylessNodes.slice(0, half);
        keylessNodes = keylessNodes.slice(half);
      } else if (keylessNodes.length === 0 && authedNodes.length > 2) {
        var split = Math.ceil(authedNodes.length / 2);
        keylessNodes = authedNodes.slice(split);
        authedNodes = authedNodes.slice(0, split);
      }

      // Geometri Eurorack Modular Patchbay
      var MAX_PER_ROW = 4;
      var CARD_W = 208, CARD_H = 78, CARD_GAP_X = 16, CARD_GAP_Y = 16;
      var CLUSTER_PAD_X = 20, CLUSTER_PAD_Y = 18, CLUSTER_HEAD_H = 34;

      function chunkIntoRows(list, max) {
        var rows = [];
        for (var i = 0; i < list.length; i += max) {
          rows.push(list.slice(i, i + max));
        }
        return rows.length ? rows : [[]];
      }

      var authedRows = chunkIntoRows(authedNodes, MAX_PER_ROW);
      var keylessRows = chunkIntoRows(keylessNodes, MAX_PER_ROW);

      var maxRowCards = 1;
      authedRows.concat(keylessRows).forEach(function (r) {
        if (r.length > maxRowCards) maxRowCards = r.length;
      });
      maxRowCards = Math.max(maxRowCards, 2);

      var clusterInnerW = maxRowCards * CARD_W + (maxRowCards - 1) * CARD_GAP_X;
      var clusterBoxW = clusterInnerW + CLUSTER_PAD_X * 2;

      var ROUTER_W = Math.min(clusterBoxW, Math.max(420, clusterBoxW * 0.75));
      var ROUTER_H = 84;

      var W = Math.max(960, clusterBoxW + 64);
      var clusterX = (W - clusterBoxW) / 2;
      var routerX = (W - ROUTER_W) / 2;

      var authedInnerH = authedRows.length * CARD_H + (authedRows.length - 1) * CARD_GAP_Y;
      var authedClusterH = CLUSTER_HEAD_H + CLUSTER_PAD_Y + authedInnerH + CLUSTER_PAD_Y;

      var keylessInnerH = keylessRows.length * CARD_H + (keylessRows.length - 1) * CARD_GAP_Y;
      var keylessClusterH = CLUSTER_HEAD_H + CLUSTER_PAD_Y + keylessInnerH + CLUSTER_PAD_Y;

      var PADDING_Y = 32;
      var WIRE_ZONE_H = 68; // Zona bebas lengkungan kabel patch

      var Y_AUTHED_CLUSTER = PADDING_Y;
      var Y_ROUTER = Y_AUTHED_CLUSTER + authedClusterH + WIRE_ZONE_H;
      var Y_KEYLESS_CLUSTER = Y_ROUTER + ROUTER_H + WIRE_ZONE_H;
      var H = Y_KEYLESS_CLUSTER + keylessClusterH + PADDING_Y;

      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      var NS = "http://www.w3.org/2000/svg";

      // Palet warna Neo-brutalism kontras tinggi (sesuai preview HTML)
      var PALETTE = ["#f472b6", "#86efac", "#93c5fd", "#fb923c", "#fde047", "#c084fc", "#67e8f9", "#fca5a5"];
      function colorFor(id, i) {
        var h = 0;
        for (var k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) >>> 0;
        return PALETTE[(h + i) % PALETTE.length];
      }

      var defs = document.createElementNS(NS, "defs");
      var tracesG = document.createElementNS(NS, "g");
      var nodesG = document.createElementNS(NS, "g");

      // Filter SVG Glow untuk kompatibilitas test & visual neo-glow
      nodes.forEach(function (n, idx) {
        var filterId = "topo-glow-" + idx;
        var glowFilter = document.createElementNS(NS, "filter");
        glowFilter.setAttribute("id", filterId);
        glowFilter.innerHTML = '<feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>';
        defs.appendChild(glowFilter);
      });

      // Dot-matrix grid background modular studio
      var pattern = document.createElementNS(NS, "pattern");
      pattern.setAttribute("id", "patchbay-grid");
      pattern.setAttribute("width", "20");
      pattern.setAttribute("height", "20");
      pattern.setAttribute("patternUnits", "userSpaceOnUse");
      pattern.innerHTML = '<circle cx="2" cy="2" r="1.3" fill="var(--line)" opacity="0.22"/>';
      defs.appendChild(pattern);

      svg.appendChild(defs);
      var bgRect = document.createElementNS(NS, "rect");
      bgRect.setAttribute("width", W);
      bgRect.setAttribute("height", H);
      bgRect.setAttribute("fill", "url(#patchbay-grid)");
      svg.appendChild(bgRect);

      svg.appendChild(tracesG);
      svg.appendChild(nodesG);

      // Render Rack Enclosure Cluster Box (Modular Rack dengan sekrup di 4 sudut)
      function renderRackCluster(x, y, w, h, title, sub) {
        var g = document.createElementNS(NS, "g");
        g.innerHTML =
          '<rect x="' + (x + 4) + '" y="' + (y + 4) + '" width="' + w + '" height="' + h + '" fill="var(--text)" rx="0"/>' +
          '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="var(--surface)" stroke="var(--text)" stroke-width="2.5" rx="0"/>' +
          '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + CLUSTER_HEAD_H + '" fill="var(--surface-2)" stroke="var(--text)" stroke-width="2" rx="0"/>' +
          '<rect x="' + (x + 10) + '" y="' + (y + 8) + '" width="8" height="18" fill="var(--line)"/>' +
          '<text x="' + (x + 26) + '" y="' + (y + 21) + '" font-size="11" font-weight="900" letter-spacing="0.08em" fill="var(--text)">' + esc(title) + '</text>' +
          '<text x="' + (x + w - 36) + '" y="' + (y + 21) + '" text-anchor="end" font-size="9.5" font-family="monospace" font-weight="bold" fill="var(--text-subtle)">' + esc(sub) + '</text>' +
          // 4 Sekrup Rack Modular [+]
          '<circle cx="' + (x + 12) + '" cy="' + (y + 12) + '" r="3" fill="var(--text)"/>' +
          '<circle cx="' + (x + w - 12) + '" cy="' + (y + 12) + '" r="3" fill="var(--text)"/>' +
          '<circle cx="' + (x + 12) + '" cy="' + (y + h - 12) + '" r="3" fill="var(--text)"/>' +
          '<circle cx="' + (x + w - 12) + '" cy="' + (y + h - 12) + '" r="3" fill="var(--text)"/>';
        return g;
      }

      nodesG.appendChild(renderRackCluster(clusterX, Y_AUTHED_CLUSTER, clusterBoxW, authedClusterH, "AUTHENTICATED PROVIDERS", "[CREDENTIALS POOL]"));
      nodesG.appendChild(renderRackCluster(clusterX, Y_KEYLESS_CLUSTER, clusterBoxW, keylessClusterH, "KEYLESS & LOCAL BRIDGES", "[KEYLESS & IPC]"));

      // Render Zenith Router Core (Master Patch Matrix) di Tengah
      var router = document.createElementNS(NS, "g");
      router.setAttribute("class", "topo-router");
      router.innerHTML =
        '<rect x="' + (routerX + 4) + '" y="' + (Y_ROUTER + 4) + '" width="' + ROUTER_W + '" height="' + ROUTER_H + '" fill="var(--text)" rx="0"/>' +
        '<g class="topo-router-core">' +
          '<rect x="' + routerX + '" y="' + Y_ROUTER + '" width="' + ROUTER_W + '" height="' + ROUTER_H + '" fill="var(--surface)" stroke="var(--text)" stroke-width="3" rx="0"/>' +
          '<rect class="topo-router-strip" x="' + routerX + '" y="' + Y_ROUTER + '" width="8" height="' + ROUTER_H + '" fill="var(--success)"/>' +
          '<image x="' + (routerX + 22) + '" y="' + (Y_ROUTER + 22) + '" width="40" height="40" preserveAspectRatio="xMidYMid meet" href="' + logo + '"/>' +
          '<text x="' + (routerX + 74) + '" y="' + (Y_ROUTER + 36) + '" font-size="13" font-weight="900" letter-spacing="0.04em" fill="var(--text)">ZENITH ROUTER &middot; MASTER MATRIX</text>' +
          '<text x="' + (routerX + 74) + '" y="' + (Y_ROUTER + 56) + '" font-size="10.5" font-family="monospace" font-weight="700" fill="var(--text-subtle)">HOST: 127.0.0.1:20128 &middot; CV DISPATCH</text>' +
          '<rect class="topo-router-badge-bg" x="' + (routerX + ROUTER_W - 116) + '" y="' + (Y_ROUTER + 28) + '" width="96" height="26" fill="var(--text)" rx="0"/>' +
          '<text class="topo-router-badge-txt" x="' + (routerX + ROUTER_W - 68) + '" y="' + (Y_ROUTER + 45) + '" text-anchor="middle" font-size="10.5" font-weight="900" font-family="monospace" fill="var(--surface)">IDLE</text>' +
        '</g>';
      nodesG.appendChild(router);
      var routerBadgeBg = router.querySelector(".topo-router-badge-bg");
      var routerBadgeTxt = router.querySelector(".topo-router-badge-txt");

      // Layout Kartu Provider & Catenary Patch Cables (Neon Pulse Signal Wave)
      var currentGlobal = 0;

      function layoutCluster(rows, clusterY, isTopCluster) {
        var startCardY = clusterY + CLUSTER_HEAD_H + CLUSTER_PAD_Y;

        rows.forEach(function (rowList, rIdx) {
          if (!rowList || rowList.length === 0) return;
          var rowCount = rowList.length;
          var rowContentW = rowCount * CARD_W + (rowCount - 1) * CARD_GAP_X;
          var rowStartX = clusterX + (clusterBoxW - rowContentW) / 2;
          var yCard = startCardY + rIdx * (CARD_H + CARD_GAP_Y);

          rowList.forEach(function (n, cIdx) {
            var i = currentGlobal++;
            var xCard = rowStartX + cIdx * (CARD_W + CARD_GAP_X);
            var color = colorFor(n.id, i);
            var key = String(n.id).toLowerCase();

            // Titik Soket Jack Input di Kartu Provider
            var cardPinX = xCard + CARD_W - 24;
            var cardPinY = isTopCluster ? (yCard + CARD_H) : yCard;

            // Titik Soket Jack Output di Zenith Master Matrix
            var totalInCluster = isTopCluster ? authedNodes.length : keylessNodes.length;
            var clusterIdx = isTopCluster ? i : (i - authedNodes.length);
            var pinSpan = ROUTER_W - 88;
            var routerPinX = routerX + 44 + (totalInCluster <= 1 ? (pinSpan / 2) : (clusterIdx * (pinSpan / (totalInCluster - 1))));
            var routerPinY = isTopCluster ? Y_ROUTER : (Y_ROUTER + ROUTER_H);

            // Catenary Curve Bezier (Lengkungan fisik kabel audio anti-overlap)
            var dx = cardPinX - routerPinX;
            var sag = 28 + rIdx * 42 + Math.abs(dx) * 0.08;
            var c1x = routerPinX + dx * 0.25;
            var c1y = isTopCluster ? (routerPinY - sag) : (routerPinY + sag);
            var c2x = routerPinX + dx * 0.75;
            var c2y = isTopCluster ? (cardPinY + 22) : (cardPinY - 22);

            var d = "M " + routerPinX + " " + routerPinY +
                    " C " + c1x + " " + c1y + ", " + c2x + " " + c2y + ", " + cardPinX + " " + cardPinY;

            // 3-Layer Patch Cable: Shadow (8px) -> Neon Color (4.5px) -> Traveling Signal Wave (2px)
            var traceG = document.createElementNS(NS, "g");
            traceG.innerHTML =
              '<path class="patch-cable-shadow" d="' + d + '" stroke="var(--text)" stroke-width="8" fill="none" stroke-linecap="round"/>' +
              '<path class="patch-cable-base" d="' + d + '" stroke="' + color + '" stroke-width="4.5" fill="none" stroke-linecap="round"/>' +
              '<path class="patch-cable-active wire-active" d="' + d + '" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round" style="display:none;"/>' +
              // Soket Jack Konsentris di Router Core [■/●]
              '<g class="router-jack" transform="translate(' + routerPinX + ',' + routerPinY + ')">' +
                '<circle r="7.5" fill="var(--text)"/>' +
                '<circle r="5" fill="var(--surface)" stroke="var(--text)" stroke-width="1.2"/>' +
                '<circle class="router-jack-ring" r="3" fill="' + color + '"/>' +
              '</g>';
            tracesG.appendChild(traceG);

            var cableBase = traceG.querySelector(".patch-cable-base");
            var cableActive = traceG.querySelector(".patch-cable-active");
            var routerJackRing = traceG.querySelector(".router-jack-ring");

            // Kartu Provider Node (Neobrutalism Modular Rack)
            var g = document.createElementNS(NS, "g");
            g.setAttribute("class", "topo-node");
            g.setAttribute("transform", "translate(" + xCard + "," + yCard + ")");

            var iconClipId = "chip-icon-" + i;
            var iconClip = document.createElementNS(NS, "clipPath");
            iconClip.setAttribute("id", iconClipId);
            iconClip.innerHTML = '<rect x="8" y="10" width="26" height="26" rx="0"/>';
            defs.appendChild(iconClip);

            var titleClipId = "title-clip-" + i;
            var titleClip = document.createElementNS(NS, "clipPath");
            titleClip.setAttribute("id", titleClipId);
            titleClip.innerHTML = '<rect x="38" y="6" width="118" height="22" rx="0"/>';
            defs.appendChild(titleClip);

            var sub = n.noAuth && !n.accounts ? "NO-AUTH READY" : n.accounts + " ACC &middot; " + fmt(n.requests) + " REQ";
            var tokenStr = fmt(n.tokens) + " TOKENS";

            g.innerHTML =
              '<rect class="topo-node-shadow" x="3" y="3" width="' + CARD_W + '" height="' + CARD_H + '" fill="var(--text)" rx="0"/>' +
              '<g class="topo-node-chip">' +
                '<rect class="topo-chip-body" x="0" y="0" width="' + CARD_W + '" height="' + CARD_H + '" fill="var(--surface)" stroke="var(--text)" stroke-width="2.5" rx="0"/>' +
                '<rect x="0" y="0" width="6" height="' + CARD_H + '" fill="' + color + '"/>' +
                // Baris 1: Ikon + Nama Provider + Analog VU-Meter
                (n.icon
                  ? '<rect x="9" y="10" width="24" height="24" fill="var(--surface-2)" stroke="var(--line)" stroke-width="1"/>' +
                    '<image href="' + esc(n.icon) + '" x="9" y="10" width="24" height="24" preserveAspectRatio="xMidYMid meet" clip-path="url(#' + iconClipId + ')"/>'
                  : '<rect x="9" y="10" width="24" height="24" fill="' + color + '"/>' +
                    '<text x="21" y="26" text-anchor="middle" font-size="11" font-weight="900" fill="var(--text)">' + esc(initials(n.name)) + '</text>') +
                '<g clip-path="url(#' + titleClipId + ')">' +
                  '<text class="topo-chip-title" x="38" y="24" font-size="11.5" font-weight="900" fill="var(--text)">' + esc(n.name) + '</text>' +
                '</g>' +
                // Analog VU-Meter 4-bar
                '<g class="vu-meter" transform="translate(158, 12)">' +
                  '<rect class="vu-bar" x="0" y="0" width="4.5" height="10" fill="var(--line)" opacity="0.25"/>' +
                  '<rect class="vu-bar" x="6.5" y="0" width="4.5" height="10" fill="var(--line)" opacity="0.25"/>' +
                  '<rect class="vu-bar" x="13" y="0" width="4.5" height="10" fill="var(--line)" opacity="0.25"/>' +
                  '<rect class="vu-bar" x="19.5" y="0" width="4.5" height="10" fill="var(--line)" opacity="0.25"/>' +
                '</g>' +
                // Baris 2: Subteks Akun & Requests
                '<text x="38" y="40" font-size="9.5" font-family="monospace" font-weight="700" fill="var(--text-subtle)">' + esc(sub) + '</text>' +
                // Divider Line Tajam
                '<line x1="0" y1="49" x2="' + CARD_W + '" y2="49" stroke="var(--line)" stroke-width="1.2"/>' +
                // Baris 3: Token Count di kiri, Badge Status di kanan
                '<text x="10" y="66" font-size="9" font-family="monospace" font-weight="bold" fill="var(--text-muted)">' + esc(tokenStr) + '</text>' +
                '<g class="topo-badge-live" style="display:none">' +
                  '<rect x="' + (CARD_W - 54) + '" y="54" width="44" height="16" fill="#86efac" stroke="var(--text)" stroke-width="1.5"/>' +
                  '<text x="' + (CARD_W - 32) + '" y="66" text-anchor="middle" font-size="8.5" font-family="monospace" font-weight="900" fill="var(--text)">LIVE</text>' +
                '</g>' +
                '<g class="topo-badge-last" style="display:none">' +
                  '<rect x="' + (CARD_W - 54) + '" y="54" width="44" height="16" fill="#fde047" stroke="var(--text)" stroke-width="1.5"/>' +
                  '<text x="' + (CARD_W - 32) + '" y="66" text-anchor="middle" font-size="8.5" font-family="monospace" font-weight="900" fill="var(--text)">LAST</text>' +
                '</g>' +
                '<g class="topo-badge-idle">' +
                  '<rect x="' + (CARD_W - 54) + '" y="54" width="44" height="16" fill="var(--surface-2)" stroke="var(--line)" stroke-width="1"/>' +
                  '<text x="' + (CARD_W - 32) + '" y="66" text-anchor="middle" font-size="8.5" font-family="monospace" font-weight="bold" fill="var(--text-muted)">IDLE</text>' +
                '</g>' +
                // Soket Jack Input di Kartu Provider
                '<g transform="translate(' + (CARD_W - 24) + ',' + (isTopCluster ? CARD_H : 0) + ')">' +
                  '<circle r="7" fill="var(--text)"/>' +
                  '<circle r="4.5" fill="var(--surface)" stroke="var(--text)" stroke-width="1"/>' +
                  '<circle class="provider-jack-ring" r="2.5" fill="' + color + '"/>' +
                '</g>' +
              '</g>';
            nodesG.appendChild(g);

            var vuBars = g.querySelectorAll(".vu-bar");
            var providerJackRing = g.querySelector(".provider-jack-ring");

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
              routerJackRing: routerJackRing,
              providerJackRing: providerJackRing,
              vuBars: vuBars,
            });
          });
        });
      }

      layoutCluster(authedRows, Y_AUTHED_CLUSTER, true);
      layoutCluster(keylessRows, Y_KEYLESS_CLUSTER, false);

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

          // Card Border & Neon Voltage Glow saat aktif (Opsi 2)
          r.body.style.stroke = isActive ? r.color : (isLast ? "#fde047" : "var(--text)");
          r.body.setAttribute("stroke-width", isActive ? "3" : (isLast ? "2.5" : "2"));
          if (isActive) {
            r.chip.style.setProperty("--glow-color", r.color);
          } else {
            r.chip.style.removeProperty("--glow-color");
          }

          r.badgeLive.style.display = isActive ? "" : "none";
          r.badgeLast.style.display = isLast ? "" : "none";
          r.badgeIdle.style.display = isIdle ? "" : "none";

          // Kabel Patch: Neon Pulse Signal Wave & Glowing
          r.cableActive.style.display = isActive ? "" : "none";
          r.cableBase.setAttribute("stroke", isActive ? r.color : (isLast ? "#fde047" : "var(--surface-3)"));
          r.cableBase.setAttribute("stroke-width", isActive ? "5" : (isLast ? "4" : "3"));
          r.cableBase.setAttribute("stroke-dasharray", isIdle ? "4 4" : "none");
          r.cableBase.style.filter = isActive ? "drop-shadow(0 0 8px " + r.color + ")" : "none";

          // Soket Jack Pins Glow
          var ringColor = isActive ? r.color : (isLast ? "#fde047" : "var(--text-subtle)");
          if (r.routerJackRing) r.routerJackRing.setAttribute("fill", ringColor);
          if (r.providerJackRing) r.providerJackRing.setAttribute("fill", ringColor);

          // Analog VU-Meter Bars Glow
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
          routerBadgeTxt.setAttribute("fill", "var(--text)");
          routerBadgeTxt.textContent = activeCount + " RUNNING";
        } else {
          routerBadgeBg.setAttribute("fill", "var(--text)");
          routerBadgeTxt.setAttribute("fill", "var(--surface)");
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
      ? `<div class="notice notice-ok"><span>Kuota semua akun tertaut berhasil disegarkan.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
      : "";
  // Auto sync runs on a server timer; the label tells the user when it happens.
  const syncIntervalMs = getQuotaSyncIntervalMs();
  const autoSyncLabel = syncIntervalMs
    ? `Auto setiap ${Math.round(syncIntervalMs / 60000)} menit`
    : "Auto sync mati (env)";
  const quotaHeader = `
      <div class="card-head">
        <div>
          <h3>Account Quotas &amp; Balance</h3>
          <p class="hint" style="margin-top: 0.25rem;">${autoSyncLabel}. Tombol ikon menyegarkan semua akun sekarang.</p>
        </div>
        <form action="/dashboard/quota/sync/all" method="POST" style="margin: 0;">
          <button type="submit" class="btn btn-sm btn-icon" title="Segarkan semua kuota sekarang" aria-label="Segarkan semua kuota sekarang">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 4v4h-4"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 20v-4h4"/></svg>
          </button>
        </form>
      </div>`;
  const content = `
    ${syncedNotice}
    <div class="card">
      <h3>Router Topology</h3>
      <p class="hint">Provider aktif terhubung langsung ke Zenith Transit Gateway melalui terminal konektor patch. Warna dan lampu indikator menandai status trafik: request berjalan (live), terakhir dipakai (last), atau idle.</p>
      <div class="topo-layout">
        <div class="topo-main">${renderTopologyPane(topology)}</div>
        ${renderRecentPanel(recent)}
        <div class="topology-legend">
          <span><i class="dot dot-router"></i>Zenith Master Matrix</span>
          <span><i class="dot dot-active"></i>Active / Live</span>
          <span><i class="dot dot-last"></i>Last Used</span>
          <span><i class="dot dot-idle"></i>Standby / Idle</span>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="card stat">
        <div class="label">Total Permintaan (30 hari)</div>
        <div class="value">${stats.summary.total_requests}</div>
        <div class="sub">Rata-rata: ${stats.summary.avg_duration_ms}ms</div>
      </div>
      <div class="card stat">
        <div class="label">Token Masukan</div>
        <div class="value">${stats.summary.total_input_tokens.toLocaleString()}</div>
        <div class="sub">Konteks prompt</div>
      </div>
      <div class="card stat">
        <div class="label">Token Keluaran</div>
        <div class="value">${stats.summary.total_output_tokens.toLocaleString()}</div>
        <div class="sub">Konten hasil</div>
      </div>
      <div class="card stat">
        <div class="label">Total Token</div>
        <div class="value">${stats.summary.total_tokens.toLocaleString()}</div>
        <div class="sub">Pemakaian gabungan</div>
      </div>
      <div class="card stat">
        <div class="label">Token dari Cache</div>
        <div class="value">${stats.summary.total_cache_read_tokens.toLocaleString()}</div>
        <div class="sub">${cacheHitLabel(stats.summary)}</div>
      </div>
    </div>

    <div class="card">
      ${quotaHeader}
      ${
        quotas.length === 0
          ? `<div class="empty"><p class="big">Belum ada data kuota</p><p>Hanya akun dengan data kuota dari provider yang ditampilkan di sini.</p></div>`
          : `<div class="quota-grid">${quotas.map((q) => renderQuotaCard(q, antigravityInventory)).join("")}</div>`
      }
    </div>

    <div class="card">
      <h3>Token Consumption by Model</h3>
      ${
        stats.by_model.length === 0
          ? `<div class="empty"><p class="big">Belum ada catatan pemakaian</p><p>Kirim request ke /v1 untuk melihat statistik.</p></div>`
          : `<table>
        <thead>
          <tr><th>Model</th><th>Permintaan</th><th>Total Token</th></tr>
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
      <h3>Token Consumption by Account</h3>
      <table>
        <thead>
          <tr><th>Akun / Koneksi</th><th>Provider</th><th>Permintaan</th><th>Total Token</th></tr>
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
