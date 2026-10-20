import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, getDb, addConnection, getConnections, getModelLockUntil } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { setCustomQuotaFetcher } from "../src/services/quota.js";

const FREE_SYNCED = "qwen/qwen3.6-35b-a3b:free";
const FREE_BUILTIN = "qwen/qwen3.6-plus:free";
const FREE_BUILTIN_OTHER = "qwen/qwen3.7-plus:free";
const FREE_SYNCED_PLAIN = "stepfun/step-free-lite";
const PAID = "deepseek/deepseek-v4-pro-0813";

function seedXkiro() {
  initDb(":memory:");
  const c1 = addConnection({ provider: "xkiro", name: "xkiro 1", credentials: { api_key: "key-1" } });
  const c2 = addConnection({ provider: "xkiro", name: "xkiro 2", credentials: { api_key: "key-2" } });
  const insert = getDb().prepare("INSERT INTO synced_models (provider, model_id, name, capabilities, synced_at) VALUES (?, ?, ?, ?, ?)");
  insert.run("xkiro", FREE_SYNCED, "Qwen 35B", null, Date.now());
  insert.run("xkiro", FREE_SYNCED_PLAIN, "Step Lite", null, Date.now());
  return { c1, c2 };
}

function freeScopeRateLimit(headers = {}) {
  return new Response(JSON.stringify({ error: { message: "free quota", type: "rate_limit_error", code: "rate_limit_exceeded" } }), {
    status: 429,
    headers: { "Content-Type": "application/json", "retry-after": "27478", "x-ratelimit-scope": "free", "x-ratelimit-window": "day", ...headers },
  });
}

function okResponse(content = "ok") {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function chat(model) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: `xkiro/${model}`, messages: [{ role: "user", content: "hi" }] }),
  });
}

test("Free tier - 429 scope free mengunci semua model gratis di akun, model berbayar tetap jalan", async () => {
  const { c1, c2 } = seedXkiro();
  const syncedFor = [];
  setCustomQuotaFetcher(async (c) => {
    syncedFor.push(c.id);
    return { provider: "xkiro", unit: "tier", quotas: {} };
  });
  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.authorization;
      attempts.push(auth);
      return auth === "Bearer key-1" ? freeScopeRateLimit() : okResponse("from acc 2");
    },
  });
  try {
    const res = await chat(FREE_BUILTIN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).choices[0].message.content, "from acc 2");
    assert.deepStrictEqual(attempts, ["Bearer key-1", "Bearer key-2"]);

    const acc1 = getConnections("xkiro").find((c) => c.id === c1.id);
    const until = getModelLockUntil(acc1.id, FREE_BUILTIN);
    assert.ok(until > Date.now() + 27_000_000, "model yang dipanggil dikunci sampai reset (retry-after)");
    assert.ok(getModelLockUntil(acc1.id, FREE_SYNCED) > Date.now(), "model gratis hasil sync ikut terkunci");
    assert.ok(getModelLockUntil(acc1.id, FREE_SYNCED_PLAIN) > Date.now(), "model hasil sync tanpa suffix :free ikut terkunci");
    assert.ok(getModelLockUntil(acc1.id, FREE_BUILTIN_OTHER) > Date.now(), "model builtin :free yang tidak dipanggil ikut terkunci");
    assert.strictEqual(getModelLockUntil(acc1.id, PAID), null, "model berbayar tidak ikut terkunci");
    assert.strictEqual(getConnections("xkiro").find((c) => c.id === c2.id).cooldown_until, 0, "akun lain tidak terkena");

    await new Promise((r) => setTimeout(r, 20));
    assert.ok(syncedFor.includes(c1.id), "kuota akun dikirim ulang setelah 429 kuota gratis");
  } finally {
    setCustomExecutor(null);
    setCustomQuotaFetcher(null);
  }
});

test("Free tier - 429 biasa tanpa scope free hanya mengunci model yang dipanggil", async () => {
  seedXkiro();
  const synced = [];
  setCustomQuotaFetcher(async (c) => {
    synced.push(c.id);
    return { provider: "xkiro", unit: "tier", quotas: {} };
  });
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.authorization;
      return auth === "Bearer key-1"
        ? new Response(JSON.stringify({ error: { message: "rpm" } }), { status: 429, headers: { "Content-Type": "application/json", "retry-after": "30" } })
        : okResponse();
    },
  });
  try {
    const res = await chat(FREE_BUILTIN);
    assert.strictEqual(res.status, 200);
    const acc1 = getConnections("xkiro")[0];
    assert.ok(getModelLockUntil(acc1.id, FREE_BUILTIN) > Date.now(), "model yang dipanggil dikunci");
    assert.strictEqual(getModelLockUntil(acc1.id, FREE_SYNCED), null, "model gratis lain tidak ikut terkunci");
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(synced, [], "tidak ada sync kuota tanpa 429 kuota gratis");
  } finally {
    setCustomExecutor(null);
    setCustomQuotaFetcher(null);
  }
});

test("Free tier - scope free tidak berlaku untuk status selain 429", async () => {
  const { c1 } = seedXkiro();
  setCustomQuotaFetcher(async () => ({ provider: "xkiro", unit: "tier", quotas: {} }));
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.authorization;
      return auth === "Bearer key-1"
        ? new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500, headers: { "Content-Type": "application/json", "x-ratelimit-scope": "free" } })
        : okResponse();
    },
  });
  try {
    await chat(FREE_BUILTIN);
    assert.strictEqual(getModelLockUntil(c1.id, FREE_SYNCED), null, "5xx tidak mengunci seluruh free tier");
  } finally {
    setCustomExecutor(null);
    setCustomQuotaFetcher(null);
  }
});
