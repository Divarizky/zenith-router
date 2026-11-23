import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";
import { addConnection, getModelLockDetails, getModelLockUntil } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { setSetting } from "../src/services/settings.js";
import { clearConsoleLogs, getConsoleLogs } from "../src/services/logger.js";

const NOUS_URL = "inference-api.nousresearch.com";
const GLM_URL = "api.z.ai";
const NOUS_MODEL = "nous/qwen/qwen4-max:free";

function request(model = NOUS_MODEL, stream = false) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "uji" }] }),
  });
}

function ok(text) {
  return Response.json({
    id: "chatcmpl_test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

function nousFairShare(retryAfter = 9) {
  return Response.json(
    {
      status: 429,
      message: "You've reached this model's current fair-share rate limit.",
      reason: "rate_limited",
      retry_after: retryAfter,
      alternates: ["nvidia/nemotron-3-nano-30b-a3b"],
    },
    { status: 429 }
  );
}

test("Nous fair-share 429 cools account x model and moves to another account", async () => {
  initDb(":memory:");
  setSetting("default_fallback_model", "");
  const nousA = addConnection({ provider: "nous", name: "Nous A", credentials: { api_key: "a" } });
  addConnection({ provider: "nous", name: "Nous B", credentials: { api_key: "b" } });
  const accounts = [];
  setCustomExecutor({
    async execute({ url, connection }) {
      assert.ok(url.includes(NOUS_URL));
      accounts.push(connection.name);
      return accounts.length === 1 ? nousFairShare() : ok("jawaban akun B");
    },
  });

  try {
    const res = await request();
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).choices[0].message.content, "jawaban akun B");
    assert.deepStrictEqual(accounts, ["Nous A", "Nous B"]);
    assert.ok(getModelLockUntil(nousA.id, "qwen/qwen4-max:free") > Date.now());
    assert.strictEqual(getModelLockDetails(nousA.id, "qwen/qwen4-max:free").reason, "fair_share");
  } finally {
    setCustomExecutor(null);
  }
});

test("Nous fair-share 429 does not retry the same account before configured fallback", async () => {
  initDb(":memory:");
  setSetting("default_fallback_model", "glm/glm-4-flash");
  addConnection({ provider: "nous", name: "Nous A", credentials: { api_key: "a" } });
  addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "g" } });
  const calls = [];
  setCustomExecutor({
    async execute({ url, connection }) {
      calls.push({ host: new URL(url).hostname, account: connection.name });
      return url.includes(NOUS_URL) ? nousFairShare(11) : ok("jawaban GLM");
    },
  });

  try {
    const res = await request();
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).choices[0].message.content, "jawaban GLM");
    assert.deepStrictEqual(calls, [
      { host: NOUS_URL, account: "Nous A" },
      { host: GLM_URL, account: "GLM" },
    ]);
  } finally {
    setCustomExecutor(null);
  }
});

test("Nous fair-share cooldown returns 429 without another upstream call", async () => {
  initDb(":memory:");
  setSetting("default_fallback_model", "");
  addConnection({ provider: "nous", name: "Nous A", credentials: { api_key: "a" } });
  let calls = 0;
  setCustomExecutor({ async execute() { calls += 1; return nousFairShare(13); } });

  try {
    const first = await request();
    assert.strictEqual(first.status, 429);
    await first.text();
    const second = await request();
    assert.strictEqual(second.status, 429);
    assert.strictEqual(second.headers.get("x-zenith-error"), "fair_share_rate_limited");
    assert.ok(Number(second.headers.get("retry-after")) > 0);
    assert.strictEqual(calls, 1);
  } finally {
    setCustomExecutor(null);
  }
});

test("Nous midstream fair-share error closes output and persists cooldown", async () => {
  initDb(":memory:");
  setSetting("default_fallback_model", "");
  addConnection({ provider: "nous", name: "Nous A", credentials: { api_key: "a" } });
  let calls = 0;
  setCustomExecutor({
    async execute() {
      calls += 1;
      return new Response(
        'data: {"choices":[{"delta":{"content":"parsial"} }]}\n\n' +
          'event: error\ndata: {"status":429,"reason":"rate_limited","retry_after":13,"message":"fair-share rate limit"}\n\n' +
          'data: {"choices":[{"delta":{"content":"setelah error"}}]}\n\n',
        { headers: { "content-type": "text/event-stream" } }
      );
    },
  });

  try {
    const first = await request(NOUS_MODEL, true);
    const text = await first.text();
    assert.strictEqual(first.status, 200);
    assert.match(text, /fair_share_rate_limited/);
    assert.ok(!text.includes("setelah error"));
    const second = await request(NOUS_MODEL, true);
    assert.strictEqual(second.status, 429);
    assert.strictEqual(calls, 1);
  } finally {
    setCustomExecutor(null);
  }
});

test("Nous fair-share HTTP 429 is normalized with retry metadata and request id", async () => {
  initDb(":memory:");
  setSetting("default_fallback_model", "");
  addConnection({ provider: "nous", name: "Nous A", credentials: { api_key: "a" } });
  setCustomExecutor({ async execute() { return nousFairShare(13); } });
  clearConsoleLogs();

  try {
    const res = await request();
    assert.strictEqual(res.status, 429);
    assert.strictEqual(res.headers.get("retry-after"), "13");
    assert.strictEqual(res.headers.get("x-zenith-error"), "fair_share_rate_limited");
    const requestId = res.headers.get("x-zenith-request-id");
    assert.match(requestId, /^zenith-\d+$/);
    assert.ok(getConsoleLogs().some((line) => line.includes(`request_id=${requestId}`)));
    const data = await res.json();
    assert.match(data.error.message, /Nous membatasi model/);
    assert.match(data.error.message, /13 detik/);
    assert.ok(!JSON.stringify(data).includes("alternates"));
  } finally {
    setCustomExecutor(null);
  }
});
