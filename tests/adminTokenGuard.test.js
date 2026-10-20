import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { getSetting, setSetting } from "../src/services/settings.js";
import { createApiKey } from "../src/services/apiKeys.js";
import { setCustomExecutor } from "../src/executors/base.js";

const ADMIN_TOKEN = "admin-sekret-123";
const JSON_HEADERS = { "Content-Type": "application/json" };

function withEnv(vars, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

const protectedEnv = (fn) => withEnv({ ZENITH_ADMIN_TOKEN: ADMIN_TOKEN }, fn);

function form(fields) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
  return body;
}

const remote = (address) => ({ incoming: { socket: { remoteAddress: address } } });

function captureExecutor() {
  const calls = [];
  setCustomExecutor({
    async execute(opts) {
      calls.push(opts);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return calls;
}

test("admin token - tanpa ZENITH_ADMIN_TOKEN control plane tetap terbuka dari loopback", async () => {
  initDb(":memory:");
  await withEnv({ ZENITH_ADMIN_TOKEN: null }, async () => {
    assert.strictEqual((await app.request("/dashboard")).status, 200);
    assert.strictEqual((await app.request("/api/usage")).status, 200);
    assert.strictEqual((await app.request("/")).status, 200);
  });
});

test("admin token - tanpa token admin semua path control plane ditolak 403", async () => {
  initDb(":memory:");
  await protectedEnv(async () => {
    for (const path of ["/", "/dashboard", "/api/usage", "/callback"]) {
      assert.strictEqual((await app.request(path)).status, 403, path);
    }
    const post = await app.request("/dashboard/settings", { method: "POST", body: form({ require_api_key: "true" }) });
    assert.strictEqual(post.status, 403);
    assert.strictEqual(getSetting("require_api_key", "false"), "false", "aksi admin tidak boleh berjalan");
  });
});

test("admin token - navigasi browser mendapat form login, request API tetap 403 polos", async () => {
  initDb(":memory:");
  await protectedEnv(async () => {
    const browser = await app.request("/dashboard", { headers: { Accept: "text/html,application/xhtml+xml" } });
    assert.strictEqual(browser.status, 403);
    const html = await browser.text();
    assert.ok(html.includes('action="/dashboard/login"'));
    assert.ok(html.includes('name="token"'));
    assert.ok(html.includes('value="/dashboard"'));

    const callback = await app.request("/callback?code=x&state=y", { headers: { Accept: "text/html" } });
    assert.strictEqual(callback.status, 403);
    assert.ok((await callback.text()).includes('value="/callback?code=x&amp;state=y"'), "tujuan kembali membawa query OAuth");

    const api = await app.request("/api/usage", { headers: { Accept: "application/json" } });
    assert.strictEqual(api.status, 403);
    assert.strictEqual(await api.text(), "Forbidden");
  });
});

test("admin token - header x-zenith-admin-token dan Bearer diterima", async () => {
  initDb(":memory:");
  await protectedEnv(async () => {
    const viaHeader = await app.request("/api/usage", { headers: { "x-zenith-admin-token": ADMIN_TOKEN } });
    assert.strictEqual(viaHeader.status, 200);
    const viaBearer = await app.request("/dashboard", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
    assert.strictEqual(viaBearer.status, 200);
    const wrong = await app.request("/dashboard", { headers: { "x-zenith-admin-token": "salah" } });
    assert.strictEqual(wrong.status, 403);
  });
});

test("admin token - cookie sesi dashboard diterima", async () => {
  initDb(":memory:");
  await protectedEnv(async () => {
    const res = await app.request("/dashboard", { headers: { Cookie: `zenith_admin_token=${ADMIN_TOKEN}` } });
    assert.strictEqual(res.status, 200);
    const wrongCookie = await app.request("/dashboard", { headers: { Cookie: "zenith_admin_token=bukan-token" } });
    assert.strictEqual(wrongCookie.status, 403);
  });
});

test("admin token - key gateway zr_ saja tidak membuka /api atau /dashboard", async () => {
  initDb(":memory:");
  await protectedEnv(async () => {
    const created = createApiKey("Hermes Agent");
    const asBearer = await app.request("/api/usage", { headers: { Authorization: `Bearer ${created.key}` } });
    assert.strictEqual(asBearer.status, 403);
    const asApiKey = await app.request("/dashboard", { headers: { "x-api-key": created.key } });
    assert.strictEqual(asApiKey.status, 403);

    const withAdmin = await app.request("/api/usage", {
      headers: { Authorization: `Bearer ${created.key}`, "x-zenith-admin-token": ADMIN_TOKEN },
    });
    assert.strictEqual(withAdmin.status, 200, "token admin tetap menentukan akses control plane");
  });
});

test("admin token - /v1 dan /health tidak terganggu oleh proteksi admin", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "k" } });
  captureExecutor();
  const chatBody = JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] });

  await protectedEnv(async () => {
    // Data plane tidak butuh token admin, cukup mekanisme gatewayAuth yang lama.
    assert.strictEqual((await app.request("/health")).status, 200);
    assert.strictEqual((await app.request("/v1/models")).status, 200);

    setSetting("require_api_key", "true");
    const created = createApiKey("Coding Agent");
    const withoutKey = await app.request("/v1/chat/completions", { method: "POST", headers: JSON_HEADERS, body: chatBody });
    assert.strictEqual(withoutKey.status, 401, "gatewayAuth tetap berlaku di /v1");

    const withKey = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${created.key}` },
      body: chatBody,
    });
    assert.strictEqual(withKey.status, 200, "client inferensi tidak perlu token admin");
  });
});

test("admin token - cek loopback tetap berlaku walau token benar", async () => {
  initDb(":memory:");
  await protectedEnv(async () => {
    const res = await app.request("/dashboard", { headers: { "x-zenith-admin-token": ADMIN_TOKEN } }, remote("192.168.1.20"));
    assert.strictEqual(res.status, 403);
  });
});

test("admin token - login memasang cookie dan kembali ke tujuan yang diminta", async () => {
  initDb(":memory:");
  await protectedEnv(async () => {
    const wrong = await app.request("/dashboard/login", {
      method: "POST",
      body: form({ token: "salah", next: "/dashboard/usage" }),
    });
    assert.strictEqual(wrong.status, 403);
    assert.ok((await wrong.text()).includes("Token admin salah"));
    assert.strictEqual(wrong.headers.get("set-cookie"), null, "token salah tidak boleh memasang cookie");

    const ok = await app.request("/dashboard/login", {
      method: "POST",
      body: form({ token: ADMIN_TOKEN, next: "/dashboard/usage?tab=x" }),
    });
    assert.strictEqual(ok.status, 302);
    assert.strictEqual(ok.headers.get("location"), "/dashboard/usage?tab=x");
    const cookie = ok.headers.get("set-cookie");
    assert.ok(cookie.includes(`zenith_admin_token=${ADMIN_TOKEN}`));
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("SameSite=Lax"));

    const follow = await app.request("/dashboard/usage?tab=x", { headers: { Cookie: `zenith_admin_token=${ADMIN_TOKEN}` } });
    assert.strictEqual(follow.status, 200);
  });
});

test("admin token - login menolak redirect ke host lain", async () => {
  initDb(":memory:");
  await protectedEnv(async () => {
    for (const next of ["//evil.example", "/\\evil.example", "https://evil.example", ""]) {
      const res = await app.request("/dashboard/login", {
        method: "POST",
        body: form({ token: ADMIN_TOKEN, next }),
      });
      assert.strictEqual(res.status, 302, next);
      assert.strictEqual(res.headers.get("location"), "/dashboard", `next ${JSON.stringify(next)} harus dibuang`);
    }
  });
});

test("admin token - logout mencabut cookie lalu akses kembali ditolak", async () => {
  initDb(":memory:");
  await protectedEnv(async () => {
    const logout = await app.request("/dashboard/logout", {
      method: "POST",
      headers: { Cookie: `zenith_admin_token=${ADMIN_TOKEN}` },
    });
    assert.strictEqual(logout.status, 302);
    assert.ok(logout.headers.get("set-cookie").includes("Max-Age=0"));

    assert.strictEqual((await app.request("/dashboard")).status, 403);

    const loginPage = await app.request("/dashboard/login");
    assert.strictEqual(loginPage.status, 200);
    assert.ok((await loginPage.text()).includes('action="/dashboard/login"'));

    const alreadyLoggedIn = await app.request("/dashboard/login", {
      headers: { Cookie: `zenith_admin_token=${ADMIN_TOKEN}` },
    });
    assert.strictEqual(alreadyLoggedIn.status, 302);
    assert.strictEqual(alreadyLoggedIn.headers.get("location"), "/dashboard");
  });
});

test("admin token - login page saat proteksi nonaktif langsung ke dashboard", async () => {
  initDb(":memory:");
  await withEnv({ ZENITH_ADMIN_TOKEN: null }, async () => {
    const res = await app.request("/dashboard/login");
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/dashboard");
  });
});
