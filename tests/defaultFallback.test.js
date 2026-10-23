import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getDb } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { createCombo, setComboEnabled } from "../src/services/combos.js";
import { setSetting, getSetting } from "../src/services/settings.js";

const MISTRAL_URL = "api.mistral.ai";
const GLM_URL = "api.z.ai";
const PRIMARY = "mistral/mistral-large-latest";
const FALLBACK = "glm/glm-4-flash";

function seed() {
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

function chatRequest(model = PRIMARY) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "halo" }] }),
  });
}

test("default fallback - failure on a plain model switches to the configured model", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("jawaban dari fallback");
    },
  });

  const res = await chatRequest();
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "jawaban dari fallback");
  assert.strictEqual(calls.length, 2, `model utama lalu fallback, dapat ${JSON.stringify(calls)}`);
  assert.ok(calls[0].includes(MISTRAL_URL));
  assert.ok(calls[1].includes(GLM_URL));
  setCustomExecutor(null);
});

test("default fallback - a switched request records the requested model as its origin", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari fallback", { prompt_tokens: 21, completion_tokens: 34 });
    },
  });

  const res = await chatRequest();
  assert.strictEqual(res.status, 200);
  await res.json();

  // recordUsage berjalan lewat queueMicrotask setelah respons dikirim.
  await new Promise((r) => setTimeout(r, 20));
  const row = getDb().prepare("SELECT provider, model, combo_name, fallback_from FROM usage_history").get();
  assert.ok(row, "satu baris pemakaian harus tercatat");
  assert.strictEqual(row.provider, "glm");
  assert.strictEqual(row.model, "glm-4-flash", "baris pemakaian mencatat model fallback yang menjawab");
  assert.strictEqual(row.fallback_from, PRIMARY, "model yang diminta klien disimpan sebagai asal peralihan");
  assert.strictEqual(row.combo_name, null, "request model langsung bukan request combo");
  setCustomExecutor(null);
});

test("default fallback - a client error stops the request without trying the fallback", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      return upstreamError(400, "prompt is malformed");
    },
  });

  const res = await chatRequest();
  assert.strictEqual(res.status, 400);
  assert.strictEqual(calls.length, 1, "error payload klien tidak boleh memicu fallback");
  setCustomExecutor(null);
});

test("default fallback - a fallback pointing at the failed model is not called again", async () => {
  seed();
  setSetting("default_fallback_model", PRIMARY);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      return upstreamError(429, "rate limit reached");
    },
  });

  const res = await chatRequest();
  assert.strictEqual(res.status, 429);
  assert.strictEqual(calls.length, 1, "model yang sama tidak boleh dipanggil dua kali dalam satu request");
  setCustomExecutor(null);
});

test("default fallback - an unknown fallback target leaves the original failure in place", async () => {
  seed();
  setSetting("default_fallback_model", "tidak-ada-provider/tidak-ada-model");

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      return upstreamError(429, "rate limit reached");
    },
  });

  const res = await chatRequest();
  assert.strictEqual(res.status, 429);
  assert.strictEqual(calls.length, 1);
  setCustomExecutor(null);
});

test("default fallback - an exhausted combo hands the request to the fallback model", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);
  createCombo({ name: "rantai", models: [PRIMARY] });

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari fallback");
    },
  });

  const res = await chatRequest("rantai");
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "dari fallback");
  assert.strictEqual(calls.length, 2, `anggota combo lalu fallback, dapat ${JSON.stringify(calls)}`);
  setCustomExecutor(null);
});

test("default fallback - the configured fallback may itself be a combo", async () => {
  seed();
  createCombo({ name: "cadangan", models: [FALLBACK] });
  setSetting("default_fallback_model", "cadangan");

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari combo cadangan");
    },
  });

  const res = await chatRequest();
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "dari combo cadangan");
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].includes(GLM_URL));

  await new Promise((r) => setTimeout(r, 20));
  const row = getDb().prepare("SELECT model, combo_name, fallback_from FROM usage_history").get();
  assert.strictEqual(row.combo_name, "cadangan", "baris mencatat combo fallback yang menjawab");
  assert.strictEqual(row.fallback_from, PRIMARY, "asal peralihan tetap model yang diminta klien");
  setCustomExecutor(null);
});

