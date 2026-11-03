import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { app } from "../src/index.js";
import pkg from "../package.json" with { type: "json" };

test("GET /health - reports the version from package.json", async () => {
  initDb(":memory:");

  const res = await app.request("/health");
  assert.strictEqual(res.status, 200);

  const json = await res.json();
  assert.strictEqual(json.status, "ok");
  assert.strictEqual(json.service, "zenith-router");
  assert.strictEqual(json.version, pkg.version, "health version follows package.json");
});

test("GET /dashboard - sidebar version follows package.json", async () => {
  initDb(":memory:");

  const html = await (await app.request("/dashboard")).text();
  assert.ok(html.includes(`<small>v${pkg.version}</small>`));
});

test("GET /dashboard - returns Overview HTML page with tabs and status", async () => {
  initDb(":memory:");

  addConnection({
    provider: "glm",
    name: "GLM User",
    credentials: { api_key: "k1" },
  });

  const res = await app.request("/dashboard");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("Zenith Router"));
  assert.ok(html.includes("Overview"));
  assert.ok(html.includes("Providers"));
  assert.ok(html.includes("Usage & Quota"));
  assert.ok(html.includes("Settings"));
  assert.ok(html.includes("20120"));
  assert.ok(html.includes("Koneksi Aktif"));
  assert.ok(html.includes("Console Log"));
  assert.ok(html.includes("console-terminal"));
});

test("GET /dashboard - renders vertical neo-brutalist sidebar shell and main header", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard");
  assert.strictEqual(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes('class="app-shell"'), "app-shell wrapper exists");
  assert.ok(html.includes('class="sidebar"'), "sidebar container exists");
  assert.ok(html.includes("ZENITH ROUTER"), "sidebar contains ZENITH ROUTER brand");
  assert.ok(html.includes('class="sidebar-nav"'), "sidebar contains sidebar-nav");
  assert.ok(html.includes('class="sidebar-footer"'), "sidebar contains sidebar-footer");
  assert.ok(html.includes('id="theme-toggle"'), "sidebar footer has theme toggle button");
  assert.ok(html.includes('action="/dashboard/logout"'), "sidebar footer has logout action");
  assert.ok(html.includes('class="main-header"'), "main header exists");
  assert.ok(html.includes('class="crumb"'), "main header contains breadcrumb");
});

test("GET /dashboard - renders asymmetric bento HUD with 4 stat cards, endpoints, combos, and console", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard");
  assert.strictEqual(res.status, 200);
  const html = await res.text();

  // 4 Top Metrics with 01, 02, 03, 04
  assert.ok(html.includes('<span class="stat-index">01</span>'), "KPI stat 01 exists");
  assert.ok(html.includes('<span class="stat-index">02</span>'), "KPI stat 02 exists");
  assert.ok(html.includes('<span class="stat-index">03</span>'), "KPI stat 03 exists");
  assert.ok(html.includes('<span class="stat-index">04</span>'), "KPI stat 04 exists");

  // Bento split grid
  assert.ok(html.includes('class="bento-split-grid"'), "bento-split-grid container exists");

  // Left column: Client Integration Endpoints
  assert.ok(html.includes("Client Integration Endpoints"), "endpoints card header exists");
  assert.ok(html.includes("/v1/chat/completions"), "chat completions endpoint exists");
  assert.ok(html.includes("/v1/messages"), "claude messages endpoint exists");
  assert.ok(html.includes("/v1/responses"), "responses endpoint exists");
  assert.ok(html.includes("/v1/models"), "models endpoint exists");
  assert.ok(html.includes("method-post"), "POST method tag exists");
  assert.ok(html.includes("method-get"), "GET method tag exists");
  assert.ok(html.includes("copyEndpoint(this,"), "copy-to-clipboard buttons exist");

  // Right column: Managed Super-Combos widget
  assert.ok(html.includes("Managed Super-Combos"), "managed super-combos card header exists");
  assert.ok(html.includes("100% Free Tier"), "100% Free Tier badge exists");
  assert.ok(html.includes("zenith-smart"), "zenith-smart tier exists");
  assert.ok(html.includes("zenith-fast"), "zenith-fast tier exists");
  assert.ok(html.includes("zenith-free"), "zenith-free tier exists");

  // Bottom section: Console log terminal
  assert.ok(html.includes("window-header-blue"), "console header has window-header-blue");
  assert.ok(html.includes('id="log-filter"'), "log filter input exists");
  assert.ok(html.includes('id="log-autoscroll"'), "auto-scroll checkbox exists");
  assert.ok(html.includes("clearLogs()"), "clear logs button exists");
});

test("GET / - redirects or renders dashboard overview", async () => {
  initDb(":memory:");

  const res = await app.request("/");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("Zenith Router"));
});
