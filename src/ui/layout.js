import { escapeHtml } from "./html.js";

const NAV = [
  { id: "overview", label: "Overview", href: "/dashboard", icon: "home" },
  { id: "connections", label: "Connections", href: "/dashboard/connections", icon: "link" },
  { id: "usage", label: "Usage & Quota", href: "/dashboard/usage", icon: "chart" },
  { id: "tokensaver", label: "Token Saver", href: "/dashboard/token-saver", icon: "bolt" },
  { id: "models", label: "Models", href: "/dashboard/models", icon: "grid" },
  { id: "keys", label: "API Keys", href: "/dashboard/keys", icon: "key" },
  { id: "settings", label: "Settings", href: "/dashboard/settings", icon: "gear" },
];

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m16 7 3 3"/>',
  grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1c-.6 0-1.2.4-1.5 1z"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

export function renderLayout({ title = "zenroute", activeTab = "overview", content = "", port = 20120 }) {
  const navHtml = NAV.map(
    (t) => `
      <a href="${t.href}" class="nav-link ${t.id === activeTab ? "active" : ""}">
        ${icon(t.icon)}
        <span>${t.label}</span>
      </a>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} &middot; zenroute</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --surface: #161616;
      --surface-2: #1f1f1f;
      --surface-3: #2a2a2a;
      --border: #2a2a2a;
      --border-subtle: #222222;
      --text: #fafafa;
      --text-muted: #a3a3a3;
      --text-subtle: #737373;
      --accent: #fafafa;
      --success: #34d399;
      --warning: #fbbf24;
      --danger: #f87171;
      --info: #93c5fd;
      --radius: 10px;
      --radius-lg: 14px;
      --shadow: 0 12px 28px -4px rgba(0,0,0,0.5);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
      display: flex;
    }
    /* Sidebar */
    .sidebar {
      width: 240px;
      flex-shrink: 0;
      background: var(--surface);
      border-right: 1px solid var(--border-subtle);
      padding: 1.25rem 1rem;
      display: flex;
      flex-direction: column;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .brand { display: flex; align-items: center; gap: 0.65rem; padding: 0 0.5rem 1.25rem; }
    .brand-logo {
      width: 36px; height: 36px; border-radius: 10px;
      background: var(--text); color: #0a0a0a;
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 1.1rem;
    }
    .brand h1 { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.02em; }
    .brand small { display: block; color: var(--text-subtle); font-size: 0.7rem; }
    nav { display: flex; flex-direction: column; gap: 2px; }
    .nav-link {
      display: flex; align-items: center; gap: 0.65rem;
      padding: 0.5rem 0.75rem; border-radius: 8px;
      color: var(--text-muted); text-decoration: none;
      font-size: 0.875rem; font-weight: 500;
      transition: background 0.12s, color 0.12s;
    }
    .nav-link:hover { background: var(--surface-2); color: var(--text); }
    .nav-link.active { background: var(--surface-3); color: var(--text); }
    .sidebar-footer { margin-top: auto; padding: 0.75rem 0.5rem 0; border-top: 1px solid var(--border-subtle); color: var(--text-subtle); font-size: 0.72rem; }
    /* Main */
    .main { flex: 1; min-width: 0; padding: 1.75rem 2rem 3rem; max-width: 1100px; }
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .topbar h2 { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.02em; }
    .pill { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.2rem 0.7rem; border-radius: 9999px; font-size: 0.72rem; font-weight: 600; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); }
    .pill-success { color: var(--success); border-color: rgba(52,211,153,.3); background: rgba(52,211,153,.08); }
    .pill-warning { color: var(--warning); border-color: rgba(251,191,36,.3); background: rgba(251,191,36,.08); }
    .pill-danger { color: var(--danger); border-color: rgba(248,113,113,.3); background: rgba(248,113,113,.08); }
    /* Cards */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1.25rem; }
    .card h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.5rem; }
    .card .hint { color: var(--text-muted); font-size: 0.82rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.25rem; }
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
    .stat .value { font-size: 1.7rem; font-weight: 700; letter-spacing: -0.02em; }
    .stat .label { color: var(--text-muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .stat .sub { color: var(--text-subtle); font-size: 0.78rem; margin-top: 0.2rem; }
    /* Buttons */
    .btn { display: inline-block; padding: 0.45rem 0.95rem; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 0.85rem; font-weight: 500; cursor: pointer; text-decoration: none; transition: background 0.12s; }
    .btn:hover { background: var(--surface-3); }
    .btn-primary { background: var(--accent); color: #0a0a0a; border-color: var(--accent); }
    .btn-primary:hover { background: #d4d4d4; }
    .btn-danger { color: var(--danger); border-color: rgba(248,113,113,.35); background: transparent; }
    .btn-danger:hover { background: rgba(248,113,113,.1); }
    .btn-sm { padding: 0.25rem 0.6rem; font-size: 0.75rem; }
    /* Forms */
    .field { margin-bottom: 0.9rem; }
    .field label { display: block; font-size: 0.8rem; color: var(--text-muted); font-weight: 500; margin-bottom: 0.3rem; }
    input, select { width: 100%; background: #0d0d0d; border: 1px solid var(--border); color: var(--text); padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.88rem; }
    input:focus, select:focus { outline: none; border-color: var(--text-subtle); box-shadow: 0 0 0 3px rgba(255,255,255,0.08); }
    code { background: var(--surface-2); padding: 0.15rem 0.4rem; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; color: var(--text); }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { padding: 0.6rem 0.9rem; text-align: left; border-bottom: 1px solid var(--border-subtle); }
    th { color: var(--text-subtle); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; }
    tr:last-child td { border-bottom: none; }
    /* Toggle switch */
    .switch { position: relative; display: inline-block; width: 38px; height: 22px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; background: var(--surface-3); border-radius: 999px; transition: 0.15s; cursor: pointer; border: 1px solid var(--border); }
    .slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; background: #737373; border-radius: 50%; transition: 0.15s; }
    .switch input:checked + .slider { background: var(--text); border-color: var(--text); }
    .switch input:checked + .slider::before { transform: translateX(16px); background: #0a0a0a; }
    /* Modal */
    .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: none; align-items: center; justify-content: center; z-index: 50; }
    .modal-backdrop.open { display: flex; }
    .modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 1.5rem; width: 100%; max-width: 480px; box-shadow: var(--shadow); }
    .modal h3 { margin-bottom: 1rem; }
    /* Empty state */
    .empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
    .empty .big { font-size: 1rem; color: var(--text); margin-bottom: 0.25rem; font-weight: 600; }
    @media (max-width: 860px) {
      body { flex-direction: column; }
      .sidebar { width: 100%; height: auto; position: static; flex-direction: row; flex-wrap: wrap; align-items: center; }
      nav { flex-direction: row; flex-wrap: wrap; }
      .main { padding: 1.25rem; }
    }
  </style>
</head>
<body>
  <aside class="sidebar">
    <div class="brand">
      <div class="brand-logo">z</div>
      <div><h1>zenroute</h1><small>v0.1.0</small></div>
    </div>
    <nav>${navHtml}</nav>
    <div class="sidebar-footer">Ultra-lightweight personal AI gateway</div>
  </aside>
  <main class="main">
    <div class="topbar">
      <h2>${escapeHtml(title)}</h2>
      <span class="pill pill-success"><span style="width:7px;height:7px;border-radius:50%;background:var(--success);display:inline-block;"></span> Online &middot; Port ${escapeHtml(port)}</span>
    </div>
    ${content}
  </main>
  <script>
    function openModal(id){document.getElementById(id).classList.add('open')}
    function closeModal(id){document.getElementById(id).classList.remove('open')}
    document.querySelectorAll('[data-close-modal]').forEach(function(el){el.addEventListener('click',function(){closeModal(el.getAttribute('data-close-modal'))})});
    document.querySelectorAll('.modal-backdrop').forEach(function(m){m.addEventListener('click',function(e){if(e.target===m)m.classList.remove('open')})});
  </script>
</body>
</html>`;
}
