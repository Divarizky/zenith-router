import test from "node:test";
import assert from "node:assert";
import os from "node:os";
import { initDb } from "../src/db/index.js";
import { app } from "../src/index.js";

test("provider icons resolve from any working directory", async (t) => {
  const originalCwd = process.cwd();
  t.after(() => process.chdir(originalCwd));
  // The global `zenith` shim starts the server from the caller's directory, so
  // static assets must not depend on cwd.
  process.chdir(os.tmpdir());

  const ok = await app.request("/providers/claude.png");
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.headers.get("content-type")?.includes("image/png"));

  const missing = await app.request("/providers/does-not-exist.png");
  assert.strictEqual(missing.status, 404);

  const logo = await app.request("/logo.png");
  assert.strictEqual(logo.status, 200);
});

test("usage page ships icon URLs for linked providers", async () => {
  const res = await app.request("/dashboard/usage");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("/providers/"));
});

test("providers list and detail render a brand icon for every provider", async () => {
  initDb(":memory:");
  const { getAllProviders } = await import("../src/providers/index.js");
  const providers = getAllProviders();

  const list = await app.request("/dashboard/providers");
  assert.strictEqual(list.status, 200);
  const html = await list.text();
  for (const p of providers) {
    assert.ok(html.includes(`src="/providers/${p.id}.png"`), `missing icon for ${p.id}`);
    assert.ok(html.includes(`href="/dashboard/providers/${p.id}"`), `missing card for ${p.id}`);
  }

  const detail = await app.request(`/dashboard/providers/${providers[0].id}`);
  assert.strictEqual(detail.status, 200);
  const detailHtml = await detail.text();
  assert.ok(detailHtml.includes(`src="/providers/${providers[0].id}.png"`));
  assert.ok(detailHtml.includes("provider-icon-fb"));
});
