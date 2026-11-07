import test from "node:test";
import assert from "node:assert/strict";
import { initDb } from "../src/db/index.js";
import { app } from "../src/index.js";
import { renderLayout } from "../src/ui/layout.js";

test("responsive layout: shell has drawer toggle, backdrop, and responsive tokens", async () => {
  initDb(":memory:");
  const res = await app.request("/dashboard");
  const html = await res.text();

  // 1. Tombol toggle drawer harus ada dengan kontrol ARIA
  assert.match(html, /class="sidebar-toggle"[^>]*aria-controls="sidebar"/);
  assert.match(html, /id="sidebar-backdrop"/);

  // 2. Token responsif baru
  assert.match(html, /--sidebar-w:\s*256px;/);
  assert.match(html, /--page-pad:\s*clamp\(/);
  assert.match(html, /--content-max:\s*1720px;/);

  // 3. Aturan responsif media queries
  assert.match(html, /@media \(max-width: 768px\)\s*\{[\s\S]*?\.sidebar-toggle\s*\{\s*display:\s*flex;\s*\}/);
  assert.match(html, /@media \(max-width: 768px\)\s*\{[\s\S]*?\.sidebar\s*\{[\s\S]*?transform:\s*translateX\(-100%\);/);
  assert.match(html, /body\.nav-open \.sidebar\s*\{\s*transform:\s*translateX\(0\);/);
  assert.match(html, /@media \(max-width: 640px\)/);
  assert.match(html, /@media \(max-width: 480px\)/);
  assert.match(html, /@media \(max-width: 380px\)/);
});

test("responsive layout: tables and topology maintain horizontal scroll on mobile", async () => {
  initDb(":memory:");
  const usageRes = await app.request("/dashboard/usage");
  const usageHtml = await usageRes.text();

  // Topology wrapper scroll di ponsel
  assert.match(usageHtml, /\.topology-wrap\s*\{\s*overflow-x:\s*auto;\s*-webkit-overflow-scrolling:\s*touch;\s*\}/);
  assert.match(usageHtml, /\.topology-canvas\s*\{\s*min-width:\s*620px;\s*\}/);

  // Tabel memiliki pembungkus overflow-x
  assert.match(usageHtml, /\.card:has\(table\)\s*\{\s*overflow-x:\s*auto;\s*-webkit-overflow-scrolling:\s*touch;\s*\}/);
});

test("responsive layout: combos pane adapts from clamp to 100% on narrow width", async () => {
  initDb(":memory:");
  const combosRes = await app.request("/dashboard/providers?tab=combos");
  const combosHtml = await combosRes.text();

  assert.match(combosHtml, /\.combos-master-pane\s*\{[\s\S]*?clamp\(240px,\s*26vw,\s*340px\)/);
  assert.match(combosHtml, /@media \(max-width: 1080px\)\s*\{[\s\S]*?\.combos-master-pane\s*\{[\s\S]*?width:\s*100%;/);
});

test("responsive layout: script closes drawer on ESC and backdrop click", () => {
  const html = renderLayout({ title: "Test", content: "<div>hello</div>" });
  assert.match(html, /document\.body\.classList\.remove\('nav-open'\)/);
  assert.match(html, /sidebarBackdrop\.addEventListener\('click',\s*closeNav\)/);
});
