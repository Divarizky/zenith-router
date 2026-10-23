import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { app } from "../src/index.js";
import { BaseExecutor, setCustomExecutor } from "../src/executors/base.js";
import { initDb, addConnection, getConnections, getModelLockUntil } from "../src/db/index.js";
import { isConnectionInCooldown } from "../src/services/auth.js";
import { clearConsoleLogs, getConsoleLogs } from "../src/services/logger.js";

const MODEL_ID = "mistral-large-latest";
const URL_DEMO = "https://api.example.test/v1/chat/completions";
const BODY = JSON.stringify({ model: "m", messages: [] });

function resetError(code = "ECONNRESET") {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`read ${code}`), { code, syscall: "read" }) });
}

function dnsError() {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.test"), { code: "ENOTFOUND", syscall: "getaddrinfo" }),
  });
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1/chat` };
}

test("transport - a socket the upstream closed while idle is retried once and succeeds", async () => {
  let hits = 0;
  const { server, url } = await startServer((req, res) => {
    hits++;
    // Mimic an idle keep-alive socket the upstream dropped: the first request is cut before any reply.
    if (hits === 1) return req.socket.destroy();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  try {
    const executor = new BaseExecutor();
    const res = await executor.execute({ url, body: BODY });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), '{"ok":true}');
    assert.strictEqual(hits, 2, "satu percobaan gagal, satu retry berhasil");
  } finally {
    server.close();
  }
});

test("transport - two resets in a row give up after one retry", async () => {
  const calls = [];
  const executor = new BaseExecutor({
    fetchFn: async (url, init) => {
      calls.push(init.body);
      throw resetError();
    },
  });
  const res = await executor.execute({ url: URL_DEMO, body: BODY });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(res.status, 502);
  assert.strictEqual((await res.json()).error.type, "transport_error");
});

test("transport - DNS failures are not retried and the message names the step and host", async () => {
  let calls = 0;
  const executor = new BaseExecutor({
    fetchFn: async () => {
      calls++;
      throw dnsError();
    },
  });
  const res = await executor.execute({ url: URL_DEMO, body: BODY });
  assert.strictEqual(calls, 1, "DNS tidak diulang");
  assert.strictEqual(res.status, 502);
  const { error } = await res.json();
  assert.match(error.message, /ENOTFOUND getaddrinfo/);
  assert.match(error.message, /host=api\.example\.test/);
  assert.doesNotMatch(error.message, /undefined/);
});

test("transport - a stream body is never sent twice", async () => {
  let calls = 0;
  const executor = new BaseExecutor({
    fetchFn: async () => {
      calls++;
      throw resetError();
    },
  });
  const res = await executor.execute({ url: URL_DEMO, body: new Uint8Array([123, 125]) });
  assert.strictEqual(calls, 1);
  assert.strictEqual(res.status, 502);
});

test("transport - a string abort reason is reported as text, not as undefined", async () => {
  const executor = new BaseExecutor({
    fetchFn: async () => {
      throw "upstream reset by peer";
    },
  });
  const res = await executor.execute({ url: URL_DEMO, body: BODY });
  assert.strictEqual(res.status, 502);
  assert.match((await res.json()).error.message, /upstream reset by peer/);
});

test("transport - a client that hung up gets 499 client_closed and is not reported as upstream failure", async () => {
  let calls = 0;
  const client = new AbortController();
  client.abort("Client connection prematurely closed.");
  const executor = new BaseExecutor({
    fetchFn: async () => {
      calls++;
      throw "Client connection prematurely closed.";
    },
  });
  const res = await executor.execute({ url: URL_DEMO, body: BODY, signal: client.signal });
  assert.strictEqual(calls, 1, "tidak ada retry untuk klien yang sudah pergi");
  assert.strictEqual(res.status, 499);
  assert.strictEqual((await res.json()).error.type, "client_closed");
});

test("fallback - a transport failure leaves the account usable", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  setCustomExecutor({
    async execute() {
      return new Response(
        JSON.stringify({ error: { message: "Upstream transport failed: fetch failed", type: "transport_error", code: "bad_gateway" } }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    },
  });
  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mistral/mistral-large-latest", messages: [{ role: "user", content: "halo" }] }),
    });
    assert.strictEqual(res.status, 502);
    const [conn] = getConnections("mistral");
    assert.strictEqual(isConnectionInCooldown(conn, MODEL_ID), false, "kegagalan jaringan tidak mengunci model");
    assert.strictEqual(getModelLockUntil(conn.id, MODEL_ID), null);
  } finally {
    setCustomExecutor(null);
  }
});

test("fallback - a 502 that is not a transport failure still cools the account down", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  setCustomExecutor({
    async execute() {
      return new Response(JSON.stringify({ error: { message: "bad gateway from upstream", type: "upstream_error" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const chat = () =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mistral/mistral-large-latest", messages: [{ role: "user", content: "halo" }] }),
    });
  try {
    await chat();
    assert.strictEqual(getConnections("mistral")[0].cooldown_until > Date.now(), false, "satu 502 belum memarkir akun");
    // A second manual attempt is what parks the account.
    await chat();
    const [conn] = getConnections("mistral");
    assert.strictEqual(isConnectionInCooldown(conn, MODEL_ID), true);
  } finally {
    setCustomExecutor(null);
  }
});

test("fallback - a client that hung up is not logged as a failover nor cools the account", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  clearConsoleLogs();
  const client = new AbortController();
  setCustomExecutor({
    async execute() {
      // The browser or agent closes the socket while upstream is still working.
      client.abort("Client connection prematurely closed.");
      return new Response(JSON.stringify({ error: { message: "Client closed the request before upstream responded", type: "client_closed" } }), {
        status: 499,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  try {
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mistral/mistral-large-latest", messages: [{ role: "user", content: "halo" }] }),
      signal: client.signal,
    });
    const [conn] = getConnections("mistral");
    assert.strictEqual(isConnectionInCooldown(conn, MODEL_ID), false);
    const lines = getConsoleLogs().map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)));
    assert.strictEqual(lines.filter((line) => line.includes("[FAILOVER]")).length, 0);
  } finally {
    setCustomExecutor(null);
  }
});
