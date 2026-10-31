import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { app } from "../src/index.js";

test("dashboard HTML stays small because the logo is not inlined", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard")).text();
  // Kegagalan yang dicegah: logo 1 MB kembali di-inline sebagai base64 dan
  // membuat HTML setiap halaman melewati 300 KB.
  assert.ok(!html.includes("data:image/png;base64"), "no inline base64 logo");
  assert.ok(Buffer.byteLength(html, "utf8") < 300 * 1024, "dashboard HTML under 300 KB");
  assert.ok(html.includes('src="/logo.png"'), "brand image points at the static logo");
});

test("logo is served as a static file with a cache header", async () => {
  const res = await app.request("/logo.png");
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("content-type"), "image/png");
  // Kegagalan yang dicegah: logo diunduh ulang di setiap navigasi karena tanpa cache.
  assert.match(res.headers.get("cache-control") || "", /max-age=\d+/);
});
