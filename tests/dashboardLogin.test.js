import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { setLoginRequired } from "../src/services/dashboardAuth.js";
import { renderDashboardLoginPage } from "../src/ui/pages/login.js";
import { app } from "../src/index.js";

const remote = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

test("login page shows the initial password 123456 while it is still the default", async (t) => {
  initDb(":memory:");
  setLoginRequired(true);
  t.after(() => setLoginRequired(false));
  const res = await app.request("/dashboard/login", { headers: { Accept: "text/html" } }, remote);
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  // Kegagalan yang dicegah: password awal hilang dari halaman login sehingga pengguna tidak bisa masuk.
  assert.ok(html.includes("<code>123456</code>"), "initial password visible on login");
});

test("login page uses the shared theme tokens instead of its own palette", () => {
  const html = renderDashboardLoginPage({});
  // Kegagalan yang dicegah: login memakai palet sendiri, jadi tidak mengikuti tema dashboard.
  // Blok token bersama memuat tema terang (:root) dan gelap ([data-theme="dark"]).
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  assert.ok(css.includes("--shadow-ink:"), "shared token block rendered");
  assert.ok(css.includes('[data-theme="dark"]'), "dark theme block rendered");
  assert.ok(!css.includes("--bg: #0a0a0a;"), "standalone login palette is gone");
});

test("login card keeps a visible hard shadow in both themes", () => {
  const html = renderDashboardLoginPage({});
  // Kegagalan yang dicegah: bayangan login berwarna gelap dan hilang di tema gelap.
  const dark = html.slice(html.indexOf('[data-theme="dark"] {'));
  assert.match(dark.slice(0, dark.indexOf("}")), /--shadow-ink:\s*#f4f4f7/);
});
