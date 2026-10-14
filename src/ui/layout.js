import { escapeHtml } from "./html.js";
import { getLogoDataUri } from "./assets.js";
// Versi sidebar dibaca dari package.json, sama dengan banner CLI dan User-Agent upstream.
import pkg from "../../package.json" with { type: "json" };

const NAV = [
  { id: "overview", label: "Overview", href: "/dashboard", icon: "home" },
  { id: "providers", label: "Providers & Combos", href: "/dashboard/providers", icon: "link" },
  { id: "proxies", label: "Proxy Pools", href: "/dashboard/proxies", icon: "lan" },
  { id: "usage", label: "Usage & Quota", href: "/dashboard/usage", icon: "chart" },
  { id: "tokensaver", label: "Token Saver", href: "/dashboard/token-saver", icon: "bolt" },
  { id: "keys", label: "API Keys", href: "/dashboard/keys", icon: "key" },
  { id: "settings", label: "Settings", href: "/dashboard/settings", icon: "gear" },
];

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  lan: '<rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="4" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V10"/>',
  chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m16 7 3 3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 19.4 9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1c-.6 0-1.2.4-1.5 1z"/>',
  brain: '<path d="M12 4.6a3 3 0 0 0-5.7-1.1A2.6 2.6 0 0 0 4 6a2.5 2.5 0 0 0 .5 4.8 2.8 2.8 0 0 0 1.4 4.6A2.5 2.5 0 0 0 8.6 18H12z"/><path d="M12 4.6a3 3 0 0 1 5.7-1.1A2.6 2.6 0 0 1 20 6a2.5 2.5 0 0 1-.5 4.8 2.8 2.8 0 0 1-1.4 4.6A2.5 2.5 0 0 1 15.4 18H12z"/><path d="M12 4.6V18"/><path d="M9.2 8.2h1.4M13.4 8.2h1.4M9.2 12.4h1.4M13.4 12.4h1.4"/>',
  eye: '<path d="M2.5 12S6.5 5.5 12 5.5 21.5 12 21.5 12 17.5 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  science: '<path d="M9 3h6M10 3v6l-4 9a2 2 0 0 0 1.8 3h8.4a2 2 0 0 0 1.8-3l-4-9V3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
};

