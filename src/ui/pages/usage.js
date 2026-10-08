import { getUsageStats, getLastProvider, getRecentUsage } from "../../services/usage.js";
import { getAllQuotaStatus } from "../../services/quota.js";
import { hasQuotaFetcher } from "../../services/quota/index.js";
import { getActiveProviders } from "../../services/trafficGuard.js";
import { getConnections } from "../../db/index.js";
import { getAllProviders, getProvider } from "../../providers/index.js";
import { renderLayout } from "../layout.js";
import { escapeHtml } from "../html.js";
import { getLogoDataUri } from "../assets.js";

/**
 * Render Usage Analytics and Quota page
 */
export function renderUsagePage(port = 20120) {
  const stats = getUsageStats({ days: 30 });
  // Hide accounts whose provider exposes no quota data. Fetcher-backed accounts stay
  // until they have been synced (so Sync is reachable) or when they report an error.
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
 * Router-centered topology pane mirroring the 9router layout: router core in
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
        <span><i class="dot dot-router"></i>Zenroute</span>
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
      .topology-legend .dot-router { background: #f0b429; }
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
      @media (max-width: 1100px) { .topo-split { flex-direction: column; } .recent-panel { width: 100%; } }
      .quota-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
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
      .q-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 0.5rem; border-top: 1px solid var(--border-subtle); }
      .q-updated { font-size: 0.7rem; color: var(--text-subtle); }
      @keyframes topo-ping { 0% { opacity: .8; r: 4; } 80%,100% { opacity: 0; r: 10; } }
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
      var activeSet = {};
      (data.active || []).forEach(function (p) { activeSet[p] = true; });
      var lastProvider = String(data.last || "").toLowerCase();

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
      svg.appendChild(edgesG);
      svg.appendChild(nodesG);

      var activeCount = nodes.filter(function (n) { return activeSet[String(n.id).toLowerCase()]; }).length;
      var powering = activeCount > 0;
      var router = document.createElementNS(NS, "g");
      router.innerHTML =
        (powering
          ? '<rect x="' + (CX - 84) + '" y="' + (CY - 30) + '" width="168" height="60" rx="12" fill="rgba(240,180,41,0.15)" stroke="#f0b429" stroke-width="2"/>'
          : '<rect x="' + (CX - 80) + '" y="' + (CY - 26) + '" width="160" height="52" rx="12" fill="#161b22" stroke="#f0b429" stroke-width="1.5"/>') +
        '<image x="' + (CX - 66) + '" y="' + (CY - 12) + '" width="24" height="24" href="' + logo + '"/>' +
        '<text x="' + (CX - 34) + '" y="' + (CY + 4) + '" font-size="13" font-weight="bold" fill="#f0b429">zenroute</text>' +
        (powering
          ? '<circle cx="' + (CX + 64) + '" cy="' + (CY - 14) + '" r="10" fill="#f0b429"/>' +
            '<text x="' + (CX + 64) + '" y="' + (CY - 10) + '" text-anchor="middle" font-size="11" font-weight="bold" fill="#000">' + activeCount + "</text>"
          : "");
      nodesG.appendChild(router);

      nodes.forEach(function (n, i) {
        var p = nodePos(i);
        var color = colorFor(n.id, i);
        var active = !!activeSet[String(n.id).toLowerCase()];
        var last = !active && String(n.id).toLowerCase() === lastProvider;
        var path = edgePath(p);

        var edges = document.createElementNS(NS, "g");
        if (active) {
          edges.innerHTML =
            '<path d="' + path + '" fill="none" stroke="#22d3ee" stroke-width="8" stroke-opacity="0.25" stroke-linecap="round"/>' +
            '<path d="' + path + '" fill="none" stroke="#4ade80" stroke-width="4" stroke-opacity="0.85" stroke-linecap="round"/>' +
            '<path d="' + path + '" fill="none" stroke="#f8fafc" stroke-width="1.8" stroke-linecap="round"/>' +
            [0, 1, 2].map(function (k) {
              return '<circle r="' + (k % 2 === 0 ? 3.5 : 2.2) + '" fill="' + (k % 3 === 0 ? "#fde047" : k % 3 === 1 ? "#67e8f9" : "#fff") + '">' +
                '<animateMotion dur="' + (0.5 + k * 0.12) + 's" repeatCount="indefinite" path="' + path + '" begin="' + (k * 0.15) + 's"/></circle>';
            }).join("");
        } else {
          edges.innerHTML =
            '<path d="' + path + '" fill="none" stroke="' + (last ? "#f59e0b" : "#30363d") + '" stroke-width="' + (last ? 2 : 1) + '" opacity="' + (last ? 0.8 : 0.45) + '"/>';
        }
        edgesG.appendChild(edges);

        var g = document.createElementNS(NS, "g");
        g.setAttribute("class", "topo-node");
        g.setAttribute("transform", "translate(" + p.x.toFixed(1) + "," + p.y.toFixed(1) + ")");
        var shortName = n.name.length > 20 ? n.name.slice(0, 19) + "…" : n.name;
        var sub = n.noAuth && !n.accounts ? "no-auth · ready" : n.accounts + " akun · " + fmt(n.requests) + " req · " + fmt(n.tokens) + " tok";
        g.innerHTML =
          '<rect x="' + (-NW / 2) + '" y="' + (-NH / 2) + '" width="' + NW + '" height="' + NH + '" rx="10" fill="#161b22" stroke="' + (active ? color : "#30363d") + '" stroke-width="' + (active ? 2 : 1) + '"/>' +
          '<rect x="' + (-NW / 2 + 12) + '" y="-16" width="32" height="32" rx="7" fill="' + color + '22"/>' +
          '<text x="' + (-NW / 2 + 28) + '" y="5" text-anchor="middle" font-size="13" font-weight="bold" fill="' + color + '">' + esc(initials(n.name)) + "</text>" +
          '<text x="' + (-NW / 2 + 52) + '" y="-4" font-size="12" font-weight="bold" fill="#e6edf3">' + esc(shortName) + "</text>" +
          '<text x="' + (-NW / 2 + 52) + '" y="13" font-size="11" fill="#8b949e">' + esc(sub) + "</text>" +
          (active
            ? '<circle cx="' + (NW / 2 - 14) + '" cy="' + (-NH / 2 + 14) + '" r="4" fill="' + color + '"/>' +
              '<circle cx="' + (NW / 2 - 14) + '" cy="' + (-NH / 2 + 14) + '" r="4" fill="none" stroke="' + color + '" style="animation: topo-ping 1.2s ease-out infinite;"/>'
            : "");
        nodesG.appendChild(g);
      });
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
 * Recent requests list beside the topology, mirroring the 9router panel:
 * model, in/out tokens, and when the request finished.
 */
function renderRecentPanel(recent) {
  const rows = recent
    .map(
      (r) => `
        <li class="recent-item">
          <div class="recent-line">
            <code class="recent-model">${escapeHtml(r.model)}</code>
            <span class="recent-when">${relWhen(r.timestamp)}</span>
          </div>
          <div class="recent-io">in ${fmtNum(r.input_tokens)} · out ${fmtNum(r.output_tokens)}</div>
        </li>`
    )
    .join("");
  return `
    <aside class="recent-panel">
      <div class="recent-head"><span>Recent Requests</span><span class="pill">${recent.length}</span></div>
      ${recent.length === 0 ? `<p class="recent-empty">No requests yet</p>` : `<ul class="recent-list">${rows}</ul>`}
    </aside>`;
}

/** Remaining percentage tone: green >70, yellow 30–70, red <30 (9router rule). */
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

/** Countdown to a reset timestamp, like 9router: "12m", "3h 12m", "1d 4h 5m". */
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
 * Normalize one connection's quota object into 9router-style progress rows:
 * { label, remaining (0–100|null when unlimited), used line, reset time }.
 */
function quotaRows(q) {
  if (!q) return [];
  const rows = [];
  const unit = q.unit;

  // Per-model buckets (Antigravity): 9router-style one bar per model.
  if (q.quotas && typeof q.quotas === "object" && Object.keys(q.quotas).length > 0) {
    for (const [modelKey, r] of Object.entries(q.quotas)) {
      const rem =
        r.remainingPercentage != null
          ? Number(r.remainingPercentage)
          : r.total > 0
            ? (Number(r.remaining ?? 0) / Number(r.total)) * 100
            : null;
      rows.push({
        label: r.displayName || modelKey,
        remaining: rem,
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

/** 9router-style quota card for one account. */
function renderQuotaCard(s) {
  const q = s.quota;
  const rows = quotaRows(q);
  if (rows.length === 0) rows.push({ label: "Quota", remaining: null, used: q?.error ? String(q.error) : "No quota data yet", reset: null });
  const statusPill = s.is_exhausted
    ? `<span class="pill pill-danger">Exhausted</span>`
    : s.is_active === 0
      ? `<span class="pill">Disabled</span>`
      : `<span class="pill pill-success">OK</span>`;
  const initials = String(s.provider || "?").slice(0, 2).toUpperCase();
  const planPill = q?.plan || (q?.unit === "tier" && q?.tier ? q.tier : "");
  const planPillHtml = planPill ? `<span class="pill">${escapeHtml(planPill)}</span>` : "";

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
        </div>`;
  };

  const visible = rows.slice(0, MAX_VISIBLE_ROWS);
  const hidden = rows.slice(MAX_VISIBLE_ROWS);
  const body =
    visible.map(rowHtml).join("") +
    (hidden.length
      ? `<details class="q-more"><summary>Tampilkan ${hidden.length} baris lagi</summary><div class="q-rows">${hidden.map(rowHtml).join("")}</div></details>`
      : "");

  const updated = q?.updated_at ? `<span>Updated ${relWhen(q.updated_at)}</span>` : "<span>Not synced yet</span>";

  return `
    <div class="quota-card">
      <div class="q-head">
        <div class="q-icon">${escapeHtml(initials)}</div>
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

  const content = `
    <div class="card">
      <h3>Router Topology</h3>
      <p class="hint">Zenroute di tengah, provider tertaut di sekelilingnya. Layout tetap dan tidak bisa digeser.</p>
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
    </div>

    <div class="card">
      <h3>Account Quotas & Balance</h3>
      ${
        quotas.length === 0
          ? `<div class="empty"><p class="big">Belum ada data kuota</p><p>Hanya akun dengan data kuota dari provider yang ditampilkan di sini.</p></div>`
          : `<div class="quota-grid">${quotas.map((q) => renderQuotaCard(q)).join("")}</div>`
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
  `;

  return renderLayout({
    title: "Usage Analytics",
    activeTab: "usage",
    content,
    port,
  });
}