test("default fallback - later requests skip a primary account that is still in cooldown", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari fallback");
    },
  });

  const first = await chatRequest();
  assert.strictEqual(first.status, 200);
  await first.json();
  const afterFirst = calls.length;

  // Satu 429 belum memarkir akun utama, jadi request kedua masih menembak model
  // utama lalu jatuh ke fallback; request ketiga barulah langsung ke fallback.
  calls.length = 0;
  const second = await chatRequest();
  assert.strictEqual(second.status, 200);
  await second.json();
  assert.strictEqual(afterFirst, 2);
  assert.strictEqual(calls.length, 2, `percobaan kedua masih mencoba model utama, dapat ${JSON.stringify(calls)}`);

  calls.length = 0;
  const third = await chatRequest();
  assert.strictEqual(third.status, 200);
  await third.json();
  assert.strictEqual(calls.length, 1, `hanya fallback yang dipanggil, dapat ${JSON.stringify(calls)}`);
  assert.ok(calls[0].includes(GLM_URL));
  setCustomExecutor(null);
});

test("default fallback - the streaming path fails over and records the origin too", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
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
    body: JSON.stringify({ model: PRIMARY, messages: [{ role: "user", content: "halo" }], stream: true }),
  });

  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /halo/, "stream dari fallback harus sampai ke klien");
  assert.ok(!text.includes("rate limit reached"), "error model utama tidak boleh bocor ke stream");
  assert.strictEqual(calls.length, 2);

  // Jalur stream mencatat pemakaian lewat tap stream; asal peralihan ikut terbawa.
  await new Promise((r) => setTimeout(r, 20));
  const row = getDb().prepare("SELECT model, fallback_from FROM usage_history").get();
  assert.strictEqual(row.model, "glm-4-flash");
  assert.strictEqual(row.fallback_from, PRIMARY);
  setCustomExecutor(null);
});

test("default fallback - a client that already left is not worth a fallback call", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);
  createCombo({ name: "rantai-abort", models: [PRIMARY, "glm/glm-4-plus"] });

  const controller = new AbortController();
  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      // Klien pergi di tengah rantai; anggota berikutnya dan target fallback
      // tidak boleh lagi menyentuh upstream.
      controller.abort();
      return upstreamError(429, "rate limit reached");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "rantai-abort", messages: [{ role: "user", content: "halo" }] }),
    signal: controller.signal,
  });

  assert.strictEqual(calls.length, 1, `rantai berhenti di anggota pertama, dapat ${JSON.stringify(calls)}`);
  assert.ok(!calls.some((url) => url.includes(GLM_URL)), "request yang ditinggalkan klien tidak boleh memanggil fallback");
  assert.ok(res.status >= 400 || res.status === 200, "respons tetap terbentuk tanpa error gateway");
  setCustomExecutor(null);
});

test("default fallback - a fallback combo that repeats the requested combo is not run", async () => {
  seed();
  createCombo({ name: "rantai-sama", models: [PRIMARY] });
  setSetting("default_fallback_model", "rantai-sama");

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      return upstreamError(429, "rate limit reached");
    },
  });

  const res = await chatRequest("rantai-sama");
  assert.strictEqual(res.status, 503, "error combo dikembalikan apa adanya");
  assert.strictEqual(calls.length, 1, "anggota yang sudah gagal tidak dipanggil ulang");
  setCustomExecutor(null);
});

test("default fallback - a fallback combo without fresh members is skipped", async () => {
  seed();
  createCombo({ name: "rantai-utama", models: [PRIMARY] });
  createCombo({ name: "rantai-tumpang", models: [PRIMARY] });
  setSetting("default_fallback_model", "rantai-tumpang");

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      return upstreamError(429, "rate limit reached");
    },
  });

  const res = await chatRequest("rantai-utama");
  assert.strictEqual(res.status, 503);
  assert.strictEqual(calls.length, 1, "anggota yang sama sudah dicoba pada request ini");
  setCustomExecutor(null);
});

test("default fallback - a 422 payload error never reaches the fallback", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      return upstreamError(422, "messages: field required");
    },
  });

  const res = await chatRequest();
  assert.strictEqual(res.status, 422);
  assert.strictEqual(calls.length, 1);
  setCustomExecutor(null);
});

