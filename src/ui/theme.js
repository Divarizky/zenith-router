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

/* ===== Tema gelap =====
   Token dibalik: latar gelap, teks terang, garis & bayangan keras terang.
   Aksen pastel sengaja tetap terang, jadi teks di atasnya tetap hitam. */
[data-theme="dark"] {
  --bg: #101013;
  --surface: #17171b;
  --surface-2: #202027;
  --surface-3: #2b2b34;
  --border: #ffffff;
  --border-subtle: #9a9aa6;
  --text: #f4f4f7;
  --text-muted: #cfcfd6;
  --text-subtle: #9a9aa6;
  --accent-soft: rgba(37, 99, 235, 0.28);
  --accent-lime: #ccff00;
  --accent-lime-hover: #bbf400;
  --accent-pink-soft: rgba(255, 179, 217, 0.18);
  --success: #34d399;
  --warning: #facc15;
  --danger: #ef4444;
  --danger-hover: #dc2626;
  --info: #38bdf8;
  --shadow-ink: #f4f4f7;
  --line: #f4f4f7;
  --logo-tile: #ffffff;
  --logo-tile-line: #f4f4f7;
  --focus-ring: #f4f4f7;
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
