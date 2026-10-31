import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

// Nama akun non-Latin1 tidak boleh membuat header diagnostik melempar error.
// Header X-Zenith-Account berisi nama yang sudah di-encode dengan aman.
const ACCOUNT = "akun-日本-Ж@example.com";

function seedAccount() {
  initDb(":memory:");
  addConnection({
    provider: "antigravity",
    name: ACCOUNT,
    auth_type: "oauth",
    credentials: { access_token: "tok", refresh_token: "ref" },
  });
}

function okChat() {
  return new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "gpt-x",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

test("F-07 header akun: nama non-Latin1 tidak menggagalkan respons non-stream", async () => {
  seedAccount();
  setCustomExecutor({ async execute() { return okChat(); } });
  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ag/gemini-3.8-flash-high", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.strictEqual(res.status, 200, "respons harus tetap 200 walau nama akun non-Latin1");
    const header = res.headers.get("X-Zenith-Account");
    assert.strictEqual(decodeURIComponent(header), ACCOUNT, "nama akun bisa dipulihkan dari header");
    assert.ok(/^[\x20-\x7e]*$/.test(header), "header hanya berisi ASCII printable");
  } finally {
    setCustomExecutor(null);
  }
});

test("F-07 header akun: nama non-Latin1 tidak menggagalkan respons stream", async () => {
  seedAccount();
  const sse = 'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"gpt-x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
  setCustomExecutor({ async execute() { return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }); } });
  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ag/gemini-3.8-flash-high", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.strictEqual(res.status, 200, "stream harus tetap 200 walau nama akun non-Latin1");
    const header = res.headers.get("X-Zenith-Account");
    assert.strictEqual(decodeURIComponent(header), ACCOUNT);
    assert.ok(/^[\x20-\x7e]*$/.test(header), "header hanya berisi ASCII printable");
  } finally {
    setCustomExecutor(null);
  }
});

test("F-07 header akun: email ASCII tidak berubah oleh encoding", async () => {
  // Tanpa karakter di luar ASCII printable, header harus persis nama akun.
  // Ini menjaga klien yang sudah membaca email mentah dari header.
  initDb(":memory:");
  addConnection({
    provider: "antigravity",
    name: "deepa.rizky@gmail.com",
    auth_type: "oauth",
    credentials: { access_token: "tok", refresh_token: "ref" },
  });
  setCustomExecutor({ async execute() { return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "Content-Type": "application/json" } }); } });
  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ag/gemini-3.8-flash-high", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.strictEqual(res.headers.get("X-Zenith-Account"), "deepa.rizky@gmail.com");
  } finally {
    setCustomExecutor(null);
  }
});
