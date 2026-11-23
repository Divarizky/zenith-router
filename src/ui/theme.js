// Token desain bersama untuk layout dashboard dan halaman login.
// Tema terang adalah :root, tema gelap memakai [data-theme="dark"].
export const THEME_TOKENS_CSS = `
:root {
  --bg: #fafafa;
  --surface: #fafafa;
  --surface-2: #f0f0f0;
  --surface-3: #e2e2e2;
  --border: #000000;
  --border-subtle: #636363;
  --text: #0a0a0a;
  --text-muted: #262626;
  --text-subtle: #636363;
  --accent: #2563eb;
  --accent-hover: #1d4ed8;
  --accent-soft: rgba(37, 99, 235, 0.16);
  --accent-lime: #ccff00;
  --accent-lime-hover: #bbf400;
  --accent-pink: #ffb3d9;
  --accent-pink-hover: #fa92c7;
  --accent-pink-soft: rgba(255, 179, 217, 0.25);
  --success: #6ee7b7;
  --warning: #fde047;
  --danger: #ef4444;
  --danger-hover: #dc2626;
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
  --hard: 4px 4px 0 var(--shadow-ink);
  --hard-sm: 3px 3px 0 var(--shadow-ink);
  --hard-lg: 8px 8px 0 var(--shadow-ink);
  --grid-line: rgba(10, 10, 10, 0.045);
  --outline-green: #15803d;
  --link: #0369a1;
  --link-hover: #025e8a;
  --focus-ring: #0a0a0a;
  --icon-reasoning: #db2777;
  --icon-vision: #0284c7;
  --bg-hover: #f0f0f0;
}

/* ===== Tema gelap (Obsidian Neo-Brutalism) =====
   Bayangan tetap hitam pekat untuk kedalaman taktil fisik tanpa silau putih.
   Border menggunakan slate terukur agar mata tidak cepat lelah saat sesi panjang.
   Aksen pastel sengaja tetap terang, teks di atas aksen tetap hitam. */
[data-theme="dark"] {
  --bg: #0c0d10;
  --surface: #15161a;
  --surface-2: #1e2026;
  --surface-3: #282a33;
  --border: #71717a;
  --border-subtle: #383842;
  --text: #f4f4f6;
  --text-muted: #cfcfd6;
  --text-subtle: #9a9aa6;
  --accent: #3b82f6;
  --accent-hover: #60a5fa;
  --accent-soft: rgba(59, 130, 246, 0.18);
  --accent-lime: #ccff00;
  --accent-lime-hover: #bbf400;
  --accent-pink: #ffb3d9;
  --accent-pink-hover: #fa92c7;
  --accent-pink-soft: rgba(255, 179, 217, 0.18);
  --success: #34d399;
  --warning: #facc15;
  --danger: #ef4444;
  --danger-hover: #dc2626;
  --info: #38bdf8;
  --shadow-ink: #000000;
  --line: #71717a;
  --logo-tile: #15161a;
  --logo-tile-line: #71717a;
  --focus-ring: #ccff00;
  --traffic: #38bdf8;
  --traffic-soft: rgba(56, 189, 248, 0.2);
  --traffic-core: #0c0d10;
  --hard: 4px 4px 0 var(--shadow-ink);
  --hard-sm: 2px 2px 0 var(--shadow-ink);
  --hard-lg: 6px 6px 0 var(--shadow-ink);
  --grid-line: rgba(255, 255, 255, 0.04);
  --outline-green: #22c55e;
  --link: #38bdf8;
  --link-hover: #7dd3fc;
  --icon-reasoning: #f472b6;
  --icon-vision: #38bdf8;
  --bg-hover: #1e2026;
}
`;

export const LAYOUT_TOKENS_CSS = `
:root {
  /* Skala teks: teks fungsional tidak turun di bawah 0.8rem. */
  --text-xs: 0.8rem;
  --text-sm: 0.9rem;
  --text-base: 1rem;
  --text-md: 1.05rem;
  --text-lg: 1.2rem;
  --text-xl: 1.5rem;
  /* Skala jarak: dipakai kartu, sel tabel, tombol, dan jarak antar bagian. */
  --space-1: 0.35rem;
  --space-2: 0.8rem;
  --space-3: 1.1rem;
  --space-4: 1.6rem;
  /* Padding tombol: naik sekitar 30% dari 0.45rem 0.9rem. */
  --btn-pad-y: 0.6rem;
  --btn-pad-x: 1.1rem;
  --space-5: 1.75rem;
  --leading: 1.55;
  /* Target sentuh minimal 44x44 px pada layar sempit. */
  --touch-min: 44px;
  /* Shell responsif: lebar sidebar, padding halaman, dan batas konten di layar ultrawide. */
  --sidebar-w: 256px;
  --page-pad: clamp(0.9rem, 0.6rem + 1.1vw, 2.25rem);
  --content-max: 1720px;
}
`;
