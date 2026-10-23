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
import { getLogoDataUri, getProviderIconPath } from "../assets.js";
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
  const logoUri = getLogoDataUri();
  return `
    <div class="topology-wrap" data-topology='${dataJson}' data-logo="${escapeHtml(logoUri)}">
      <svg class="topology-canvas" width="100%" role="img" aria-label="Router topology"></svg>
      <div class="topology-legend">
        <span><i class="dot dot-router"></i>Zenith Router</span>
        <span><i class="dot dot-active"></i>Request berjalan</span>
        <span><i class="dot dot-last"></i>Terakhir dipakai</span>
        <span><i class="dot dot-idle"></i>Idle</span>
      </div>
    </div>
    <style>
      .topology-wrap { position: relative; }
      .topology-canvas { display: block; background: var(--bg-subtle, #0d1117); border: 1px solid var(--border, #21262d); border-radius: 10px; }
      .topology-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-size: 12px; color: var(--text-muted, #8b949e); }
      .topology-legend .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 4px; }
      .topology-legend .dot-router { background: #e6edf3; }
      .topology-legend .dot-active { background: #22d3ee; }
      .topology-legend .dot-last { background: #f59e0b; }
      .topology-legend .dot-idle { background: #6e7681; }
      .topo-node text { font-family: inherit; }
      .topo-split { display: flex; gap: 16px; align-items: stretch; }
      .topo-main { flex: 1; min-width: 0; }
      .recent-panel { width: 300px; flex-shrink: 0; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 0.75rem 0.85rem; }
      .recent-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-subtle); padding-bottom: 0.6rem; border-bottom: 1px solid var(--border-subtle); }
      .recent-list { list-style: none; margin: 0; padding: 0.35rem 0 0; overflow-y: auto; max-height: 420px; }
      .recent-item { padding: 0.5rem 0; border-bottom: 1px solid var(--border-subtle); }
      .recent-item:last-child { border-bottom: none; }
      .recent-line { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
      .recent-model { font-size: 0.8rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .recent-when { font-size: 0.7rem; color: var(--text-subtle); flex-shrink: 0; }
      .recent-io { font-size: 0.72rem; color: var(--text-muted); margin-top: 2px; }
      .recent-empty { font-size: 0.8rem; color: var(--text-muted); padding: 1rem 0; text-align: center; }
      .recent-item-new { animation: recent-flash 1.2s ease-out; }
      @keyframes recent-flash { from { background: var(--accent-soft, #1f6feb22); } to { background: transparent; } }
      @media (max-width: 1100px) { .topo-split { flex-direction: column; } .recent-panel { width: 100%; } }
      .quota-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      @media (max-width: 760px) { .quota-grid { grid-template-columns: minmax(0, 1fr); } }
      .quota-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 0.75rem 0.9rem; display: flex; flex-direction: column; gap: 0.6rem; }
      .q-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .q-icon { width: 34px; height: 34px; flex-shrink: 0; border-radius: 8px; display: flex; align-items: center; justify-content: center; background: var(--surface-3); border: 1px solid var(--border); font-size: 0.75rem; font-weight: 700; color: var(--text-muted); }
      .q-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; flex: 1; }
      .q-name strong { font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .q-body { display: flex; flex-direction: column; gap: 0.5rem; }
      .q-row { display: flex; flex-direction: column; gap: 3px; }
      .q-row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.78rem; }
      .q-label { font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .q-meta { font-size: 0.72rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; min-width: 0; }
      .q-pct { font-size: 0.78rem; font-weight: 600; }
      .q-pct.q-ok { color: var(--success); }
      .q-pct.q-warn { color: var(--warning); }
      .q-pct.q-bad { color: var(--danger); }
      .q-bar { height: 6px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
      .q-bar i { display: block; height: 100%; border-radius: 999px; transition: width 0.3s ease; }
      .q-bar i.q-ok { background: var(--success); }
      .q-bar i.q-warn { background: var(--warning); }
      .q-bar i.q-bad { background: var(--danger); }
      .q-more { font-size: 0.72rem; }
      .q-more summary { cursor: pointer; color: var(--text-muted); list-style: none; padding: 2px 0; }
      .q-more summary::-webkit-details-marker { display: none; }
      .q-more summary::before { content: "+ "; font-weight: 700; }
      .q-more[open] summary::before { content: "\\2212 "; }
      .q-more summary:hover { color: var(--text); }
      .q-more .q-rows { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.5rem; }
      .q-levels { display: flex; flex-wrap: wrap; gap: 2px 10px; font-size: 0.7rem; color: var(--text-subtle); }
      .q-levels span { white-space: nowrap; }
      .q-levels b { font-weight: 600; color: var(--text-muted); }
      .q-levels b.q-bad { color: var(--danger); }
      .q-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 0.5rem; border-top: 1px solid var(--border-subtle); }
      .q-updated { font-size: 0.7rem; color: var(--text-subtle); }
      @keyframes topo-ping { 0% { opacity: .8; r: 4; } 80%,100% { opacity: 0; r: 10; } }
      /* Node provider yang sedang dipakai: badan kartu bernapas + transisi halus. */
      @keyframes topo-node-breathe { 0%, 100% { stroke-opacity: 1; } 50% { stroke-opacity: .4; } }
      .topo-node-rect { transition: stroke .3s ease, stroke-width .3s ease; }
      .topo-node-title { transition: fill .3s ease; }
      .topo-node.is-active .topo-node-rect { animation: topo-node-breathe 1.3s ease-in-out infinite; }
      /* Router core: berdenyut saat ada request berjalan. */
      @keyframes topo-router-pulse {
        0%, 100% { transform: scale(1); filter: drop-shadow(0 0 6px rgba(230, 237, 243, .45)); }
        50% { transform: scale(1.06); filter: drop-shadow(0 0 16px rgba(255, 255, 255, .95)); }
      }
      @keyframes topo-router-icon {
        0%, 100% { transform: rotate(0deg) scale(1); }
        25% { transform: rotate(-5deg) scale(1.08); }
        75% { transform: rotate(5deg) scale(1.08); }
      }
      @keyframes topo-router-label {
        0%, 100% { filter: drop-shadow(0 0 4px #e6edf3); }
        50% { filter: drop-shadow(0 0 9px #ffffff) drop-shadow(0 0 3px #ffffff); }
      }
      .topo-router-rect-on { transform-box: fill-box; transform-origin: center; }
      .topo-router-icon { transform-box: fill-box; transform-origin: center; }
      .topo-router.is-powering .topo-router-rect-on { animation: topo-router-pulse .75s ease-in-out infinite; }
      .topo-router.is-powering .topo-router-icon { animation: topo-router-icon .45s ease-in-out infinite; }
      .topo-router.is-powering .topo-router-label { animation: topo-router-label .7s ease-in-out infinite; }
      .topo-router-badge { filter: drop-shadow(0 0 6px #e6edf3); }
      /* Beam edge: core bergaris + halo berkedip, partikel mengalir di sepanjang path. */
      @keyframes topo-edge-dash { to { stroke-dashoffset: -36; } }
      @keyframes topo-edge-flicker { 0%, 100% { opacity: .85; } 40% { opacity: 1; } 55% { opacity: .55; } 70% { opacity: 1; } }
      .topo-edge-kame { stroke-dasharray: 8 6; animation: topo-edge-dash .22s linear infinite; }
      .topo-edge-halo { animation: topo-edge-flicker .18s steps(2) infinite; }
      .topo-edge-plasma { stroke-dasharray: 14 10; animation: topo-edge-dash .18s linear infinite, topo-edge-flicker .22s steps(3) infinite; }
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

      // Snapshot awal dari server, lalu diperbarui lewat polling /api/topology/active.
      var rawActive = {};
      (data.active || []).forEach(function (p) { rawActive[String(p).toLowerCase()] = true; });
      var lastProvider = String(data.last || "").toLowerCase();
      var activeSet = {};
      var firstSeen = {};
      // Status aktif dipaksa berhenti kalau provider terlihat jalan terlalu lama.
      var FE_ACTIVE_TIMEOUT_MS = 60000;
      var POLL_MS = 1000;
      var refs = [];

      var NW = 200, NH = 58, GAP = 28;
      var count = nodes.length;
      var minRx = ((NW + GAP) * count) / (2 * Math.PI);
      var RX = Math.max(330, minRx);
      var RY = Math.max(200, RX * 0.55);
      var CX = RX + NW / 2 + 40;
      var CY = RY + NH + 40;
      var W = CX * 2;
      var H = CY * 2;
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);

      var NS = "http://www.w3.org/2000/svg";
      var PALETTE = ["#6366f1", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#10b981", "#f97316"];
      function nodePos(i) {
        if (count === 1) return { x: CX, y: CY - RY };
        var angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
        return { x: CX + RX * Math.cos(angle), y: CY + RY * Math.sin(angle) };
      }
      function edgePath(p) {
        var mx = (CX + p.x) / 2;
        return "M" + CX + "," + CY + " C" + mx + "," + CY + " " + mx + "," + p.y + " " + p.x + "," + p.y;
      }
      function fmt(n) {
        n = Number(n || 0);
        if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
        if (n >= 1000) return (n / 1000).toFixed(1) + "K";
        return String(n);
      }
      function colorFor(id, i) {
        var h = 0;
        for (var k = 0; k < id.length; k++) h = (h * 31 + id.charCodeAt(k)) >>> 0;
        return PALETTE[(h + i) % PALETTE.length];
      }
      function initials(name) {
        var words = String(name || "?").split(/\s+/).filter(Boolean);
        return (words.slice(0, 2).map(function (w) { return w[0]; }).join("") || "?").toUpperCase();
      }
      function esc(s) {
        return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      }

      var edgesG = document.createElementNS(NS, "g");
      var nodesG = document.createElementNS(NS, "g");
      var defs = document.createElementNS(NS, "defs");
      defs.innerHTML = '<clipPath id="topo-icon-clip"><rect x="-88" y="-16" width="32" height="32" rx="7"/></clipPath>';
      svg.appendChild(defs);
      svg.appendChild(edgesG);
      svg.appendChild(nodesG);

      // Router core memakai dua rect yang ditampilkan bergantian lewat apply().
      var router = document.createElementNS(NS, "g");
      router.innerHTML =
        '<rect class="topo-router-rect-off" x="' + (CX - 80) + '" y="' + (CY - 26) + '" width="160" height="52" rx="12" fill="#161b22" stroke="#e6edf3" stroke-width="1.5"/>' +
        '<rect class="topo-router-rect-on" x="' + (CX - 84) + '" y="' + (CY - 30) + '" width="168" height="60" rx="12" fill="rgba(230,237,243,0.12)" stroke="#ffffff" stroke-width="2" style="display:none"/>' +
        '<image class="topo-router-icon" x="' + (CX - 66) + '" y="' + (CY - 12) + '" width="24" height="24" preserveAspectRatio="xMidYMid meet" href="' + logo + '"/>' +
        '<text class="topo-router-label" x="' + (CX - 34) + '" y="' + (CY + 4) + '" font-size="11" font-weight="bold" fill="#e6edf3">Zenith Router</text>' +
        '<g class="topo-router-badge" style="display:none">' +
        '<circle cx="' + (CX + 64) + '" cy="' + (CY - 14) + '" r="10" fill="#e6edf3"/>' +
        '<text class="topo-router-badge-n" x="' + (CX + 64) + '" y="' + (CY - 10) + '" text-anchor="middle" font-size="11" font-weight="bold" fill="#000">0</text>' +
        "</g>";
      nodesG.appendChild(router);
      var routerOff = router.querySelector(".topo-router-rect-off");
      var routerOn = router.querySelector(".topo-router-rect-on");
      var routerBadge = router.querySelector(".topo-router-badge");
      var routerBadgeN = router.querySelector(".topo-router-badge-n");

      nodes.forEach(function (n, i) {
        var p = nodePos(i);
        var color = colorFor(n.id, i);
        var key = String(n.id).toLowerCase();
        var path = edgePath(p);

        // Glow per node: padanan box-shadow pada kartu provider aktif.
        var filterId = "topo-glow-" + i;
        var glowFilter = document.createElementNS(NS, "filter");
        glowFilter.setAttribute("id", filterId);
        glowFilter.setAttribute("x", "-60%");
        glowFilter.setAttribute("y", "-60%");
        glowFilter.setAttribute("width", "220%");
        glowFilter.setAttribute("height", "220%");
        glowFilter.innerHTML =
          '<feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/>' +
          '<feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>';
        defs.appendChild(glowFilter);

        // Dua varian edge: beam listrik saat aktif, garis solid saat idle.
        var edges = document.createElementNS(NS, "g");
        var particles = [0, 1, 2, 3, 4].map(function (k) {
          return '<circle r="' + (k % 2 === 0 ? 3.5 : 2.2) + '" fill="' + (k % 3 === 0 ? "#e6edf3" : k % 3 === 1 ? "#67e8f9" : "#fff") + '">' +
            '<animateMotion dur="' + (0.5 + k * 0.12) + 's" repeatCount="indefinite" path="' + path + '" begin="' + (k * 0.15) + 's"/></circle>';
        }).join("");
        var sparks = [0, 1, 2, 3].map(function (k) {
          return '<circle r="1.8" fill="#e0f2fe" opacity="0">' +
            '<animate attributeName="opacity" values="0;1;0;0;1;0" dur="' + (0.35 + (k % 3) * 0.1) + 's" begin="' + (k * 0.07) + 's" repeatCount="indefinite"/>' +
            '<animateMotion dur="' + (0.28 + k * 0.05) + 's" repeatCount="indefinite" path="' + path + '" begin="' + (k * 0.11) + 's"/></circle>';
        }).join("");
        edges.innerHTML =
          '<path class="topo-edge-idle" d="' + path + '" fill="none" stroke="#30363d" stroke-width="1" opacity="0.45"/>' +
          '<g class="topo-edge-beam" style="display:none">' +
          '<path class="topo-edge-halo" d="' + path + '" fill="none" stroke="#22d3ee" stroke-width="9" stroke-opacity="0.3" stroke-linecap="round"/>' +
          '<path class="topo-edge-plasma" d="' + path + '" fill="none" stroke="#4ade80" stroke-width="4.5" stroke-opacity="0.85" stroke-linecap="round"/>' +
          '<path class="topo-edge-kame" d="' + path + '" fill="none" stroke="#f8fafc" stroke-width="1.8" stroke-linecap="round"/>' +
          particles + sparks +
          "</g>";
        edgesG.appendChild(edges);

        var g = document.createElementNS(NS, "g");
        g.setAttribute("class", "topo-node");
        g.setAttribute("transform", "translate(" + p.x.toFixed(1) + "," + p.y.toFixed(1) + ")");
        var shortName = n.name.length > 20 ? n.name.slice(0, 19) + "…" : n.name;
        var sub = n.noAuth && !n.accounts ? "no-auth · ready" : n.accounts + " akun · " + fmt(n.requests) + " req · " + fmt(n.tokens) + " tok";
        g.innerHTML =
          '<rect class="topo-node-halo" x="' + (-NW / 2) + '" y="' + (-NH / 2) + '" width="' + NW + '" height="' + NH + '" rx="10" fill="none" stroke="' + color + '" stroke-width="2" style="display:none">' +
            '<animate attributeName="opacity" values="0.7;0" dur="1.4s" repeatCount="indefinite"/>' +
            '<animateTransform attributeName="transform" type="scale" values="1;1.05" dur="1.4s" repeatCount="indefinite" additive="sum"/>' +
          "</rect>" +
          '<rect class="topo-node-rect" x="' + (-NW / 2) + '" y="' + (-NH / 2) + '" width="' + NW + '" height="' + NH + '" rx="10" fill="#161b22" stroke="#30363d" stroke-width="1"/>' +
          '<rect x="' + (-NW / 2 + 12) + '" y="-16" width="32" height="32" rx="7" fill="#0d1117" stroke="#30363d" stroke-width="1"/>' +
          (n.icon
            ? '<image href="' + esc(n.icon) + '" x="' + (-NW / 2 + 12) + '" y="-16" width="32" height="32" preserveAspectRatio="xMidYMid meet" clip-path="url(#topo-icon-clip)"/>'
            : '<rect x="' + (-NW / 2 + 12) + '" y="-16" width="32" height="32" rx="7" fill="' + color + '22"/>' +
              '<text x="' + (-NW / 2 + 28) + '" y="5" text-anchor="middle" font-size="13" font-weight="bold" fill="' + color + '">' + esc(initials(n.name)) + "</text>") +
          '<text class="topo-node-title" x="' + (-NW / 2 + 52) + '" y="-4" font-size="12" font-weight="bold" fill="#e6edf3">' + esc(shortName) + "</text>" +
          '<text x="' + (-NW / 2 + 52) + '" y="13" font-size="11" fill="#8b949e">' + esc(sub) + "</text>" +
          '<g class="topo-node-ping" style="display:none">' +
            '<circle cx="' + (NW / 2 - 14) + '" cy="' + (-NH / 2 + 14) + '" r="4" fill="' + color + '"/>' +
            '<circle cx="' + (NW / 2 - 14) + '" cy="' + (-NH / 2 + 14) + '" r="4" fill="none" stroke="' + color + '" style="animation: topo-ping 1.2s ease-out infinite;"/>' +
          "</g>";
        nodesG.appendChild(g);

        refs.push({
          key: key,
          color: color,
          filterId: filterId,
          g: g,
          rect: g.querySelector(".topo-node-rect"),
          title: g.querySelector(".topo-node-title"),
          halo: g.querySelector(".topo-node-halo"),
          ping: g.querySelector(".topo-node-ping"),
          beam: edges.querySelector(".topo-edge-beam"),
          idle: edges.querySelector(".topo-edge-idle"),
        });
      });

      // Status aktif turun otomatis kalau provider terlanjur jalan lebih dari 60 detik,
      // supaya animasi tidak nyangkut saat backend lapor aktif terus.
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
          var cls = isActive ? "topo-node is-active" : "topo-node";
          if (r.g.getAttribute("class") !== cls) r.g.setAttribute("class", cls);
          r.rect.setAttribute("stroke", isActive ? r.color : "#30363d");
          r.rect.setAttribute("stroke-width", isActive ? 2 : 1);
          if (isActive) r.rect.setAttribute("filter", "url(#" + r.filterId + ")");
          else r.rect.removeAttribute("filter");
          r.title.setAttribute("fill", isActive ? r.color : "#e6edf3");
          r.halo.style.display = isActive ? "" : "none";
          r.ping.style.display = isActive ? "" : "none";
          r.beam.style.display = isActive ? "" : "none";
          r.idle.style.display = isActive ? "none" : "";
          if (!isActive) {
            r.idle.setAttribute("stroke", isLast ? "#f59e0b" : "#30363d");
            r.idle.setAttribute("stroke-width", isLast ? 2 : 1);
            r.idle.setAttribute("opacity", isLast ? 0.8 : 0.45);
          }
        });

        var powering = activeCount > 0;
        var routerCls = powering ? "topo-router is-powering" : "topo-router";
        if (router.getAttribute("class") !== routerCls) router.setAttribute("class", routerCls);
        routerOn.style.display = powering ? "" : "none";
        routerOff.style.display = powering ? "none" : "";
        routerBadge.style.display = powering ? "" : "none";
        routerBadgeN.textContent = String(activeCount);
      }

      function poll() {
        fetch("/api/topology/active", { cache: "no-store" })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (next) {
            if (!next) return;
            var fresh = {};
            (next.active || []).forEach(function (p) { fresh[String(p).toLowerCase()] = true; });
            rawActive = fresh;
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
    for (const [key, label] of [["session_quota", "Session"], ["weekly_quota", "Weekly"]]) {
      const part = q[key];
      if (!part) continue;
      const used = Number(part.used_percent) || 0;
      rows.push({ label, remaining: Math.max(0, 100 - used), used: used + "% used", reset: part.reset_time });
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

  return visible
    .map(([familyId, entry]) => {
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
      <p class="hint">Provider yang punya akun aktif tampil mengelilingi gateway, lengkap dengan jumlah akun dan pemakaiannya. Warna menandai trafik terakhir: request berjalan, terakhir dipakai, atau idle.</p>
      <div class="topo-split">
        <div class="topo-main">${renderTopologyPane(topology)}</div>
        ${renderRecentPanel(recent)}
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
