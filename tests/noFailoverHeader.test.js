import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { BaseExecutor, setCustomExecutor } from "../src/executors/base.js";
import { initDb, addConnection } from "../src/db/index.js";
import { createCombo } from "../src/services/combos.js";

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const LAN_ENV = { incoming: { socket: { remoteAddress: "192.168.1.50" } } };

// Executor yang merekam setiap upstream call dan selalu gagal dengan 503 agar fallback terpicu.
function failingExecutor() {
  const calls = [];
  setCustomExecutor({
    async execute(opts) {
      calls.push(opts);
      return new Response(JSON.stringify({ error: { message: "down" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return calls;
}

function seed() {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM 1", credentials: { api_key: "key-1" } });
  addConnection({ provider: "glm", name: "GLM 2", credentials: { api_key: "key-2" } });
}

const chatBody = (model) =>
  JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: false });

test("no-failover - loopback dengan header memanggil satu model murni, combo dilewati", async () => {
  seed();
  createCombo({ name: "probe-combo", models: ["glm/glm-4-flash", "glm/glm-4-air"], strategy: "fallback" });
  const calls = failingExecutor();

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-zenith-no-failover": "1" },
    body: chatBody("probe-combo"),
  }, LOOPBACK_ENV);

  assert.strictEqual(res.status, 503, "error upstream diteruskan, bukan dicoba ulang");
  assert.strictEqual(calls.length, 1, "tanpa header combo akan memanggil banyak anggota; di sini hanya satu");
});

test("no-failover - tanpa header combo tetap failover ke anggota berikutnya", async () => {
  seed();
  createCombo({ name: "probe-combo-2", models: ["glm/glm-4-flash", "glm/glm-4-air"], strategy: "fallback" });
  const calls = failingExecutor();

  await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: chatBody("probe-combo-2"),
  }, LOOPBACK_ENV);

  assert.ok(calls.length > 1, `combo tanpa header harus mencoba lebih dari satu anggota, dapat ${calls.length}`);
});

test("no-failover - non-loopback tanpa token admin mengabaikan header", async () => {
  seed();
  createCombo({ name: "probe-combo-3", models: ["glm/glm-4-flash", "glm/glm-4-air"], strategy: "fallback" });
  const calls = failingExecutor();

  await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-zenith-no-failover": "1" },
    body: chatBody("probe-combo-3"),
  }, LAN_ENV);

  assert.ok(calls.length > 1, "header dari LAN tanpa admin tidak boleh mematikan failover");
});

test("no-failover - non-loopback dengan token admin benar mendapat efek header", async () => {
  seed();
  createCombo({ name: "probe-combo-4", models: ["glm/glm-4-flash", "glm/glm-4-air"], strategy: "fallback" });
  const calls = failingExecutor();
  const prev = process.env.ZENITH_ADMIN_TOKEN;
  process.env.ZENITH_ADMIN_TOKEN = "admin-probe-token";
  try {
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-zenith-no-failover": "1", "x-zenith-admin-token": "admin-probe-token" },
      body: chatBody("probe-combo-4"),
    }, LAN_ENV);
  } finally {
    if (prev === undefined) delete process.env.ZENITH_ADMIN_TOKEN;
    else process.env.ZENITH_ADMIN_TOKEN = prev;
  }
  assert.strictEqual(calls.length, 1, "admin terautentikasi dari LAN harus mendapat probing murni");
});

test("no-failover - non-loopback dengan token admin salah tidak mendapat efek header", async () => {
  seed();
  createCombo({ name: "probe-combo-5", models: ["glm/glm-4-flash", "glm/glm-4-air"], strategy: "fallback" });
  const calls = failingExecutor();
  const prev = process.env.ZENITH_ADMIN_TOKEN;
  process.env.ZENITH_ADMIN_TOKEN = "admin-probe-token";
  try {
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-zenith-no-failover": "1", "x-zenith-admin-token": "salah" },
      body: chatBody("probe-combo-5"),
    }, LAN_ENV);
  } finally {
    if (prev === undefined) delete process.env.ZENITH_ADMIN_TOKEN;
    else process.env.ZENITH_ADMIN_TOKEN = prev;
  }
  assert.ok(calls.length > 1, "token admin salah dari LAN tidak boleh mematikan failover");
});