export function icon(name, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`;
}

/**
 * Ikon kemampuan model untuk daftar model: otak untuk thinking, mata untuk vision.
 * Model yang kemampuannya tidak diketahui tidak mendapat ikon sama sekali.
 */
export function capabilityIcons(capabilities) {
  if (!capabilities) return "";
  const badges = [];
  if (capabilities.reasoning) {
    badges.push(`<span class="cap-icon" title="Model ini mendukung thinking (reasoning)">${icon("brain")}</span>`);
  }
  if (capabilities.vision) {
    badges.push(`<span class="cap-icon" title="Model ini bisa membaca gambar (vision)">${icon("eye")}</span>`);
  }
  if (badges.length === 0) return "";
  return `<span class="cap-icons" aria-label="Kemampuan model">${badges.join("")}</span>`;
}

export function renderLayout({ title = "Zenith Router", activeTab = "overview", content = "", port = 20120, extraScripts = "" }) {
  const navHtml = NAV.map(
    (t) => `
      <a href="${t.href}" class="nav-link ${t.id === activeTab ? "active" : ""}">
        ${icon(t.icon)}
        <span>${t.label}</span>
      </a>`
  ).join("");

  const logoUri = getLogoDataUri();

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" type="image/png" href="${logoUri}">
  <title>${escapeHtml(title)} &middot; Zenith Router</title>
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
    .brand { display: flex; align-items: center; gap: 0.75rem; padding: 0 0.5rem 1rem; }
    .brand-logo {
      width: 36px; height: 36px; border-radius: 8px;
      object-fit: cover;
      display: block;
      background: transparent;
      flex-shrink: 0;
    }
    .brand h1 { font-size: 1.05rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.25; }
    .brand small { display: block; color: var(--text-subtle); font-size: 0.72rem; font-weight: 500; }
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
    .page-tabs { display: flex; gap: 0.35rem; margin-bottom: 1.25rem; border-bottom: 1px solid var(--border-subtle); }
    .page-tab { padding: 0.45rem 0.9rem; color: var(--text-muted); text-decoration: none; font-size: 0.88rem; font-weight: 500; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .page-tab:hover { color: var(--text); }
    .page-tab.active { color: var(--text); border-bottom-color: var(--text); }
    #update-badge:empty { display: none; }
    .update-banner {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 0.45rem 0.5rem;
      margin: 0 0.25rem 0.85rem;
      padding: 0.65rem 0.75rem;
      background: linear-gradient(180deg, rgba(251, 191, 36, 0.08) 0%, rgba(251, 191, 36, 0.03) 100%);
      border: 1px solid rgba(251, 191, 36, 0.22);
      border-radius: var(--radius);
      font-size: 0.75rem;
      color: var(--text);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      animation: fadeIn 0.2s ease-in-out;
    }
    .update-banner > span {
      font-weight: 600;
      color: #fef08a;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.76rem;
    }
    .update-banner > span::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--warning, #fbbf24);
      box-shadow: 0 0 8px rgba(251, 191, 36, 0.9);
      display: inline-block;
      flex-shrink: 0;
    }
    .update-banner > a {
      color: var(--text-muted);
      font-size: 0.7rem;
      text-decoration: none;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      transition: color 0.12s, background 0.12s, border-color 0.12s;
      justify-self: end;
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
    }
    .update-banner > a::after {
      content: " ↗";
      font-size: 0.65rem;
      opacity: 0.75;
    }
    .update-banner > a:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.16);
    }
    .update-banner > button {
      grid-column: 1 / -1;
      width: 100%;
      margin-top: 0.15rem;
      padding: 0.35rem 0.65rem;
      font-size: 0.75rem;
      font-weight: 600;
      height: 28px;
      border-radius: 6px;
      background: var(--warning, #fbbf24);
      color: #1c1917;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.35rem;
      transition: background 0.12s, transform 0.08s;
    }
    .update-banner > button:hover {
      background: #f59e0b;
    }
    .update-banner > button:active {
      transform: scale(0.98);
    }
    #upgrade-overlay {
      position: fixed;
      inset: 0;
      z-index: 200;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.78);
      backdrop-filter: blur(6px);
      color: #fff;
      font-size: 0.95rem;
      text-align: center;
      padding: 2rem;
    }
    .sidebar-footer { margin-top: auto; padding: 0.75rem 0.5rem 0; border-top: 1px solid var(--border-subtle); color: var(--text-subtle); font-size: 0.72rem; }
    /* Main */
    .main { flex: 1; min-width: 0; padding: 1.75rem 2rem 3rem; }
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
    .topbar h2 { font-size: 1.35rem; font-weight: 700; letter-spacing: -0.02em; }
    .pill { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.2rem 0.7rem; border-radius: 9999px; font-size: 0.72rem; font-weight: 600; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); white-space: nowrap; }
    .pill-success { color: var(--success); border-color: rgba(52,211,153,.3); background: rgba(52,211,153,.08); }
    .pill-warning { color: var(--warning); border-color: rgba(251,191,36,.3); background: rgba(251,191,36,.08); }
    .pill-danger { color: var(--danger); border-color: rgba(248,113,113,.3); background: rgba(248,113,113,.08); }
    /* Cards */
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1.25rem; }
    .card h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 0.5rem; }
    .card .hint { color: var(--text-muted); font-size: 0.82rem; }
.key-link { color: var(--accent, var(--primary, #6aa7ff)); text-decoration: none; font-weight: 500; }
.key-link:hover { text-decoration: underline; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.25rem; }
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.75rem; }
.card-head h3 { margin-bottom: 0; }
.section { margin-bottom: 1.75rem; }
.section-head { margin-bottom: 0.75rem; }
.section-head h3 { font-size: 1rem; font-weight: 600; }
.section-head .hint { color: var(--text-muted); font-size: 0.82rem; }
.provider-card { display: block; margin-bottom: 0; color: inherit; text-decoration: none; transition: border-color 0.12s, background 0.12s; }
.provider-card:hover { border-color: var(--text-subtle); background: var(--surface-2); }
.provider-card-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.4rem 0.75rem; margin-bottom: 0.35rem; }
.provider-card-head h3 { margin-bottom: 0; }
.provider-title { display: flex; align-items: center; gap: 0.65rem; flex: 1 1 12rem; min-width: 0; }
.provider-text { min-width: 0; }
.provider-title h3 { overflow-wrap: break-word; }
.provider-card-head > .pill { flex-shrink: 0; margin-left: auto; }
.provider-card .hint, .provider-card .hint code { overflow-wrap: anywhere; }
.provider-icon { width: var(--pi, 32px); height: var(--pi, 32px); flex-shrink: 0; border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--surface-3); border: 1px solid var(--border); }
.provider-icon img { width: 100%; height: 100%; object-fit: contain; }
.provider-icon-fb { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: calc(var(--pi, 32px) * 0.38); font-weight: 700; color: var(--text-muted); }
.cap-icons { display: inline-flex; align-items: center; gap: 0.3rem; margin-left: 0.45rem; vertical-align: middle; }
.cap-icon { display: inline-flex; color: var(--text-muted); cursor: help; }
.combo-member { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
.combo-member code { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.combo-move { display: flex; gap: 0.15rem; flex: none; }
.combo-move .btn { padding: 0.1rem 0.4rem; line-height: 1.1; }
.combo-move .btn:disabled { opacity: 0.3; cursor: not-allowed; }
.combo-order {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 1.35rem; height: 1.35rem; border-radius: 6px;
  background: rgba(255,255,255,.06); color: var(--text-muted);
  font-size: 0.72rem; font-variant-numeric: tabular-nums;
}
.cap-icon svg { width: 15px; height: 15px; }
.cap-icon:hover { color: var(--text); }
.pill-row { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.75rem; }
.crumb { color: var(--text-subtle); font-size: 0.82rem; margin-bottom: 1rem; }
.crumb a { color: var(--text-muted); text-decoration: none; }
.crumb a:hover { color: var(--text); }
.back-nav { margin-bottom: 1.25rem; }
.back-link {
  display: inline-flex; align-items: center; gap: 0.45rem;
  color: var(--text-muted); text-decoration: none;
  font-size: 0.85rem; font-weight: 500;
  padding: 0.35rem 0.65rem; border-radius: 6px;
  background: var(--surface-2); border: 1px solid var(--border);
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.back-link:hover { color: var(--text); background: var(--surface-3); border-color: var(--text-subtle); }
.back-link svg { flex-shrink: 0; }
td.actions { display: flex; gap: 0.4rem; justify-content: flex-end; }
th.select-cell, td.select-cell { width: 2.25rem; padding-right: 0; }
.select-cell input[type="checkbox"] { width: 15px; height: 15px; accent-color: var(--text); cursor: pointer; vertical-align: middle; }
/* Kolom seleksi hanya muncul saat mode pilih aktif di halaman detail provider. */
table.select-mode-off th.select-cell, table.select-mode-off td.select-cell { display: none; }
table.select-mode-on tr.model-row { cursor: pointer; }
table.select-mode-on tr.model-row:hover { background: var(--bg-hover, #1e2029); }
table.select-mode-on tr.model-row.is-checked { background: var(--accent-soft, #1f6feb22); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
tr.muted td { color: var(--text-subtle); }
.modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; }
.btn-row { display: flex; gap: 0.4rem; align-items: center; }
.radio-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.75rem; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.5rem; cursor: pointer; font-size: 0.88rem; }
.radio-row input { width: auto; accent-color: var(--text); }
.oauth-actions { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.9rem; }
.oauth-actions form .btn, .oauth-actions > .btn { width: 100%; text-align: center; }
.oauth-actions .hint { margin-top: -0.2rem; }
.oauth-status { border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem; margin-bottom: 0.9rem; font-size: 0.85rem; color: var(--text-muted); }
.oauth-status p + p { margin-top: 0.4rem; }
.oauth-status a { color: var(--text); }
.oauth-status.error { border-color: var(--danger); color: var(--danger); }
.device-code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 1.4rem; letter-spacing: 0.15em; color: var(--text); text-align: center; margin: 0.5rem 0; user-select: all; }
details.manual { border-top: 1px solid var(--border-subtle); padding-top: 0.75rem; }
details.manual summary { cursor: pointer; font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.75rem; }
.notice { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.65rem 0.9rem; border-radius: 8px; font-size: 0.85rem; margin-bottom: 1.25rem; border: 1px solid var(--border); }
.notice-ok { color: var(--success); border-color: rgba(52,211,153,.3); background: rgba(52,211,153,.08); }
.notice-error { color: var(--danger); border-color: rgba(248,113,113,.3); background: rgba(248,113,113,.08); }
.notice-close { background: none; border: none; color: inherit; font-size: 1.15rem; line-height: 1; cursor: pointer; padding: 0 0.25rem; opacity: 0.7; }
.notice-close:hover { opacity: 1; }
.stat .value { font-size: 1.7rem; font-weight: 700; letter-spacing: -0.02em; }
    .stat .label { color: var(--text-muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; }
    .stat .sub { color: var(--text-subtle); font-size: 0.78rem; margin-top: 0.2rem; }
    /* Buttons */
    .btn { display: inline-block; padding: 0.45rem 0.95rem; border-radius: 8px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 0.85rem; font-weight: 500; cursor: pointer; text-decoration: none; transition: background 0.12s; }
    .btn:hover { background: var(--surface-3); }
    .btn-primary { background: var(--accent); color: #0a0a0a; border-color: var(--accent); }
    .btn-primary:hover { background: #d4d4d4; }
    .btn-secondary { background: var(--surface-2); color: var(--text); border-color: var(--border); }
    .btn-secondary:hover { background: var(--surface-3); }
    .btn-danger { color: var(--danger); border-color: rgba(248,113,113,.35); background: transparent; }
    .btn-danger:hover { background: rgba(248,113,113,.1); }
    .btn-sm { padding: 0.25rem 0.6rem; font-size: 0.75rem; }
    .btn-icon { display: inline-flex; align-items: center; justify-content: center; padding: 0.3rem; min-width: 1.9rem; min-height: 1.9rem; line-height: 1; }
    .btn-icon svg { flex-shrink: 0; }
    /* Proxy pool rows */
    .proxy-list { display: flex; flex-direction: column; }
    .proxy-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 0.85rem 0.25rem; border-bottom: 1px solid var(--border-subtle); transition: background 0.12s; }
    .proxy-row:last-child { border-bottom: none; }
    .proxy-info { display: flex; align-items: flex-start; gap: 0.75rem; flex: 1; min-width: 0; }
    .proxy-main { flex: 1; min-width: 0; }
    .proxy-title-line { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.25rem; }
    .proxy-name { font-weight: 600; font-size: 0.92rem; color: var(--text); }
    .proxy-url-line { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8rem; color: var(--text-muted); word-break: break-all; margin-bottom: 0.25rem; }
    .proxy-meta-line { font-size: 0.75rem; color: var(--text-subtle); }
    .proxy-actions { display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0; }
    .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 0.35rem; }
    .bulk-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.65rem 0.9rem; border-radius: 8px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); margin-bottom: 1rem; }
    /* Forms */
    .field { margin-bottom: 0.9rem; }
    .field label { display: block; font-size: 0.8rem; color: var(--text-muted); font-weight: 500; margin-bottom: 0.3rem; }
    input, select, textarea { width: 100%; background: #0d0d0d; border: 1px solid var(--border); color: var(--text); padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.88rem; font-family: inherit; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--text-subtle); box-shadow: 0 0 0 3px rgba(255,255,255,0.08); }
    textarea { resize: vertical; min-height: 120px; line-height: 1.5; }
    .textarea-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; tab-size: 2; white-space: pre; }
    select option { background: var(--surface); color: var(--text); }
    .input-select { width: auto; min-width: 140px; padding: 0.35rem 0.6rem; border-radius: 6px; background: var(--surface-2); color: var(--text); border: 1px solid var(--border); font-size: 0.85rem; }
    .btn-ghost { padding: 0.25rem 0.6rem; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text-muted); font-size: 0.78rem; }
    .btn-ghost:hover { background: rgba(255,255,255,.05); color: var(--text); }
    code { background: var(--surface-2); padding: 0.15rem 0.4rem; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; color: var(--text); }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    /* Wide tables (accounts, models, keys) scroll inside their card instead of pushing the page sideways. */
    .card:has(> table) { overflow-x: auto; }
    th, td { padding: 0.6rem 0.9rem; text-align: left; border-bottom: 1px solid var(--border-subtle); }
    th { color: var(--text-subtle); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; }
    tr:last-child td { border-bottom: none; }
    /* Settings & form rows */
    .setting-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; padding: 1.1rem 0; border-bottom: 1px solid var(--border-subtle); }
    .setting-row:last-child { border-bottom: none; }
    .setting-info { flex: 1; min-width: 0; }
    .setting-info strong { display: block; font-size: 0.9rem; color: var(--text); margin-bottom: 0.2rem; }
    .setting-action { flex-shrink: 0; display: flex; align-items: center; }
    /* Toggle switch */
    .switch { position: relative; display: inline-block; width: 38px; height: 22px; flex-shrink: 0; cursor: pointer; }
    .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
    .slider { position: absolute; inset: 0; background: var(--surface-3); border-radius: 999px; transition: all 0.15s ease; cursor: pointer; border: 1px solid var(--border); }
    .slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; background: var(--text-subtle); border-radius: 50%; transition: all 0.15s ease; }
    .switch input:checked + .slider { background: var(--text); border-color: var(--text); }
    .switch input:checked + .slider::before { transform: translateX(16px); background: #0a0a0a; }
    .switch:hover .slider { border-color: var(--text-muted); }
    .switch input:focus-visible + .slider { outline: 2px solid var(--text-muted); outline-offset: 2px; }
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
      <img src="${logoUri}" alt="Zenith Router" class="brand-logo" />
      <div>
        <h1>Zenith Router</h1>
        <small>v${pkg.version}</small>
      </div>
    </div>
    <div id="update-badge"></div>
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
    // Force reload if page was restored from browser bfcache on back/forward
    window.addEventListener('pageshow', function(event) {
      if (event.persisted) {
        window.location.reload();
      }
    });

    // Clean transient query parameters from the address bar after render
    if (window.location.search && /[?&](import|sync|saved|status|notice)=/.test(window.location.search)) {
      try {
        var url = new URL(window.location.href);
        ['import', 'sync', 'saved', 'status', 'notice', 'count'].forEach(function(k) { url.searchParams.delete(k); });
        var clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '');
        window.history.replaceState({}, document.title, clean);
      } catch (e) {}
    }

    function openModal(id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('open');
    }
    function closeModal(id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('open');
    }
    document.querySelectorAll('[data-close-modal]').forEach(function(el) {
      el.addEventListener('click', function() { closeModal(el.getAttribute('data-close-modal')); });
    });
    document.querySelectorAll('.modal-backdrop').forEach(function(m) {
      m.addEventListener('click', function(e) { if (e.target === m) m.classList.remove('open'); });
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop.open').forEach(function(m) { m.classList.remove('open'); });
      }
    });

    // Row selection: checkboxes share data-select-group; data-select-all toggles the group,
    // data-selected-count shows how many are checked, data-requires-selection disables until one is.
    function syncSelection(group) {
      var boxes = document.querySelectorAll('input[data-select-group="' + group + '"]');
      var n = 0;
      boxes.forEach(function(b) { if (b.checked) n++; });
      document.querySelectorAll('[data-selected-count="' + group + '"]').forEach(function(el) { el.textContent = n; });
      document.querySelectorAll('[data-requires-selection="' + group + '"]').forEach(function(el) { el.disabled = n === 0; });
      document.querySelectorAll('input[data-select-all="' + group + '"]').forEach(function(all) {
        all.checked = n > 0 && n === boxes.length;
        all.indeterminate = n > 0 && n < boxes.length;
      });
    }
    // Mode pilih baris: tabel dengan data-sync-row="models" mulai tersembunyi kolomnya;
    // tombol toggle menampilkan kolom dan mengizinkan klik baris untuk mencentang.
    function setSelectMode(table, on) {
      table.classList.toggle('select-mode-on', on);
      table.classList.toggle('select-mode-off', !on);
      var group = table.getAttribute('data-sync-row');
      document.querySelectorAll('[data-select-mode-toggle="' + group + '"]').forEach(function(btn) {
        btn.textContent = on ? 'Batalkan Pilih' : 'Pilih';
      });
    }
    document.querySelectorAll('table[data-sync-row]').forEach(function(table) {
      setSelectMode(table, false);
    });
    document.addEventListener('click', function(clickEvent) {
      var toggle = clickEvent.target.closest ? clickEvent.target.closest('[data-select-mode-toggle]') : null;
      if (toggle) {
        var toggleGroup = toggle.getAttribute('data-select-mode-toggle');
        var toggleTable = document.querySelector('table[data-sync-row="' + toggleGroup + '"]');
        if (!toggleTable) return;
        setSelectMode(toggleTable, !toggleTable.classList.contains('select-mode-on'));
        return;
      }
      var row = clickEvent.target.closest ? clickEvent.target.closest('tr.model-row') : null;
      if (!row) return;
      var rowTable = row.closest('table');
      if (!rowTable || !rowTable.classList.contains('select-mode-on')) return;
      // Klik tombol/form/link di dalam baris bukan klik seleksi.
      if (clickEvent.target.closest('a, button, input, form, code')) return;
      var box = row.querySelector('input[data-select-group]');
      if (!box) return;
      box.checked = !box.checked;
      row.classList.toggle('is-checked', box.checked);
      syncSelection(box.getAttribute('data-select-group'));
    });
    document.addEventListener('change', function(syncEvent) {
      var t = syncEvent.target;
      if (!t.matches) return;
      if (t.matches('table[data-sync-row] input[data-select-group]')) {
        var changedRow = t.closest('tr.model-row');
        if (changedRow) changedRow.classList.toggle('is-checked', t.checked);
      }
      if (!t.matches) return;
      if (t.matches('input[data-select-all]')) {
        var group = t.getAttribute('data-select-all');
        document.querySelectorAll('input[data-select-group="' + group + '"]').forEach(function(b) { b.checked = t.checked; });
        syncSelection(group);
      } else if (t.matches('input[data-select-group]')) {
        syncSelection(t.getAttribute('data-select-group'));
      }
    });
    document.querySelectorAll('input[data-select-all]').forEach(function(all) { syncSelection(all.getAttribute('data-select-all')); });

    // Confirm a bulk action; controls tied with form="..." are part of form.elements.
    function confirmSelected(form, name, label) {
      var n = 0;
      for (var i = 0; i < form.elements.length; i++) {
        var el = form.elements[i];
        if (el.name === name && el.checked) n++;
      }
      return n > 0 && confirm('Hapus ' + n + ' ' + label + '?');
    }
    // Update badge: tanya versi terbaru sekali, 2,5 detik setelah halaman siap
    // (pola 9router) supaya render awal tidak menunggu jaringan.
    setTimeout(function () {
      var badge = document.getElementById("update-badge");
      if (!badge) return;
      fetch("/api/version", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) {
          if (!info || !info.hasUpdate) return;
          var wrap = document.createElement("div");
          wrap.className = "update-banner";
          var label = document.createElement("span");
          label.textContent = "v" + info.latest + " tersedia";
          wrap.appendChild(label);
          if (info.url && /^https:\\/\\//.test(info.url)) {
            var link = document.createElement("a");
            link.href = info.url;
            link.target = "_blank";
            link.rel = "noreferrer";
            link.textContent = "rilis";
            wrap.appendChild(link);
          }
          if (info.upgrade && info.upgrade.mode === "auto") {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn btn-primary";
            btn.textContent = "Upgrade";
            btn.addEventListener("click", function () { startUpgrade(info); });
            wrap.appendChild(btn);
          }
          badge.appendChild(wrap);
        })
        .catch(function () {});
    }, 2500);

    function startUpgrade(info) {
      if (!window.confirm("Upgrade ke " + info.tag + "? Database akan dibackup, berkas di-checkout, lalu server restart. Lanjutkan?")) return;
      showUpgradeOverlay("Server sedang upgrade ke " + info.tag + "\u2026");
      fetch("/api/version/upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "version=" + encodeURIComponent(info.tag)
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok) { waitUntilUp(info, 0); return; }
          hideUpgradeOverlay();
          window.alert("Upgrade gagal: " + (d && d.error ? d.error : "tidak diketahui"));
        })
        .catch(function () {
          // Respons bisa hilang karena proses keluar sebelum sempat terkirim;
          // anggap berjalan dan pantau saja.
          waitUntilUp(info, 0);
        });
    }

    function waitUntilUp(info, tries) {
      if (tries > 60) {
        hideUpgradeOverlay();
        window.alert("Server belum menjawab dalam 60 detik. Buka data/updater.log lalu jalankan ulang dari terminal.");
        return;
      }
      setTimeout(function () {
        fetch("/api/version", { cache: "no-store" })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.current === info.latest) { location.reload(); }
            else { waitUntilUp(info, tries + 1); }
          })
          .catch(function () { waitUntilUp(info, tries + 1); });
      }, 1000);
    }

    function showUpgradeOverlay(text) {
      var ov = document.createElement("div");
      ov.id = "upgrade-overlay";
      ov.textContent = text;
      document.body.appendChild(ov);
    }
    function hideUpgradeOverlay() {
      var ov = document.getElementById("upgrade-overlay");
      if (ov) ov.remove();
    }
  </script>
  ${extraScripts}
</body>
</html>`;
}
