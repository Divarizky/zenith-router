import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnections, getModelLockUntil } from "../src/db/index.js";
import { executeWithFallback } from "../src/services/fallback.js";
import { getProvider } from "../src/providers/index.js";
import { BaseExecutor } from "../src/executors/base.js";

const MAX_DISPATCHES = 3;

function attempt(executor) {
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
    requestId: "budget-1",
  });
}

function resetError() {
  const err = new TypeError("fetch failed");
  err.cause = { code: "ECONNRESET" };
  return err;
}

test("dispatch budget - a request never exceeds the shared dispatch cap across accounts and transport retries", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "A", credentials: { api_key: "k1" } });
  addConnection({ provider: "glm", name: "B", credentials: { api_key: "k2" } });
  addConnection({ provider: "glm", name: "C", credentials: { api_key: "k3" } });
  let dispatches = 0;
  const executor = new BaseExecutor({
    fetchFn: async () => {
      dispatches++;
      throw resetError();
    },
  });
  const out = await attempt(executor);
  assert.ok(dispatches <= MAX_DISPATCHES, `dispatch ${dispatches} melewati batas ${MAX_DISPATCHES}`);
  assert.strictEqual(out.ok, false);
});

test("transport health - repeated resets never park the account or lock the model", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "glm", name: "A", credentials: { api_key: "k1" } });
  const executor = new BaseExecutor({
    fetchFn: async () => {
      throw resetError();
    },
  });
  const out = await attempt(executor);
  assert.strictEqual(out.ok, false);
  assert.ok(!(getConnections("glm")[0].cooldown_until > Date.now()), "akun tidak diparkir oleh error transport");
  assert.ok(!(getModelLockUntil(conn.id, "glm-4-flash") > Date.now()), "model tidak dikunci oleh error transport");
});

test("stream sent once - a delivered stream is never dispatched a second time", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "A", credentials: { api_key: "k1" } });
  addConnection({ provider: "glm", name: "B", credentials: { api_key: "k2" } });
  let dispatches = 0;
  const executor = new BaseExecutor({
    fetchFn: async () => {
      dispatches++;
      const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const out = await attempt(executor);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(dispatches, 1, "stream yang sudah dikirim tidak dikirim ulang");
});
