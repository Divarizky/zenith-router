import { escapeHtml } from "./html.js";
import { getLogoDataUri } from "./assets.js";
import { isUsingDefaultPassword } from "../services/dashboardAuth.js";
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
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>',
  list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  science: '<path d="M9 3h6M10 3v6l-4 9a2 2 0 0 0 1.8 3h8.4a2 2 0 0 0 1.8-3l-4-9V3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
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
    badges.push(`<span class="cap-icon is-reasoning" title="Model ini mendukung thinking (reasoning)">${icon("brain")}</span>`);
  }
  if (capabilities.vision) {
    badges.push(`<span class="cap-icon is-vision" title="Model ini bisa membaca gambar (vision)">${icon("eye")}</span>`);
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
    /* ===== Tema Zenith Router: putih utama, neo-brutalism pastel =====
       Peran warna: latar putih, teks hitam, garis & bayangan keras hitam pekat.
       Aksen Pastel Blue & Pastel Pink dengan teks hitam WCAG AAA.
       Tombol fungsi keluar & hapus memakai warna merah. */
    :root {
      --bg: #fafafa;
      --surface: #fafafa;
      --surface-2: #f0f0f0;
      --surface-3: #e2e2e2;
      --border: #0a0a0a;
      --border-subtle: #737373;
      --text: #0a0a0a;
      --text-muted: #262626;
      --text-subtle: #737373;
      --accent: #93c5fd;
      --accent-hover: #7db1f9;
      --accent-soft: rgba(147, 197, 253, 0.22);
      --accent-pink: #ffb3d9;
      --accent-pink-hover: #fa92c7;
      --accent-pink-soft: rgba(255, 179, 217, 0.25);
      --success: #6ee7b7;
      --warning: #fde047;
      --danger: #fca5a5;
      --danger-hover: #ef4444;
      --info: #7dd3fc;
      --radius: 0px;
      --radius-lg: 0px;
      --bw: 2px;
      --bw-thick: 3px;
      --shadow-ink: #0a0a0a;
      --line: #0a0a0a;
      --logo-tile: #ffffff;
      --logo-tile-line: #0a0a0a;
      --traffic: #3b82f6;
      --traffic-soft: rgba(59, 130, 246, 0.35);
      --traffic-core: #1e3a8a;
      --hard: 5px 5px 0 var(--shadow-ink);
      --hard-sm: 3px 3px 0 var(--shadow-ink);
      --hard-lg: 8px 8px 0 var(--shadow-ink);
      --grid-line: rgba(10, 10, 10, 0.045);
      --outline-green: #15803d;
      --link: #0284c7;
      --link-hover: #0369a1;
      --icon-reasoning: #db2777;
      --icon-vision: #0284c7;
      --bg-hover: #f0f0f0;
    }

    /* ===== Tema gelap =====
       Token dibalik: latar gelap, teks terang, garis & bayangan keras terang.
       Aksen pastel sengaja tetap terang, jadi teks di atasnya tetap hitam. */
    [data-theme="dark"] {
      --bg: #101013;
      --surface: #17171b;
      --surface-2: #202027;
      --surface-3: #2b2b34;
      --border: #5c5c68;
      --border-subtle: #3d3d47;
      --text: #f4f4f7;
      --text-muted: #cfcfd6;
      --text-subtle: #9a9aa6;
      --accent-soft: rgba(147, 197, 253, 0.16);
      --accent-pink-soft: rgba(255, 179, 217, 0.18);
      --success: #34d399;
      --warning: #facc15;
      --danger: #f87171;
      --danger-hover: #dc2626;
      --info: #38bdf8;
      --shadow-ink: #3a3a46;
      --line: #5c5c68;
      --logo-tile: #ffffff;
      --logo-tile-line: #5c5c68;
      --traffic: #7dd3fc;
      --traffic-soft: rgba(125, 211, 252, 0.35);
      --traffic-core: #e0f2fe;
      --grid-line: rgba(244, 244, 247, 0.06);
      --outline-green: #4ade80;
      --link: #7dd3fc;
      --link-hover: #bae6fd;
      --icon-reasoning: #f472b6;
      --icon-vision: #38bdf8;
      --bg-hover: #26262e;
    }
    [data-theme="dark"] .nav-link.active,
    [data-theme="dark"] .btn-primary,
    [data-theme="dark"] .btn-pink,
    [data-theme="dark"] .btn-success,
    [data-theme="dark"] .btn-warning,
    [data-theme="dark"] .btn-danger,
    [data-theme="dark"] .update-banner > button { color: #0a0a0a; }
    [data-theme="dark"] .btn-danger:hover { color: #ffffff; }
    [data-theme="dark"] ::selection { color: #0a0a0a; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      background-image:
        repeating-linear-gradient(0deg, var(--grid-line) 0 1px, transparent 1px 32px),
        repeating-linear-gradient(90deg, var(--grid-line) 0 1px, transparent 1px 32px);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
    }
    a { color: inherit; }
    code, kbd, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    ::selection { background: var(--accent); color: var(--text); }
    :focus-visible { outline: var(--bw-thick) solid var(--line); outline-offset: 2px; }
    .num { font-variant-numeric: tabular-nums; }

    /* ===== Topbar (menggantikan sidebar) ===== */
    .topbar-app {
      position: sticky; top: 0; z-index: 60;
      display: flex; align-items: center; gap: 1.25rem;
      padding: 0.6rem 1.75rem;
      background: var(--surface);
      border-bottom: var(--bw-thick) solid var(--line);
    }
    .brand { display: flex; align-items: center; gap: 0.65rem; flex-shrink: 0; }
    .brand-logo {
      width: 34px; height: 34px;
      border: var(--bw) solid var(--line);
      object-fit: cover; display: block; background: transparent; flex-shrink: 0;
    }
    .brand h1 { font-size: 0.98rem; font-weight: 800; letter-spacing: -0.01em; line-height: 1.25; text-transform: uppercase; }
    .brand small { display: block; color: var(--text-subtle); font-size: 0.72rem; font-weight: 500; }
    .topbar-app nav { display: flex; align-items: center; gap: 0.15rem; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
    .topbar-app nav::-webkit-scrollbar { display: none; }
    .nav-link {
      display: flex; align-items: center; gap: 0.45rem;
      padding: 0.45rem 0.75rem;
      border: var(--bw) solid transparent;
      color: var(--text-muted); text-decoration: none;
      font-size: 0.84rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.03em;
      white-space: nowrap;
      transition: color 0.12s, background 0.12s, border-color 0.12s;
    }
    .nav-link:hover { color: var(--text); background: var(--surface-2); }
    .nav-link.active { color: var(--text); background: var(--accent); border-color: var(--line); box-shadow: var(--hard-sm); }
    .nav-link svg { flex-shrink: 0; }
    .topbar-end { display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0; margin-left: auto; }
    .sidebar-user { color: var(--text-subtle); font-size: 0.74rem; }
    .sidebar-user form { margin: 0; display: inline; }
    /* Tombol tema: ikon bulan saat terang, matahari saat gelap. */
    .theme-icon { display: none; align-items: center; justify-content: center; }
    .theme-icon-moon { display: inline-flex; }
    [data-theme="dark"] .theme-icon-moon { display: none; }
    [data-theme="dark"] .theme-icon-sun { display: inline-flex; }
    #update-badge:empty { display: none; }

    /* Banner update: garis kiri tebal pink, tombol pink aksen */
    .update-banner {
      display: grid; grid-template-columns: 1fr auto;
      align-items: center; gap: 0.45rem 0.5rem;
      margin: 0 0 0.85rem; padding: 0.65rem 0.75rem;
      background: var(--surface);
      border: var(--bw) solid var(--line);
      border-left-width: 6px; border-left-color: var(--accent-pink);
      font-size: 0.75rem; color: var(--text);
      box-shadow: var(--hard-sm);
      animation: fadeIn 0.2s ease-in-out;
    }
    .update-banner > span {
      font-weight: 800; color: var(--text);
      display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.76rem;
    }
    .update-banner > span::before {
      content: ""; width: 8px; height: 8px;
      background: var(--accent-pink); display: inline-block; flex-shrink: 0;
    }
    .update-banner > a {
      color: var(--text-muted); font-size: 0.7rem; text-decoration: none;
      padding: 0.15rem 0.5rem; border: var(--bw) solid var(--border);
      background: var(--surface-2);
      transition: color 0.12s, background 0.12s;
      justify-self: end; display: inline-flex; align-items: center; gap: 0.2rem;
    }
    .update-banner > a::after { content: " \\2197"; font-size: 0.65rem; }
    .update-banner > a:hover { color: var(--accent); background: var(--surface-3); }
    .update-banner > button {
      grid-column: 1 / -1; width: 100%; margin-top: 0.15rem;
      padding: 0.35rem 0.65rem; font-size: 0.75rem; font-weight: 800;
      height: 30px; background: var(--accent-pink); color: #0a0a0a;
      border: var(--bw) solid var(--line); cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem;
      transition: transform 0.08s, box-shadow 0.08s, background 0.12s;
    }
    .update-banner > button:hover { background: var(--accent-pink-hover); transform: translate(-2px, -2px); box-shadow: var(--hard-sm); }
    .update-banner > button:active { transform: translate(1px, 1px); box-shadow: none; }

    #upgrade-overlay {
      position: fixed; inset: 0; z-index: 200;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      background: rgba(10, 10, 10, 0.82);
      color: #fafafa; font-size: 0.95rem; text-align: center; padding: 2rem;
    }

    /* ===== Main & topbar judul ===== */
    .main { min-width: 0; padding: 1.75rem 2rem 5rem; }
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .topbar h2 { font-size: 1.35rem; font-weight: 800; letter-spacing: -0.02em; text-transform: uppercase; }
    .page-tabs { display: flex; gap: 0.35rem; margin-bottom: 1.25rem; border-bottom: var(--bw) solid var(--border-subtle); flex-wrap: wrap; }
    .page-tab { padding: 0.45rem 0.9rem; color: var(--text-muted); text-decoration: none; font-size: 0.88rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: var(--bw-thick) solid transparent; margin-bottom: -2px; }
    .page-tab:hover { color: var(--text); background: var(--surface-2); }
    .page-tab.active { color: var(--text); border-bottom-color: var(--text); background: var(--accent-soft); }
    .crumb { color: var(--text-subtle); font-size: 0.82rem; margin-bottom: 1rem; }
    .crumb a { color: var(--text-muted); text-decoration: none; }
    .crumb a:hover { color: var(--text); }
    .back-nav { margin-bottom: 1.25rem; }
    .back-link {
      display: inline-flex; align-items: center; gap: 0.45rem;
      color: var(--text-muted); text-decoration: none;
      font-size: 0.85rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em;
      padding: 0.35rem 0.6rem;
      background: var(--surface); border: var(--bw) solid var(--border);
      box-shadow: var(--hard-sm);
      transition: background 0.12s, color 0.12s, border-color 0.12s, transform 0.08s, box-shadow 0.08s;
    }
    .back-link:hover { color: var(--text); background: var(--surface-2); border-color: var(--line); transform: translate(-2px, -2px); box-shadow: var(--hard); }
    .back-link:active { transform: translate(1px, 1px); box-shadow: none; }
    .back-link svg { flex-shrink: 0; }

    /* ===== Pill status: gaya badge LIVE (latar penuh, teks hitam / kontras WCAG) ===== */
    .pill {
      display: inline-flex; align-items: center; gap: 0.35rem;
      padding: 0.16rem 0.5rem;
      border: var(--bw) solid var(--line);
      background: var(--surface);
      /* Teks hitam, bukan warna status: kontras teks berwarna di atas putih gagal WCAG. */
      color: var(--text);
      font-size: 0.68rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;
      white-space: nowrap;
    }
    .pill-success { background: var(--success); border-color: var(--line); color: #0a0a0a; }
    .pill-warning { background: var(--warning); border-color: var(--line); color: #0a0a0a; }
    .pill-danger { background: var(--danger); border-color: var(--line); color: #0a0a0a; }
    .pill-info { background: var(--info); border-color: var(--line); color: #0a0a0a; }
    .pill-accent { background: var(--accent); border-color: var(--line); color: #0a0a0a; }
    .pill-pink { background: var(--accent-pink); border-color: var(--line); color: #0a0a0a; }
    .pill-muted { background: var(--surface-2); border-color: var(--line); color: var(--text-muted); }
    .pill .dot, .pill svg { flex-shrink: 0; }
    .dot { display: inline-block; width: 8px; height: 8px; background: currentColor; }
    .dot-success { background: var(--success); }
    .dot-warning { background: var(--warning); }
    .dot-danger { background: var(--danger); }
    .dot-accent { background: var(--accent); }
    .dot-pink { background: var(--accent-pink); }
    .pill-row { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.75rem; }

    /* ===== Kartu & grid ===== */
    .card { background: var(--surface); border: var(--bw) solid var(--line); border-radius: var(--radius-lg); padding: 1.25rem; margin-bottom: 1.25rem; box-shadow: var(--hard); }
    .card h3 { font-size: 0.95rem; font-weight: 800; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.04em; }
    .card .hint { color: var(--text-muted); font-size: 0.82rem; }
    .card-head { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
    .card-head h3 { margin-bottom: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.25rem; }
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
    .section { margin-bottom: 1.75rem; }
    .section-head { margin-bottom: 0.75rem; }
    .section-head h3 { font-size: 1rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
    .section-head .hint { color: var(--text-muted); font-size: 0.82rem; }
    .section-head h3 svg { vertical-align: -2px; color: var(--text-muted); margin-right: 0.3rem; }
    .empty { text-align: center; padding: 2.5rem 1rem; color: var(--text-muted); }
    .empty .big { font-size: 1rem; color: var(--text); margin-bottom: 0.25rem; font-weight: 800; }
    .banner { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.7rem 0.9rem; border-radius: var(--radius); border: var(--bw) solid var(--line); border-left-width: 6px; font-size: 0.85rem; margin-bottom: 1.25rem; background: var(--surface); color: var(--text); box-shadow: var(--hard-sm); }
    .banner-warning { border-left-color: var(--warning); }
    .banner strong { font-weight: 800; }
    .notice { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.65rem 0.9rem; border-radius: var(--radius); font-size: 0.85rem; margin-bottom: 1.25rem; border: var(--bw) solid var(--line); background: var(--surface); color: var(--text); box-shadow: var(--hard-sm); }
    .notice-ok { border-left: 6px solid var(--success); }
    .notice-error { border-left: 6px solid var(--danger); }
    .notice-close { background: none; border: none; color: inherit; font-size: 1.15rem; line-height: 1; cursor: pointer; padding: 0 0.25rem; opacity: 0.7; }
    .notice-close:hover { opacity: 1; }
    .bulk-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; padding: 0.65rem 0.9rem; border-radius: var(--radius); background: var(--surface); border: var(--bw) solid var(--line); margin-bottom: 1rem; box-shadow: var(--hard-sm); }

    /* ===== Provider & combo ===== */
    .provider-card { display: block; margin-bottom: 0; color: inherit; text-decoration: none; transition: background 0.12s, border-color 0.12s, transform 0.12s, box-shadow 0.12s; }
    .provider-card:hover { border-color: var(--line); background: var(--surface-2); transform: translate(-2px, -2px); box-shadow: var(--hard); }
    .provider-card-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.4rem 0.75rem; margin-bottom: 0.35rem; }
    .provider-card-head h3 { margin-bottom: 0; }
    .provider-title { display: flex; align-items: center; gap: 0.65rem; flex: 1 1 12rem; min-width: 0; }
    .provider-text { min-width: 0; }
    .provider-title h3 { overflow-wrap: break-word; }
    .provider-card-head > .pill { flex-shrink: 0; margin-left: auto; }
    .provider-card .hint, .provider-card .hint code { overflow-wrap: anywhere; }
    .provider-icon { width: var(--pi, 32px); height: var(--pi, 32px); flex-shrink: 0; border-radius: var(--radius); display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--logo-tile); border: var(--bw) solid var(--line); }
    .provider-icon img { width: 100%; height: 100%; object-fit: contain; }
    .provider-icon-fb { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: calc(var(--pi, 32px) * 0.38); font-weight: 800; color: var(--text); }
    .cap-icons { display: inline-flex; align-items: center; gap: 0.3rem; margin-left: 0.45rem; vertical-align: middle; }
    .cap-icon { display: inline-flex; color: var(--text-muted); cursor: help; }
    .cap-icon:hover { color: var(--text); }
    .cap-icon.is-reasoning { color: var(--icon-reasoning); }
    .cap-icon.is-vision { color: var(--icon-vision); }
    .cap-icon svg { width: 15px; height: 15px; }
    .combo-member { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.3rem; }
    .combo-member code { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .combo-move { display: flex; gap: 0.15rem; flex: none; }
    .combo-move .btn { padding: 0.1rem 0.4rem; line-height: 1.1; }
    .combo-move .btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .combo-order {
      flex: none; display: inline-flex; align-items: center; justify-content: center;
      width: 1.35rem; height: 1.35rem;
      background: var(--surface-2); color: var(--text-muted);
      border: var(--bw) solid var(--line);
      font-size: 0.72rem; font-variant-numeric: tabular-nums;
    }

    /* ===== Tombol ===== */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem;
      padding: 0.45rem 0.9rem;
      border-radius: var(--radius);
      border: var(--bw) solid var(--line);
      background: var(--surface-2); color: var(--text);
      font-size: 0.85rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em;
      cursor: pointer; text-decoration: none;
      box-shadow: var(--hard-sm);
      transition: transform 0.08s, box-shadow 0.08s, background 0.12s, color 0.12s, border-color 0.12s;
    }
    .btn:hover { background: var(--surface-3); transform: translate(-2px, -2px); box-shadow: var(--hard); }
    .btn:active { transform: translate(1px, 1px); box-shadow: none; }
    /* Tombol utama dengan Pastel Blue */
    .btn-primary { background: var(--accent); color: var(--text); border-color: var(--line); }
    .btn-primary:hover { background: var(--accent-hover); }
    /* Tombol aksen pink untuk highlight */
    .btn-pink { background: var(--accent-pink); color: var(--text); border-color: var(--line); }
    .btn-pink:hover { background: var(--accent-pink-hover); }
    .btn-secondary { background: var(--surface-2); color: var(--text); border-color: var(--border); }
    .btn-secondary:hover { background: var(--surface-3); }
    /* Aksi berwarna neo-brutalism: tombol danger/hapus/keluar solid merah */
    .btn-success { background: var(--success); color: var(--text); border: var(--bw) solid var(--line); }
    .btn-success:hover { background: #34d399; }
    .btn-warning { background: var(--warning); color: var(--text); border: var(--bw) solid var(--line); }
    .btn-warning:hover { background: #facc15; }
    .btn-danger {
      background: var(--danger);
      color: var(--text);
      border: var(--bw) solid var(--line);
      box-shadow: var(--hard-sm);
    }
    .btn-danger:hover {
      background: var(--danger-hover);
      color: #ffffff;
      transform: translate(-2px, -2px);
      box-shadow: var(--hard);
    }
    .btn-sm { padding: 0.25rem 0.6rem; font-size: 0.75rem; }
    .btn-icon { display: inline-flex; align-items: center; justify-content: center; padding: 0.3rem; min-width: 1.9rem; min-height: 1.9rem; line-height: 1; }
    .btn-icon svg { flex-shrink: 0; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }
    .btn-row { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
    .btn-ghost { padding: 0.25rem 0.6rem; border-radius: var(--radius); border: var(--bw) solid var(--border); background: transparent; color: var(--text-muted); font-size: 0.78rem; font-weight: 700; }
    .btn-ghost:hover { background: var(--surface-2); color: var(--text); border-color: var(--line); }
    .key-link { color: var(--link); text-decoration: underline; font-weight: 700; }
    .key-link:hover { color: var(--link-hover); }
    td.actions { text-align: right; vertical-align: middle; white-space: nowrap; }
    td.actions form { margin: 0; display: inline-flex; vertical-align: middle; margin-left: 0.4rem; }
    td.actions form:first-child { margin-left: 0; }

    /* Stepper prioritas akun (seamless segmented control) */
    .priority-stepper {
      display: inline-flex;
      align-items: stretch;
      border: var(--bw) solid var(--line);
      border-radius: var(--radius);
      background: var(--surface);
      box-shadow: var(--hard-sm);
      overflow: hidden;
      height: 26px;
      vertical-align: middle;
    }
    .priority-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 26px;
      padding: 0 6px;
      background: var(--surface-2);
      color: var(--text);
      font-weight: 800;
      font-size: 0.78rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      border-right: var(--bw) solid var(--line);
      user-select: none;
    }
    .priority-actions {
      display: inline-flex;
      margin: 0;
    }
    .priority-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 100%;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--text);
      font-size: 0.8rem;
      font-weight: 800;
      line-height: 1;
      cursor: pointer;
      transition: background 0.1s, color 0.1s;
    }
    .priority-btn:first-child {
      border-right: 1px solid var(--border-subtle);
    }
    .priority-btn:hover:not(:disabled) {
      background: var(--accent);
      color: var(--text);
    }
    .priority-btn:disabled {
      opacity: 0.25;
      color: var(--text-subtle);
      cursor: not-allowed;
      background: var(--surface-2);
    }
    th.select-cell, td.select-cell { width: 2.25rem; padding-right: 0; }
    .select-cell input[type="checkbox"] { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; vertical-align: middle; }
    table.select-mode-off th.select-cell, table.select-mode-off td.select-cell { display: none; }
    table.select-mode-on tr.model-row { cursor: pointer; }
    table.select-mode-on tr.model-row:hover { background: var(--bg-hover); }
    table.select-mode-on tr.model-row.is-checked { background: var(--accent-soft); }
    tr.muted td { color: var(--text-subtle); }
    .modal-actions { display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem; flex-wrap: wrap; }
    .radio-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.75rem; border: var(--bw) solid var(--line); border-radius: var(--radius); margin-bottom: 0.5rem; cursor: pointer; font-size: 0.88rem; color: var(--text-muted); }
    .radio-row:hover { background: var(--surface-2); color: var(--text); }
    .radio-row input { width: auto; accent-color: var(--accent); }
    .oauth-actions { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.9rem; }
    .oauth-actions form .btn, .oauth-actions > .btn { width: 100%; text-align: center; }
    .oauth-actions .hint { margin-top: -0.2rem; }
    .oauth-status { border: var(--bw) solid var(--line); border-radius: var(--radius); padding: 0.8rem; margin-bottom: 0.9rem; font-size: 0.85rem; color: var(--text-muted); }
    .oauth-status p + p { margin-top: 0.4rem; }
    .oauth-status a { color: var(--text); }
    .oauth-status.error { border-color: var(--danger); color: var(--text); }
    .device-code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 1.4rem; letter-spacing: 0.15em; color: var(--text); text-align: center; margin: 0.5rem 0; user-select: all; }
    details.manual { border-top: var(--bw) solid var(--border-subtle); padding-top: 0.75rem; }
    details.manual summary { cursor: pointer; font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.75rem; }
    details.manual summary:hover { color: var(--text); }

    /* ===== Proxy ===== */
    .proxy-list { display: flex; flex-direction: column; }
    .proxy-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 0.85rem 0.25rem; border-bottom: var(--bw) solid var(--border-subtle); }
    .proxy-row:last-child { border-bottom: none; }
    .proxy-info { display: flex; align-items: flex-start; gap: 0.75rem; flex: 1; min-width: 0; }
    .proxy-main { flex: 1; min-width: 0; }
    .proxy-title-line { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.25rem; }
    .proxy-name { font-weight: 800; font-size: 0.92rem; color: var(--text); }
    .proxy-url-line { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8rem; color: var(--text-muted); word-break: break-all; margin-bottom: 0.25rem; }
    .proxy-meta-line { font-size: 0.75rem; color: var(--text-subtle); }
    .proxy-actions { display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0; flex-wrap: wrap; }

    /* ===== Form ===== */
    .field { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.9rem; }
    .field label { display: block; font-size: 0.8rem; color: var(--text); font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.3rem; }
    .field-label { font-size: 0.75rem; color: var(--text-muted); }
    .field input { padding: 0.45rem 0.65rem; font-size: 0.85rem; }
    input, select, textarea { width: 100%; background: var(--surface); border: var(--bw) solid var(--line); color: var(--text); padding: 0.5rem 0.75rem; border-radius: var(--radius); font-size: 0.88rem; font-family: inherit; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--line); box-shadow: 3px 3px 0 var(--accent); }
    textarea { resize: vertical; min-height: 120px; line-height: 1.5; }
    .textarea-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; tab-size: 2; white-space: pre; }
    select option { background: var(--surface); color: var(--text); }
    .input-select { width: auto; min-width: 140px; padding: 0.35rem 0.6rem; border-radius: var(--radius); background: var(--surface); color: var(--text); border: var(--bw) solid var(--line); font-size: 0.85rem; }
    .input-password-wrap { position: relative; display: flex; align-items: center; width: 100%; }
    .input-password-wrap input { width: 100%; padding-right: 2.2rem; }
    .btn-toggle-pw {
      position: absolute; right: 0.3rem; top: 50%; transform: translateY(-50%);
      background: transparent; border: var(--bw) solid transparent; padding: 0.25rem;
      color: var(--text-muted); cursor: pointer; border-radius: var(--radius);
      display: inline-flex; align-items: center; justify-content: center; line-height: 1;
      transition: color 0.12s, background 0.12s, border-color 0.12s;
    }
    .btn-toggle-pw:hover { color: var(--text); background: var(--surface-2); border-color: var(--line); }
    .btn-toggle-pw:focus-visible { outline: var(--bw) solid var(--line); outline-offset: 1px; }
    .btn-toggle-pw .icon-eye-off { display: none; }
    .btn-toggle-pw.is-visible .icon-eye { display: none; }
    .btn-toggle-pw.is-visible .icon-eye-off { display: inline-flex; }
    code { background: var(--surface-2); padding: 0.15rem 0.4rem; border-radius: var(--radius); border: var(--bw) solid var(--border); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; color: var(--text); }
    kbd { background: var(--surface-2); border: var(--bw) solid var(--border); border-bottom-width: var(--bw-thick); border-radius: var(--radius); padding: 0.05rem 0.35rem; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.8rem; color: var(--text); }

    /* ===== Tabel ===== */
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; border: var(--bw) solid var(--line); background: var(--surface); }
    .card:has(> table) { overflow-x: auto; }
    th, td { padding: 0.6rem 0.85rem; text-align: left; vertical-align: middle; border-bottom: var(--bw) solid var(--border-subtle); }
    /* Header tabel: permukaan sedikit lebih gelap dari badan tabel, teks mengikuti tema. */
    th { color: var(--text); background: var(--surface-3); font-weight: 800; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.07em; border-bottom: var(--bw) solid var(--line); }
    tbody tr { transition: background 0.12s; }
    tbody tr:hover { background: var(--surface-2); }
    tr:last-child td { border-bottom: none; }

    /* ===== Accounts Table ===== */
    .accounts-table td { word-break: break-word; }
    .accounts-table .account-proxy-form {
      display: flex;
      gap: 0.35rem;
      margin-top: 0.35rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .accounts-table .account-proxy-form select {
      width: auto;
      max-width: 130px;
      padding: 0.25rem 0.5rem;
      font-size: 0.8rem;
      height: 28px;
    }
    .accounts-table .account-proxy-form input[type="text"] {
      width: auto;
      min-width: 7rem;
      max-width: 140px;
      padding: 0.25rem 0.5rem;
      font-size: 0.8rem;
      height: 28px;
    }
    .accounts-table .account-proxy-form .btn {
      height: 28px;
      padding: 0.2rem 0.6rem;
      display: inline-flex;
      align-items: center;
    }
    .accounts-table td.actions {
      white-space: normal;
      text-align: right;
    }
    .accounts-table td.actions form {
      margin: 0.15rem 0 0.15rem 0.35rem;
      vertical-align: middle;
    }
    .accounts-table td.actions form:first-child {
      margin-left: 0;
    }
    .accounts-table .account-session-form {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .accounts-table .account-session-form input {
      width: 7.5rem;
      max-width: 9rem;
      padding: 0.25rem 0.5rem;
      font-size: 0.8rem;
      height: 28px;
    }
    .accounts-table .account-session-form .btn,
    .accounts-table td.actions .btn {
      height: 28px;
      padding: 0.2rem 0.6rem;
      display: inline-flex;
      align-items: center;
    }

    /* ===== Settings ===== */
    .setting-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; padding: 1.1rem 0; border-bottom: var(--bw) solid var(--border-subtle); }
    .setting-row:last-child { border-bottom: none; }
    .setting-info { flex: 1; min-width: 0; }
    .setting-info strong { display: block; font-size: 0.9rem; color: var(--text); margin-bottom: 0.2rem; }
    .setting-action { flex-shrink: 0; display: flex; align-items: center; }
    .setting-stack { flex-direction: column; align-items: stretch; gap: 0.7rem; width: 260px; }
    .setting-note { font-size: 0.8rem; margin-top: 0.25rem; }
    .setting-note-warning { color: var(--text); border-left: var(--bw-thick) solid var(--warning); padding-left: 0.5rem; }
    .setting-note-danger { color: var(--text); border-left: var(--bw-thick) solid var(--danger); padding-left: 0.5rem; }
    .settings-actions { position: sticky; bottom: 0.75rem; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; flex-wrap: wrap; padding: 0.7rem 0.9rem; background: var(--surface); border: var(--bw) solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--hard); }
    .switch { position: relative; display: inline-block; width: 44px; height: 26px; flex-shrink: 0; cursor: pointer; }
    .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
    .slider { position: absolute; inset: 0; background: var(--surface-2); border-radius: var(--radius); cursor: pointer; border: var(--bw) solid var(--line); }
    .slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: var(--text); transition: transform 0.15s ease; }
    .switch input:checked + .slider { background: var(--text); }
    .switch input:checked + .slider::before { transform: translateX(18px); background: var(--surface); }
    .switch:hover .slider { border-color: var(--line); }
    .switch input:focus-visible + .slider { outline: var(--bw) solid var(--line); outline-offset: 2px; }

    /* ===== Modal ===== */
    .modal-backdrop { position: fixed; inset: 0; background: rgba(10, 10, 10, 0.55); display: none; align-items: center; justify-content: center; z-index: 50; padding: 1rem; overflow-y: auto; }
    .modal-backdrop.open { display: flex; }
    .modal { background: var(--surface); border: var(--bw-thick) solid var(--line); border-radius: var(--radius-lg); padding: 1.5rem; width: 100%; max-width: 480px; box-shadow: var(--hard-lg); max-height: calc(100vh - 2rem); max-height: calc(100dvh - 2rem); overflow-y: auto; overscroll-behavior: contain; }
    .modal h3 { margin-bottom: 1rem; }

    /* ===== Stat ===== */
    .stat .value { font-size: 1.7rem; font-weight: 800; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
    .stat .label { color: var(--text-muted); font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 800; }
    .stat .sub { color: var(--text-subtle); font-size: 0.78rem; margin-top: 0.2rem; }

    /* ===== Responsif ===== */
    @media (max-width: 860px) {
      .main { padding: 1.25rem 1rem 4rem; }
      .topbar-app { flex-wrap: wrap; padding: 0.6rem 1rem; gap: 0.6rem; }
      .topbar-app nav { order: 3; width: 100%; flex: 1 0 100%; }
      .topbar-end { margin-left: auto; }
      .sidebar-user { display: none; }
      .setting-row { flex-direction: column; align-items: stretch; gap: 0.6rem; }
      .setting-action .input-select { width: 100%; }
      .setting-stack { width: 100%; }
      .settings-actions { flex-direction: column-reverse; align-items: stretch; }
      .settings-actions .btn { width: 100%; }
    }

    /* ===== Toast hasil aksi & tombol sibuk ===== */
    .zr-toast {
      position: fixed; right: 1.25rem; bottom: 1.25rem; z-index: 1200;
      max-width: 22rem; padding: 0.75rem 1rem;
      background: var(--surface); color: var(--text);
      border: var(--bw) solid var(--line); border-radius: var(--radius);
      box-shadow: var(--hard); font-size: 0.85rem;
    }
    .zr-toast-error { border-color: var(--danger); }
    button.is-busy, input.is-busy { position: relative; opacity: 0.7; pointer-events: none; }
    button.is-busy:not(.btn-icon)::after, input.is-busy::after {
      content: ""; width: 0.8em; height: 0.8em; margin-left: 0.5em;
      display: inline-block; vertical-align: -0.12em;
      border: var(--bw) solid currentColor; border-top-color: transparent;
      animation: zr-spin 0.7s linear infinite;
    }
    button.btn-icon.is-busy svg { animation: zr-spin 0.7s linear infinite; }
    @keyframes zr-spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
    }
    </style>
    <script data-once>
      // Terapkan tema sebelum body dilukis supaya tidak ada kedipan tema terang.
      (function () {
        try {
          var stored = localStorage.getItem('zr-theme');
          var theme = stored === 'dark' || stored === 'light'
            ? stored
            : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
          document.documentElement.setAttribute('data-theme', theme);
        } catch (e) {}
      })();
    </script>
</head>
<body>
  <header class="topbar-app">
    <div class="brand">
      <img src="${logoUri}" alt="Zenith Router" class="brand-logo" />
      <div>
        <h1>Zenith Router</h1>
        <small>v${pkg.version}</small>
      </div>
    </div>
    <div id="update-badge"></div>
    <nav>${navHtml}</nav>
    <div class="topbar-end">
      <button type="button" class="btn btn-secondary btn-icon" id="theme-toggle" aria-label="Ubah tema" title="Ubah tema">
        <span class="theme-icon theme-icon-moon">${icon("moon")}</span>
        <span class="theme-icon theme-icon-sun">${icon("sun")}</span>
      </button>
      <span class="sidebar-user">Ultra-lightweight personal AI gateway</span>
      <form action="/dashboard/logout" method="POST">
        <button type="submit" class="btn btn-danger btn-sm" title="Logout">Keluar</button>
      </form>
    </div>
  </header>
  <main class="main">
    ${isUsingDefaultPassword() ? `
    <div class="banner banner-warning">
      <span><strong>Perhatian:</strong> dashboard masih memakai password awal <code>123456</code>. Ubah lewat menu Settings.</span>
      <a href="/dashboard/settings#password" class="btn btn-ghost">Ubah Password</a>
    </div>` : ""}
    <div class="topbar">
      <h2>${escapeHtml(title)}</h2>
      <span class="pill pill-success"><span style="width:7px;height:7px;border-radius:50%;background:var(--success);display:inline-block;"></span> Online &middot; Port ${escapeHtml(port)}</span>
    </div>
    ${content}
  </main>
  <script src="/zr-live.js" data-once></script>
  <script data-once>
    window.addEventListener('pageshow', function(event) {
      if (event.persisted) {
        window.location.reload();
      }
    });

    // Tema gelap/terang: pilihan disimpan di localStorage dan dipakai lagi saat muat berikutnya.
    var ZR_THEME_KEY = 'zr-theme';
    function zrCurrentTheme() {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }
    function zrSyncThemeButton() {
      var btn = document.getElementById('theme-toggle');
      if (!btn) return;
      var label = zrCurrentTheme() === 'dark' ? 'Aktifkan tema terang' : 'Aktifkan tema gelap';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    }
    function zrSetTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      try { localStorage.setItem(ZR_THEME_KEY, theme); } catch (e) {}
      zrSyncThemeButton();
    }
    zrSyncThemeButton();
    document.addEventListener('click', function(themeEvent) {
      var toggle = themeEvent.target.closest ? themeEvent.target.closest('#theme-toggle') : null;
      if (!toggle) return;
      zrSetTheme(zrCurrentTheme() === 'dark' ? 'light' : 'dark');
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
    // Delegation supaya tombol dan modal hasil swap tanpa reload tetap berfungsi.
    document.addEventListener('click', function(e) {
      var closer = e.target.closest ? e.target.closest('[data-close-modal]') : null;
      if (closer) { closeModal(closer.getAttribute('data-close-modal')); return; }
      if (e.target.classList && e.target.classList.contains('modal-backdrop')) e.target.classList.remove('open');
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
        btn.textContent = on ? 'Batalkan Pilih' : 'Pilih Model';
      });
    }
    // Inisialisasi ulang setiap kali isi <main> diganti oleh swap tanpa reload.
    function initSelectionUi() {
      document.querySelectorAll('table[data-sync-row]').forEach(function(table) {
        setSelectMode(table, false);
      });
      document.querySelectorAll('input[data-select-all]').forEach(function(all) { syncSelection(all.getAttribute('data-select-all')); });
    }
    if (window.__zrSwapInit) window.__zrSwapInit.push(initSelectionUi);
    initSelectionUi();
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

    // Confirm a bulk action; controls tied with form="..." are part of form.elements.
    function confirmSelected(form, name, label) {
      var n = 0;
      for (var i = 0; i < form.elements.length; i++) {
        var el = form.elements[i];
        if (el.name === name && el.checked) n++;
      }
      return n > 0 && confirm('Hapus ' + n + ' ' + label + '?');
    }

    // Toggle lihat/sembunyi password pada input berkait
    document.addEventListener('click', function(e) {
      var btn = e.target.closest ? e.target.closest('[data-toggle-password]') : null;
      if (!btn) return;
      var targetId = btn.getAttribute('data-toggle-password');
      var wrap = btn.closest('.input-password-wrap');
      var input = (targetId && document.getElementById(targetId)) || (wrap && wrap.querySelector('input'));
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('is-visible', show);
      btn.setAttribute('aria-label', show ? 'Sembunyikan password' : 'Lihat password');
      btn.setAttribute('title', show ? 'Sembunyikan password' : 'Lihat password');
    });
    // Update badge: tanya versi terbaru sekali, 2,5 detik setelah halaman siap
    // supaya render awal tidak menunggu jaringan.
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
