import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnections, getModelLockUntil } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { executeWithFallback } from "../src/services/fallback.js";
import { getProvider } from "../src/providers/index.js";
import { app } from "../src/index.js";

const failing = () =>
  new Response(JSON.stringify({ error: { message: "upstream exploded" } }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });

const ok = () =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function chat(model = "glm/glm-4-flash") {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

/** One attempt outside the gateway, so the request id can be controlled. */
function attempt(executor, requestId) {
  return executeWithFallback({
    provider: getProvider("glm"),
    targetFormat: "openai",
    upstreamPayload: { model: "glm-4-flash", messages: [{ role: "user", content: "hi" }] },
    baseHeaders: {},
    executor,
    signal: null,
    resolveUrl: () => "http://upstream.test/v1/chat/completions",
    stream: false,
    targetModel: "glm-4-flash",
    requestId,
  });
}

test("cooldown - one failed attempt reports the upstream error and parks nothing", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "key" } });
  setCustomExecutor({ execute: async () => failing() });
  try {
    const res = await chat();
    assert.strictEqual(res.status, 500, "status upstream diteruskan");
    const body = await res.json();
    assert.strictEqual(body.error.message, "upstream exploded");
    assert.ok(!String(body.error.message).includes("cooling down"), "bukan pesan cooldown");
    assert.ok(!(getConnections("glm")[0].cooldown_until > Date.now()), "akun belum diparkir");
    assert.ok(!(getModelLockUntil(conn.id, "glm-4-flash") > Date.now()), "model belum dikunci");
  } finally {
    setCustomExecutor(null);
  }
});

test("cooldown - the second manual attempt parks the account, the third reports the cooldown", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "key" } });
  setCustomExecutor({ execute: async () => failing() });
  try {
    assert.strictEqual((await chat()).status, 500);
    assert.strictEqual((await chat()).status, 500, "percobaan manual kedua juga melihat error asli");
    assert.ok(getModelLockUntil(conn.id, "glm-4-flash") > Date.now(), "kegagalan kedua memarkir akun");

    const res = await chat();
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.strictEqual(body.error.code, "no_available_connection");
    assert.match(body.error.message, /All accounts are cooling down/);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
  } finally {
    setCustomExecutor(null);
  }
});

test("cooldown - retries inside one request count as a single attempt", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "key" } });
  const executor = { execute: async () => failing() };
  try {
    // Combo members and failover rounds reuse the request id of the client call.
    await attempt(executor, "request-a");
    await attempt(executor, "request-a");
    await attempt(executor, "request-a");
    assert.ok(!(getModelLockUntil(conn.id, "glm-4-flash") > Date.now()), "tiga retry sistem tetap satu percobaan");

    await attempt(executor, "request-b");
    assert.ok(getModelLockUntil(conn.id, "glm-4-flash") > Date.now(), "request manual kedua memarkir akun");
  } finally {
    setCustomExecutor(null);
  }
});

test("cooldown - a success in between resets the streak", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "key" } });
  let mode = "fail";
  const executor = {
    execute: async () => (mode === "fail" ? failing() : ok()),
  };
  try {
    await attempt(executor, "request-a");
    mode = "ok";
    await attempt(executor, "request-b");
    mode = "fail";
    await attempt(executor, "request-c");
    assert.ok(!(getModelLockUntil(conn.id, "glm-4-flash") > Date.now()), "streak direset oleh keberhasilan");
  } finally {
    setCustomExecutor(null);
  }
});

test("cooldown - auth failures follow the same two-attempt rule", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "key" } });
  setCustomExecutor({
    execute: async () =>
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
  });
  try {
    assert.strictEqual((await chat()).status, 401);
    assert.ok(!(getConnections("glm")[0].cooldown_until > Date.now()), "401 pertama belum memarkir akun");
    assert.strictEqual((await chat()).status, 401);
    assert.ok(getConnections("glm")[0].cooldown_until > Date.now(), "401 kedua memarkir akun");
    assert.strictEqual((await chat()).status, 503);
    assert.ok(conn.id);
  } finally {
    setCustomExecutor(null);
  }
});
