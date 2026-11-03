import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { app } from "../src/index.js";

const NAV_LABELS = [
  "Overview",
  "Providers & Combos",
  "Proxy Pools",
  "Usage & Quota",
  "API Keys",
  "Settings",
];

function navHtml(html) {
  const start = html.indexOf("<nav");
  const end = html.indexOf("</nav>", start);
  assert.ok(start !== -1 && end !== -1, "dashboard renders a <nav> element");
  return html.slice(start, end);
}

test("nav renders all 6 items so none is cut off at any width", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard")).text();
  const nav = navHtml(html);
  // Kegagalan yang dicegah: menu terpotong karena salah satu item hilang dari markup.
  for (const label of NAV_LABELS) {
    assert.ok(nav.includes(`<span>${label}</span>`), `missing nav item ${label}`);
  }
  assert.strictEqual((nav.match(/class="nav-link/g) || []).length, 6);
});

test("nav has an accessible name and marks only the active item with aria-current", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/keys")).text();
  const nav = navHtml(html);
  // Kegagalan yang dicegah: pengguna screen reader tidak tahu landmark navigasi
  // atau halaman mana yang sedang dibuka.
  assert.ok(/<nav[^>]*aria-label="[^"]+"/.test(nav), "nav has aria-label");
  const current = nav.match(/<a [^>]*aria-current="page"[^>]*>/g) || [];
  assert.strictEqual(current.length, 1, "exactly one aria-current item");
  assert.ok(current[0].includes('href="/dashboard/keys"'), "aria-current sits on the API Keys link");
});