test("default fallback - a fallback combo still starts at a vision member for an image", async () => {
  seed();
  // codestral hanya teks, mistral-large bisa membaca gambar.
  createCombo({ name: "cadangan-gambar", models: ["mistral/mistral-codestral-latest", "mistral/mistral-large-latest"] });
  setSetting("default_fallback_model", "cadangan-gambar");

  const served = [];
  setCustomExecutor({
    async execute({ url, body }) {
      if (url.includes(GLM_URL)) return upstreamError(429, "rate limit reached");
      served.push(JSON.parse(body).model);
      return okOpenAI("dari anggota vision");
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: FALLBACK,
      messages: [
        { role: "user", content: [{ type: "text", text: "lihat ini" }, { type: "image_url", image_url: { url: "http://localhost/x.png" } }] },
      ],
    }),
  });

  assert.strictEqual(res.status, 200);
  await res.json();
  assert.strictEqual(served[0], "mistral-large-latest", "anggota vision didahulukan pada combo fallback");
  setCustomExecutor(null);
});

test("default fallback - the primary is tried again once its accounts recover", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari fallback");
    },
  });

  await (await chatRequest()).json();
  assert.strictEqual(calls.length, 2);

  // Cooldown akun dilepas seperti waktu reset yang sudah lewat.
  getDb().exec(
    "UPDATE connection_model_locks SET locked_until = 0; UPDATE connections SET cooldown_until = 0;"
  );

  calls.length = 0;
  await (await chatRequest()).json();
  assert.strictEqual(calls.length, 2, "model utama dicoba lebih dulu setelah pulih");
  assert.ok(calls[0].includes(MISTRAL_URL), `urutan panggilan: ${JSON.stringify(calls)}`);
  setCustomExecutor(null);
});

test("default fallback - both targets failing returns the last error and records nothing", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  setCustomExecutor({
    async execute({ url }) {
      return upstreamError(url.includes(MISTRAL_URL) ? 429 : 500, "upstream sedang bermasalah");
    },
  });

  const res = await chatRequest();
  assert.strictEqual(res.status, 500, "error kegagalan terakhir yang dikembalikan");

  await new Promise((r) => setTimeout(r, 20));
  const count = getDb().prepare("SELECT COUNT(*) AS n FROM usage_history").get().n;
  assert.strictEqual(count, 0, "kegagalan tidak boleh menambah entri pemakaian");
  setCustomExecutor(null);
});

test("default fallback - Recent Requests shows the requested model as the origin", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari fallback");
    },
  });

  await (await chatRequest()).json();
  await new Promise((r) => setTimeout(r, 20));

  const html = await (await app.request("/dashboard/usage")).text();
  assert.ok(
    html.includes(`${PRIMARY} &rarr; glm-4-flash`),
    "panel menampilkan asal peralihan, bukan model fallback sebagai asal"
  );
  setCustomExecutor(null);
});

test("default fallback - Recent Requests keeps the requested combo as origin", async () => {
  seed();
  createCombo({ name: "rantai-asal", models: [PRIMARY] });
  createCombo({ name: "cadangan-kombo", models: [FALLBACK] });
  setSetting("default_fallback_model", "cadangan-kombo");

  setCustomExecutor({
    async execute({ url }) {
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari combo cadangan");
    },
  });

  await (await chatRequest("rantai-asal")).json();
  await new Promise((r) => setTimeout(r, 20));

  const html = await (await app.request("/dashboard/usage")).text();
  assert.ok(html.includes("rantai-asal &rarr; glm-4-flash"), "asal peralihan tetap combo yang diminta klien");
  assert.ok(
    !html.includes("cadangan-kombo &rarr; glm-4-flash"),
    "combo fallback yang benar-benar menjawab tidak boleh tampil sebagai asal"
  );
  setCustomExecutor(null);
});

test("default fallback - the Messages endpoint fails over the same way", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari fallback");
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PRIMARY,
      max_tokens: 64,
      messages: [{ role: "user", content: "halo" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.type, "message", "respons harus dalam bentuk protokol Claude");
  assert.strictEqual(data.content[0].text, "dari fallback");
  assert.strictEqual(calls.length, 2);
  setCustomExecutor(null);
});

