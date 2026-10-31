import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { renderLayout } from "../src/ui/layout.js";
import { app } from "../src/index.js";

// Ambil nilai rem dari token CSS yang sudah dirender (mis. --text-xs: 0.8rem).
function tokenRem(html, name) {
  const m = html.match(new RegExp(`--${name}:\\s*([0-9.]+)rem;`));
  assert.ok(m, `token --${name} rendered`);
  return Number(m[1]);
}

test("functional text never drops below 0.8rem in rendered CSS", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/usage")).text();
  // Kegagalan yang dicegah: pill, th, dan tombol kecil mengecil di bawah 0.8rem dan
  // sulit dibaca. Pengecualian: panah dekoratif pada banner update (0.65rem).
  const sizes = [...html.matchAll(/font-size:\s*(0?\.\d+)rem/g)]
    .map((m) => Number(m[1]))
    .filter((v) => v < 0.8 && v !== 0.65);
  assert.deepStrictEqual(sizes, [], "no functional font-size below 0.8rem");
});

test("base body text is 1rem with 1.55 line-height", async () => {
  const html = renderLayout({ title: "Uji", content: "" });
  // Kegagalan yang dicegah: teks dasar tetap 0.88rem dan terlalu rapat untuk dibaca.
  assert.strictEqual(tokenRem(html, "text-base"), 1);
  assert.match(html, /--leading:\s*1\.55;/);
});

test("touch targets reach 44px on narrow screens", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard")).text();
  // Kegagalan yang dicegah: tombol kecil sulit disentuh di tablet dan ponsel.
  assert.match(html, /--touch-min:\s*44px;/);
  // Kegagalan yang dicegah: aturan target sentuh tidak aktif di lebar tablet/ponsel.
  assert.match(html, /@media \(max-width: 860px\)\s*\{[\s\S]*?\.btn-sm[^}]*min-height:\s*var\(--touch-min\)/);
});
