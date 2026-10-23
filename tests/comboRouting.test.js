import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getDb, getModelLockUntil } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { createCombo } from "../src/services/combos.js";
import { setSetting } from "../src/services/settings.js";
import { resetComboRotation } from "../src/gateway/route.js";
import { isConnectionFullyCooledDown } from "../src/services/auth.js";

const MISTRAL_URL = "api.mistral.ai";
const GLM_URL = "api.z.ai";

function seedChain() {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });
}

function okOpenAI(text, usage = { prompt_tokens: 5, completion_tokens: 7 }) {
  return new Response(
    JSON.stringify({
      id: "chatcmpl_ok",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function upstreamError(status, message) {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chainCombo(name = "antai-utama") {
  return createCombo({
    name,
    models: ["mistral/mistral-large-latest", "glm/glm-4-flash"],
  });
}

test("combo chain - a rate limited member hands the request to the next member", async () => {
  seedChain();
  chainCombo();

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antai-utama",
      messages: [{ role: "user", content: "halo" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "dari anggota kedua");
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0].includes(MISTRAL_URL));
  assert.ok(calls[1].includes(GLM_URL));
  setCustomExecutor(null);
});

test("combo chain - a bad request stops the chain instead of burning the next member", async () => {
  seedChain();
  chainCombo();

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      return upstreamError(400, "prompt is malformed");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.error.message, "prompt is malformed");
  assert.strictEqual(calls.length, 1);
  setCustomExecutor(null);
});

test("combo chain - an exhausted chain answers 503 with the last member's error", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      return url.includes(MISTRAL_URL)
        ? upstreamError(429, "rate limit reached")
        : upstreamError(503, "upstream sedang sibuk");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 503);
  const data = await res.json();
  assert.match(data.error.message, /upstream sedang sibuk/);
  assert.match(data.error.message, /antai-utama/);
  assert.strictEqual(
    getDb().prepare("SELECT count(*) AS n FROM usage_history").get().n,
    0,
    "rantai yang habis tidak menambah baris pemakaian"
  );
  setCustomExecutor(null);
});

test("combo chain - the Anthropic endpoint routes a combo and returns the Anthropic success shape", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antai-utama",
      max_tokens: 64,
      messages: [{ role: "user", content: "halo" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.type, "message");
  assert.strictEqual(data.content[0].text, "dari anggota kedua");
  setCustomExecutor(null);
});

test("combo chain - the Responses endpoint routes a combo", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antai-utama",
      input: "halo",
      max_tokens: 64,
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.object, "response");
  assert.strictEqual(data.output[0].content[0].text, "dari anggota kedua");
  setCustomExecutor(null);
});

test("combo chain - streaming reaches the client only after a member succeeds", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return new Response(
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"halo"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antai-utama",
      messages: [{ role: "user", content: "halo" }],
      stream: true,
    }),
  });

  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /data:/);
  assert.match(text, /halo/);

  // Jalur stream mencatat pemakaian lewat tap stream; atribusi combo ikut terbawa.
  await new Promise((r) => setTimeout(r, 20));
  const streamed = getDb().prepare("SELECT combo_name FROM usage_history").get();
  assert.strictEqual(streamed.combo_name, "antai-utama", "request stream harus tercatat dengan nama combo");
  setCustomExecutor(null);
});

function sseError(message) {
  return new Response(`data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function sseOk(text) {
  return new Response(
    `data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

test("combo chain - a rate limit sent inside an HTTP 200 stream hands a streaming request to the next member", async () => {
  seedChain();
  chainCombo();

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return sseError("Rate limit exceeded for free model");
      return sseOk("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }], stream: true }),
  });

  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /dari anggota kedua/);
  assert.doesNotMatch(text, /Rate limit exceeded/, "error anggota pertama tidak boleh sampai ke klien");
  assert.strictEqual(calls.length, 2, "anggota kedua harus dicoba");

  const conn = getDb().prepare("SELECT id FROM connections WHERE provider = 'mistral'").get();
  assert.strictEqual(
    getModelLockUntil(conn.id, "mistral-large-latest"),
    null,
    "satu limit dalam stream belum mengunci model"
  );

  // The park happens on the next manual attempt, and the member after it still
  // answers that request.
  calls.length = 0;
  const retry = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }], stream: true }),
  });
  assert.strictEqual(retry.status, 200);
  await retry.text();
  assert.strictEqual(calls.length, 2, "percobaan kedua juga mencoba anggota pertama");
  assert.ok(getModelLockUntil(conn.id, "mistral-large-latest") > Date.now(), "kegagalan kedua mengunci model");
  setCustomExecutor(null);
});