test("default fallback - the Responses endpoint fails over the same way", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return okOpenAI("dari fallback");
    },
  });

  const res = await app.request("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: PRIMARY, input: "halo", max_tokens: 64 }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.object, "response");
  assert.strictEqual(data.output[0].content[0].text, "dari fallback");
  assert.strictEqual(calls.length, 2);
  setCustomExecutor(null);
});

test("default fallback - the Messages streaming path fails over too", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return new Response(
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"halo"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  const res = await app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: PRIMARY,
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "halo" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /halo/, "stream dari fallback harus sampai ke klien");
  assert.ok(!text.includes("rate limit reached"));
  assert.strictEqual(calls.length, 2);
  setCustomExecutor(null);
});

test("default fallback - the Responses streaming path fails over too", async () => {
  seed();
  setSetting("default_fallback_model", FALLBACK);

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      if (url.includes(MISTRAL_URL)) return upstreamError(429, "rate limit reached");
      return new Response(
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"halo"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    },
  });

  const res = await app.request("/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: PRIMARY, input: "halo", stream: true, max_tokens: 64 }),
  });

  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.match(text, /halo/, "stream dari fallback harus sampai ke klien");
  assert.ok(!text.includes("rate limit reached"));
  assert.strictEqual(calls.length, 2);
  setCustomExecutor(null);
});

test("default fallback - no setting means the plain model failure is returned as is", async () => {
  seed();

  const calls = [];
  setCustomExecutor({
    async execute({ url }) {
      calls.push(url);
      return upstreamError(429, "rate limit reached");
    },
  });

  const res = await chatRequest();
  assert.strictEqual(res.status, 429);
  assert.strictEqual(calls.length, 1);
  setCustomExecutor(null);
});

test("settings - the fallback dropdown lists inactive, combos, and active provider models", async () => {
  seed();
  createCombo({ name: "rantai-aktif", models: [PRIMARY] });
  createCombo({ name: "rantai-mati", models: [FALLBACK] });
  setComboEnabled("rantai-mati", false);

  const html = await (await app.request("/dashboard/settings")).text();

  assert.ok(html.includes('name="default_fallback_model"'), "dropdown default fallback harus ada");
  assert.ok(html.includes("<option value=\"\" selected>Nonaktif</option>"), "opsi nonaktif jadi pilihan awal");
  assert.ok(html.includes(">rantai-aktif</option>"), "combo aktif masuk daftar");
  assert.ok(!html.includes(">rantai-mati</option>"), "combo nonaktif tidak masuk daftar");
  assert.ok(html.includes(">mis/mistral-large-latest</option>"), "model provider berkoneksi aktif masuk daftar");
  assert.ok(html.includes(">glm/glm-4-flash</option>"));
  assert.ok(html.includes("<optgroup label=\"Combo\">"), "combo dikelompokkan");
});

test("settings - the saved fallback survives a save and stays selected on reload", async () => {
  seed();

  const form = new FormData();
  form.append("default_fallback_model", FALLBACK);
  const saved = await app.request("/dashboard/settings", { method: "POST", body: form });
  assert.strictEqual(saved.status, 302);
  assert.strictEqual(getSetting("default_fallback_model"), FALLBACK);

  const html = await (await app.request("/dashboard/settings")).text();
  assert.ok(html.includes(`<option value="${FALLBACK}" selected>`), "pilihan tersimpan tampil terpilih");

  // Menyimpan tanpa memilih apa pun mematikan fallback kembali.
  const clear = new FormData();
  clear.append("default_fallback_model", "");
  await app.request("/dashboard/settings", { method: "POST", body: clear });
  assert.strictEqual(getSetting("default_fallback_model"), "");
});

test("settings - a stored fallback that is no longer available stays selectable", async () => {
  seed();
  setSetting("default_fallback_model", "provider-lama/model-lama");

  const html = await (await app.request("/dashboard/settings")).text();
  assert.ok(
    html.includes('<option value="provider-lama/model-lama" selected>provider-lama/model-lama (tidak aktif)</option>'),
    "nilai tersimpan yang tidak lagi dikenal tetap ditampilkan agar tidak hilang"
  );
});
