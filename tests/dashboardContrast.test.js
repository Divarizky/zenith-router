import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { app } from "../src/index.js";

// WCAG 2.x relative luminance dan rasio kontras, dihitung langsung dari hex.
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Ambil nilai token dari blok :root atau [data-theme="dark"] pada HTML terender.
function tokens(html, selector) {
  const start = html.indexOf(selector);
  assert.ok(start !== -1, `block ${selector} rendered`);
  const block = html.slice(start, html.indexOf("}", start));
  const out = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}

test("light theme: link and subtle text reach 4.5:1 on every surface they sit on", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard")).text();
  const t = tokens(html, ":root {");
  // Kegagalan yang dicegah: teks link dan subtle terlalu pudar (sebelumnya 3.92 dan 4.16).
  for (const surface of ["bg", "surface-2", "surface-3"]) {
    assert.ok(contrast(t.link, t[surface]) >= 4.5, `link on ${surface} = ${contrast(t.link, t[surface]).toFixed(2)}`);
    assert.ok(contrast(t["text-subtle"], t[surface]) >= 4.5, `text-subtle on ${surface} = ${contrast(t["text-subtle"], t[surface]).toFixed(2)}`);
  }
});

test("dark theme: borders and hard shadows reach 3:1 against the background", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard")).text();
  const t = tokens(html, '[data-theme="dark"] {');
  // Kegagalan yang dicegah: garis dan bayangan gelap menyatu dengan latar (sebelumnya 1.69 dan 2.88).
  assert.ok(contrast(t["shadow-ink"], t.bg) >= 3, `shadow-ink on bg = ${contrast(t["shadow-ink"], t.bg).toFixed(2)}`);
  assert.ok(contrast(t.border, t.bg) >= 3, `border on bg = ${contrast(t.border, t.bg).toFixed(2)}`);
  assert.ok(contrast(t.line, t.bg) >= 3, `line on bg = ${contrast(t.line, t.bg).toFixed(2)}`);
});

test("dark theme: keeps the surface darker than the text it carries", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard")).text();
  const t = tokens(html, '[data-theme="dark"] {');
  // Kegagalan yang dicegah: perubahan garis ke terang ikut menggelapkan teks, bukan permukaan.
  assert.ok(contrast(t.text, t.surface) >= 4.5, `text on surface = ${contrast(t.text, t.surface).toFixed(2)}`);
  assert.ok(contrast(t["text-subtle"], t.surface) >= 4.5, `text-subtle on surface = ${contrast(t["text-subtle"], t.surface).toFixed(2)}`);
});

test("focus ring token is a 3px visible outline on both themes", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard")).text();
  const light = tokens(html, ":root {");
  const dark = tokens(html, '[data-theme="dark"] {');
  // Kegagalan yang dicegah: fokus keyboard tidak terlihat (outline hilang atau menyatu dengan latar).
  assert.ok(contrast(light["focus-ring"], light.bg) >= 3, "focus ring visible on light");
  assert.ok(contrast(dark["focus-ring"], dark.bg) >= 3, "focus ring visible on dark");
});