test("combo chain - a rate limit sent inside an HTTP 200 stream hands a non-streaming request to the next member", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return sseError("Rate limit exceeded for free model");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "dari anggota kedua");
  setCustomExecutor(null);
});

test("combo chain - an error event in the stream of a plain model request answers with an error status", async () => {
  seedChain();

  setCustomExecutor({
    async execute() {
      return new Response(`data: ${JSON.stringify({ error: { message: "insufficient credits", code: 402 } })}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mistral/mistral-large-latest",
      messages: [{ role: "user", content: "halo" }],
      stream: true,
    }),
  });

  assert.strictEqual(res.status, 402);
  const data = await res.json();
  assert.strictEqual(data.error.message, "insufficient credits");
  setCustomExecutor(null);
});

test("combo chain - a healthy stream with a leading keep-alive comment reaches the client intact", async () => {
  seedChain();

  const body =
    ': ping\n\ndata: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"halo"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
  setCustomExecutor({
    async execute() {
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mistral/mistral-large-latest",
      messages: [{ role: "user", content: "halo" }],
      stream: true,
    }),
  });

  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /: ping/);
  assert.match(text, /"content":"halo"/);
  assert.match(text, /\[DONE\]/);
  setCustomExecutor(null);
});

test("combo chain - an unknown name still answers 404", async () => {
  seedChain();

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "tidak-ada-combo", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 404);
  const data = await res.json();
  assert.strictEqual(data.error.code, "model_not_found");
  assert.match(data.error.message, /tidak-ada-combo/, "pesan 404 harus menyebut nama yang diminta");
  assert.match(data.error.message, /not found in registry/);
});

test("combo chain - a combo name beats the provider guess for the same string", async () => {
  seedChain();
  // Inserted directly: the service refuses names that shadow a provider guess, so
  // only a row from an older database can reach this state. The documented
  // precedence still has to hold for it.
  getDb()
    .prepare(
      `INSERT INTO combos (name, strategy, models, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`
    )
    .run("gpt-5-codex", "fallback", JSON.stringify(["glm/glm-4-flash"]), Date.now(), Date.now());

  const urls = [];
  setCustomExecutor({
    async execute({ url }) {
      urls.push(url);
      return okOpenAI("dari combo");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5-codex", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].includes(GLM_URL));
  setCustomExecutor(null);
});

test("combo chain - a plain model request is untouched", async () => {
  seedChain();
  chainCombo();

  const urls = [];
  setCustomExecutor({
    async execute({ url }) {
      urls.push(url);
      return okOpenAI("dari mistral langsung");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mistral/mistral-large-latest",
      messages: [{ role: "user", content: "halo" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(urls.length, 1);
  assert.ok(urls[0].includes(MISTRAL_URL));
  setCustomExecutor(null);
});

// Regression guard for the case the review found: a member that rate limits the
// model it tried used to park the whole account, so the next member of the same
// provider found no connection left and the chain died early.
test("combo chain - a rate limited member does not block the next member of the same provider", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  createCombo({ name: "dua-mistral", models: ["mistral/mistral-large-latest", "mistral/mistral-small-latest"] });

  const seen = [];
  setCustomExecutor({
    async execute({ url, body }) {
      const model = JSON.parse(body).model;
      seen.push(model);
      if (model.includes("large")) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari model kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dua-mistral", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200);
  const payload = await res.json();
  assert.strictEqual(payload.choices[0].message.content, "dari model kedua");
  assert.strictEqual(seen.length, 2, "kedua anggota harus dicoba");
  assert.ok(seen[0].includes("large"));
  assert.ok(seen[1].includes("small"));

  // The lock is remembered per (connection, model), so the account still serves
  // other models right away while the rate limited one stays parked. It takes a
  // second failed attempt before the model is parked at all.
  const conn = getDb().prepare("SELECT id FROM connections").get();
  assert.strictEqual(getModelLockUntil(conn.id, "mistral-large-latest"), null, "satu 429 belum mengunci model");

  const again = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dua-mistral", messages: [{ role: "user", content: "halo" }] }),
  });
  assert.strictEqual(again.status, 200);
  await again.json();
  assert.ok(getModelLockUntil(conn.id, "mistral-large-latest") > Date.now(), "model yang kena 429 harus terkunci");
  assert.strictEqual(
    getModelLockUntil(conn.id, "mistral-small-latest"),
    null,
    "model lain di akun yang sama harus tetap bebas"
  );
  assert.ok(!isConnectionFullyCooledDown(conn), "429 satu model bukan outage seluruh akun");
  setCustomExecutor(null);
});

test("combo chain - a bare 500 hands the request to the next member", async () => {
  seedChain();
  chainCombo();

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(500, "internal server error");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 2);
  setCustomExecutor(null);
});

test("combo chain - a billing rejection hands the request to the next member", async () => {
  seedChain();
  chainCombo();

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(402, "credit exhausted");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 2);
  setCustomExecutor(null);
});

test("combo chain - a broken credential still parks the whole account", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });
  createCombo({ name: "antai-utama", models: ["mistral/mistral-large-latest", "glm/glm-4-flash"] });

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(401, "invalid api key");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200);
  let conn = getDb().prepare("SELECT id, cooldown_until FROM connections WHERE provider = ?").get("mistral");
  assert.ok(!(conn.cooldown_until > Date.now()), "401 pertama belum mengunci akun");

  const retry = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });
  assert.strictEqual(retry.status, 200);
  await retry.json();
  conn = getDb().prepare("SELECT id, cooldown_until FROM connections WHERE provider = ?").get("mistral");
  assert.ok(conn.cooldown_until > Date.now(), "401 tanpa model harus mengunci seluruh koneksi setelah dua percobaan");
  assert.strictEqual(
    getModelLockUntil(conn.id, "mistral-large-latest"),
    null,
    "kunci akun tidak menyimpan kunci model"
  );
  setCustomExecutor(null);
});

test("combo chain - an unreachable member hands the request to the next member", async () => {
  seedChain();
  chainCombo();

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) throw new Error("ECONNRESET: socket hang up");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200, "kegagalan transport bukan akhir rantai");
  assert.strictEqual(calls.length, 2);
  setCustomExecutor(null);
});

test("combo chain - the last error is reported when every member is unreachable", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  createCombo({ name: "dua-mistral", models: ["mistral/mistral-large-latest", "mistral/mistral-small-latest"] });

  setCustomExecutor({
    async execute() {
      throw new Error("ENOTFOUND api.mistral.ai");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "dua-mistral", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 503);
  const payload = await res.json();
  assert.strictEqual(payload.error.code, "combo_exhausted");
  assert.ok(payload.error.message.includes("ENOTFOUND"), payload.error.message);
  setCustomExecutor(null);
});

// --- Temuan audit: bentuk error, jalur prepare, abort klien ---

test("combo chain - the Anthropic endpoint reports an exhausted chain in Anthropic shape", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      return url.includes(MISTRAL_URL)
        ? upstreamError(429, "rate limit reached")
        : upstreamError(503, "upstream sedang sibuk");
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antai-utama",
      max_tokens: 64,
      messages: [{ role: "user", content: "halo" }],
    }),
  });

  assert.strictEqual(res.status, 503);
  const data = await res.json();
  assert.strictEqual(data.type, "error", "klien Anthropic mengharapkan envelope type=error");
  assert.strictEqual(data.error.type, "overloaded_error");
  assert.match(data.error.message, /upstream sedang sibuk/);
  assert.match(data.error.message, /antai-utama/);
  setCustomExecutor(null);
});

test("combo chain - an unreachable member is reported in the endpoint's own error shape", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute() {
      throw new Error("ECONNRESET api.mistral.ai");
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antai-utama",
      max_tokens: 64,
      messages: [{ role: "user", content: "halo" }],
    }),
  });

  assert.strictEqual(res.status, 503);
  const data = await res.json();
  assert.strictEqual(data.type, "error");
  assert.match(data.error.message, /ECONNRESET/);
  setCustomExecutor(null);
});

test("combo chain - the chat endpoint keeps the OpenAI error shape for an exhausted chain", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      return url.includes(MISTRAL_URL)
        ? upstreamError(429, "rate limit reached")
        : upstreamError(503, "upstream sedang sibuk");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 503);
  const data = await res.json();
  assert.strictEqual(data.error.type, "service_unavailable");
  assert.strictEqual(data.error.code, "combo_exhausted");
  setCustomExecutor(null);
});

test("combo chain - a translator error surfaces instead of walking the chain", async () => {
  // messages:[null] meninggal di penerjemah. Itu input yang cacat, bukan anggota
  // yang tak terjangkau: tidak boleh pindah anggota dan tidak boleh berbalik
  // sebagai kegagalan combo.
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });
  createCombo({ name: "campur", models: ["claude/claude-sonnet-4-5", "glm/glm-4-flash"] });

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      return okOpenAI("tidak boleh tercapai");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "campur", messages: [null] }),
  });

  assert.strictEqual(res.status, 500);
  assert.strictEqual(calls.length, 0, "tidak ada anggota yang dipanggil untuk input yang cacat");
  const data = await res.json();
  assert.match(data.error.message, /Internal gateway error/);
  assert.ok(
    !data.error.message.includes("could not be reached"),
    "error translasi tidak boleh dilaporkan sebagai anggota tak terjangkau"
  );
  setCustomExecutor(null);
});

test("combo chain - a client that walks away stops the chain without writing locks", async () => {
  seedChain();
  chainCombo();

  const controller = new AbortController();
  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      controller.abort();
      return url.includes(MISTRAL_URL) ? upstreamError(429, "rate limit reached") : okOpenAI("tidak boleh tercapai");
    },
  });

  const res = await app.request(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
      signal: controller.signal,
    })
  );

  assert.strictEqual(calls.length, 1, "anggota kedua tidak boleh dipanggil setelah klien pergi");
  assert.strictEqual(res.status, 503);
  assert.strictEqual(
    getDb().prepare("SELECT count(*) AS n FROM connection_model_locks").get().n,
    0,
    "abort bukan alasan menulis lock"
  );
  const conn = getDb().prepare("SELECT cooldown_until FROM connections WHERE provider = 'mistral'").get();
  assert.strictEqual(conn.cooldown_until, 0, "abort bukan alasan mengunci akun");
  setCustomExecutor(null);
});

// --- Temuan audit: jejak AC yang testnya kurang ---

test("combo chain - a forbidden member still hands the request to the next member", async () => {
  seedChain();
  chainCombo();

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(403, "model is not in your tier");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "dari anggota kedua");
  assert.strictEqual(calls.length, 2);
  setCustomExecutor(null);
});

test("combo chain - a removed member model still hands the request to the next member", async () => {
  seedChain();
  chainCombo();

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(404, "model has been removed");
      return okOpenAI("dari anggota kedua");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "dari anggota kedua");
  assert.strictEqual(calls.length, 2);
  setCustomExecutor(null);
});

test("combo chain - the Anthropic endpoint streams only the winning member's chunks", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return new Response(
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"halo-dari-kedua"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antai-utama",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "halo" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /halo-dari-kedua/);
  assert.match(text, /content_block_delta/, "stream harus berbentuk kejadian Anthropic");
  assert.ok(!text.includes("rate limit reached"), "error anggota pertama tidak boleh bocor ke stream");
  setCustomExecutor(null);
});

test("combo chain - the Responses endpoint streams only the winning member's chunks", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return new Response(
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"halo-dari-kedua"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  const res = await app.request("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", input: "halo", stream: true, max_tokens: 64 }),
  });

  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /halo-dari-kedua/);
  assert.ok(!text.includes("rate limit reached"), "error anggota pertama tidak boleh bocor ke stream");
  setCustomExecutor(null);
});

test("combo chain - the usage row names the member that served", async () => {
  seedChain();
  chainCombo();

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari anggota kedua", { prompt_tokens: 11, completion_tokens: 13 });
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });
  assert.strictEqual(res.status, 200);
  await res.json();

  // recordUsage berjalan lewat queueMicrotask setelah respons dikirim.
  await new Promise((r) => setTimeout(r, 20));
  const rows = getDb()
    .prepare("SELECT provider, model, combo_name, input_tokens, output_tokens FROM usage_history")
    .all();
  const row = rows.find((r) => r.model === "glm-4-flash");
  assert.ok(row, `usage harus mencatat anggota yang melayani, dapat ${JSON.stringify(rows)}`);
  assert.strictEqual(row.provider, "glm");
  assert.strictEqual(row.combo_name, "antai-utama", "baris combo membawa nama combo");
  assert.strictEqual(row.input_tokens, 11);
  assert.strictEqual(row.output_tokens, 13);

  // Request biasa tidak punya combo untuk dicatat. Provider lain dipakai supaya
  // lock model bekas 429 anggota mistral tidak menghalangi (mistral terkunci
  // 60 detik untuk mistral-large-latest sejak request combo di atas).
  const plain = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "halo" }] }),
  });
  assert.strictEqual(plain.status, 200);
  await plain.json();
  await new Promise((r) => setTimeout(r, 20));
  const plainRow = getDb()
    .prepare("SELECT combo_name FROM usage_history ORDER BY id DESC LIMIT 1")
    .get();
  assert.strictEqual(plainRow.combo_name, null, "request tanpa combo tidak mengisi nama combo");
  setCustomExecutor(null);
});

// --- strategi giliran ---

function seedRotation(models) {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });
  const combo = createCombo({ name: "gilir", strategy: "round-robin", models });
  resetComboRotation();
  return combo;
}

async function hitCombo(times) {
  const served = [];
  setCustomExecutor({
    async execute({ body }) {
      const model = JSON.parse(body).model;
      served.push(model);
      return okOpenAI(`dari ${model}`);
    },
  });
  for (let i = 0; i < times; i++) {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gilir", messages: [{ role: "user", content: "halo" }] }),
    });
    assert.strictEqual(res.status, 200, `request ke-${i + 1} harus sukses`);
    await res.json();
  }
  setCustomExecutor(null);
  return served;
}

test("combo chain - round robin starts each request at the next member", async () => {
  seedRotation(["mistral/mistral-large-latest", "mistral/mistral-small-latest", "glm/glm-4-flash"]);

  const served = await hitCombo(4);

  assert.deepStrictEqual(served, [
    "mistral-large-latest",
    "mistral-small-latest",
    "glm-4-flash",
    "mistral-large-latest",
  ]);
});

test("combo chain - a hold count of two keeps the same member for two requests", async () => {
  seedRotation(["mistral/mistral-large-latest", "mistral/mistral-small-latest"]);
  setSetting("combo_round_robin_count", "2");

  const served = await hitCombo(5);

  assert.deepStrictEqual(served, [
    "mistral-large-latest",
    "mistral-large-latest",
    "mistral-small-latest",
    "mistral-small-latest",
    "mistral-large-latest",
  ]);
});

test("combo chain - changing the hold count applies to the next request", async () => {
  seedRotation([
    "mistral/mistral-large-latest",
    "mistral/mistral-small-latest",
    "mistral/mistral-codestral-latest",
  ]);

  // Batas default 1: request pertama memakai anggota pertama lalu rotasi maju.
  await hitCombo(1);
  setSetting("combo_round_robin_count", "2");

  // Dengan batas 2, dua request berikutnya memakai anggota yang sama,
  // lalu rotasi maju ke anggota ketiga.
  const served = await hitCombo(3);
  assert.strictEqual(served[0], served[1], "batas baru harus membuat anggota bertahan dua request");
  assert.strictEqual(served[0], "mistral-small-latest");
  assert.strictEqual(served[2], "mistral-codestral-latest");
});

test("combo chain - a fallback combo always starts at the first member", async () => {
  seedChain();
  chainCombo();
  resetComboRotation();

  const served = [];
  setCustomExecutor({
    async execute({ body }) {
      const model = JSON.parse(body).model;
      served.push(model);
      return okOpenAI(`dari ${model}`);
    },
  });
  for (let i = 0; i < 2; i++) {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
    });
    assert.strictEqual(res.status, 200);
    await res.json();
  }
  setCustomExecutor(null);

  assert.deepStrictEqual(served, ["mistral-large-latest", "mistral-large-latest"]);
});

test("combo chain - rotation advances one step even when the starting member fails", async () => {
  seedRotation(["mistral/mistral-large-latest", "glm/glm-4-flash"]);

  // 404, bukan 429: kegagalan anggota tidak boleh meninggalkan lock yang
  // memblokir anggota yang sama di request berikutnya.
  let failModel = "mistral-large-latest";
  const served = [];
  setCustomExecutor({
    async execute({ body }) {
      const model = JSON.parse(body).model;
      if (model === failModel) return upstreamError(404, "model removed");
      served.push(model);
      return okOpenAI(`dari ${model}`);
    },
  });

  const hit = async () => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gilir", messages: [{ role: "user", content: "halo" }] }),
    });
    assert.strictEqual(res.status, 200);
    await res.json();
  };

  await hit();
  failModel = "glm-4-flash";
  await hit();
  setCustomExecutor(null);

  // Request 1 mulai di mistral (gagal) → glm melayani; kursor maju satu langkah.
  // Request 2 mulai di glm (gagal) → mistral melayani. Rotasi maju per request,
  // bukan per anggota yang dilewati.
  assert.deepStrictEqual(served, ["glm-4-flash", "mistral-large-latest"]);
});

// --- auto-switch vision ---

test("combo chain - an image request starts at a member that can read images", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });
  // codestral teks saja, mistral-large vision, glm-4-flash teks saja.
  createCombo({
    name: "antai-gambar",
    models: ["mistral/mistral-codestral-latest", "mistral/mistral-large-latest", "glm/glm-4-flash"],
  });

  const served = [];
  setCustomExecutor({
    async execute({ body }) {
      const model = JSON.parse(body).model;
      served.push(model);
      return okOpenAI(`dari ${model}`);
    },
  });

  const hit = async (content) => {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "antai-gambar", messages: [{ role: "user", content }] }),
    });
    assert.strictEqual(res.status, 200);
    await res.json();
  };

  await hit("halo biasa");
  await hit([
    { type: "text", text: "lihat gambar ini" },
    { type: "image_url", image_url: { url: "http://localhost/x.png" } },
  ]);
  setCustomExecutor(null);

  assert.strictEqual(served[0], "mistral-codestral-latest", "request teks memakai urutan tersimpan");
  assert.strictEqual(served[1], "mistral-large-latest", "request gambar lompat ke anggota vision");
});

test("combo chain - an Anthropic image block also reaches the vision member", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  createCombo({
    name: "antai-gambar-claude",
    models: ["glm/glm-4-flash", "mistral/mistral-large-latest"],
  });

  setCustomExecutor({
    async execute({ body }) {
      return okOpenAI(`dari ${JSON.parse(body).model}`);
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antai-gambar-claude",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
            { type: "text", text: "lihat" },
          ],
        },
      ],
    }),
  });

  assert.strictEqual(res.status, 200);
  const payload = await res.json();
  assert.match(payload.content[0].text, /mistral-large-latest/, "anggota vision yang melayani");
  setCustomExecutor(null);
});

test("combo chain - a text mention of image_url does not reorder the chain", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });
  createCombo({
    name: "antai-teks",
    models: ["mistral/mistral-codestral-latest", "mistral/mistral-large-latest"],
  });

  const served = [];
  setCustomExecutor({
    async execute({ body }) {
      const model = JSON.parse(body).model;
      served.push(model);
      return okOpenAI(`dari ${model}`);
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antai-teks",
      messages: [{ role: "user", content: "Bagaimana cara memakai image_url di API OpenAI?" }],
    }),
  });
  assert.strictEqual(res.status, 200);
  await res.json();
  setCustomExecutor(null);

  assert.strictEqual(served[0], "mistral-codestral-latest", "teks biasa tidak boleh memicu pengurutan vision");
});
