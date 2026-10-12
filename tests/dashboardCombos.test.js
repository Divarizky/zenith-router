import test from "node:test";
import vm from "node:vm";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getDb } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { listCombos, getComboByName, createCombo } from "../src/services/combos.js";

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function seed() {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral Acc", credentials: { api_key: "mis-key" } });
  addConnection({ provider: "glm", name: "GLM Acc", credentials: { api_key: "glm-key" } });
}

test("GET /dashboard/combos - renders the combo page with a create form", async () => {
  seed();
  const res = await app.request("/dashboard/providers?tab=combos");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Combos"));
  assert.ok(html.includes("/dashboard/combos/create"));
  assert.ok(html.includes("Belum ada combo"));
});

test("GET /dashboard/combos - lists stored combos with their members", async () => {
  seed();
  await app.request("/dashboard/combos/create", {
    method: "POST",
    body: form({ name: "antai-utama", models: "mistral/mistral-large-latest\nglm/glm-4-flash" }),
  });

  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  assert.ok(html.includes("antai-utama"));
  assert.ok(html.includes("mistral/mistral-large-latest"));
  assert.ok(html.includes("glm/glm-4-flash"));

  const cardHtml = html.split('<div class="card combo-card">')[1] || "";
  assert.ok(cardHtml.includes("<h3>antai-utama</h3>"), "nama combo menjadi judul kartunya");
  assert.ok(cardHtml.includes('<span class="combo-card-label">'), "baris kartu tersusun memakai label");
  assert.ok(cardHtml.includes('value="antai-utama"'), "tombol aksi menempel di kartu combo itu");
  assert.ok(html.includes('<h3 class="combos-section-title">Combos (1)</h3>'), "judul bagian daftar combo ada");
});

test("POST /dashboard/combos/create - refuses a name that would shadow a provider guess", async () => {
  seed();
  const res = await app.request("/dashboard/combos/create", {
    method: "POST",
    body: form({ name: "claude-fast", models: "glm/glm-4-flash" }),
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(listCombos().length, 0);

  const location = res.headers.get("location");
  const html = await (await app.request(location)).text();
  assert.match(html, /berawalan nama model/);
});

test("POST /dashboard/combos/create - refuses a member no provider can serve", async () => {
  seed();
  const res = await app.request("/dashboard/combos/create", {
    method: "POST",
    body: form({ name: "antilog", models: "glm/glm-4-flash\nmodel-hantu" }),
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(listCombos().length, 0);

  const location = res.headers.get("location");
  assert.match(location, /error=1/);
  assert.match(decodeURIComponent(location), /model-hantu/);

  const html = await (await app.request(location)).text();
  assert.match(html, /model-hantu/);
});

test("POST /dashboard/combos/create then POST /v1 - the dashboard combo is what serves the request", async () => {
  seed();
  const created = await app.request("/dashboard/combos/create", {
    method: "POST",
    body: form({ name: "antai-utama", models: "mistral/mistral-large-latest\nglm/glm-4-flash" }),
  });
  assert.strictEqual(created.status, 302);

  const urls = [];
  setCustomExecutor({
    async execute({ url }) {
      urls.push(url);
      if (url.includes("api.mistral.ai")) {
        return new Response(JSON.stringify({ error: { message: "rate limit reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl_ok",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "dilayani anggota kedua" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 6 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "dilayani anggota kedua");
  assert.deepStrictEqual(urls.map((u) => u.includes("api.mistral.ai") ? "mistral" : "glm"), ["mistral", "glm"]);
  setCustomExecutor(null);
});

async function post(path, fields) {
  return app.request(path, { method: "POST", body: form(fields), redirect: "manual" });
}

async function createChain(name = "antai-utama", models = "mistral/mistral-large-latest\nglm/glm-4-flash") {
  seed();
  await post("/dashboard/combos/create", { name, models });
}

test("GET /dashboard/combos - every chain member gets an up and a down control", async () => {
  await createChain();
  const html = await (await app.request("/dashboard/providers?tab=combos")).text();

  assert.ok(html.includes("/dashboard/combos/reorder"), "form urutan harus ada");
  const rows = html.split('name="index"').length - 1;
  assert.strictEqual(rows, 2, "dua anggota berarti dua set tombol");
  assert.ok(html.includes('value="up"'));
  assert.ok(html.includes('value="down"'));
  assert.ok(html.includes("/dashboard/combos/toggle"), "tombol aktif/nonaktif harus ada");
  assert.ok(html.includes("/dashboard/combos/delete"), "tombol hapus harus ada");
  assert.ok(html.includes("/dashboard/combos/update"), "form ubah harus ada");
});

test("POST /dashboard/combos/reorder - the new order is what the next request uses", async () => {
  await createChain();

  const moved = await post("/dashboard/combos/reorder", { name: "antai-utama", index: "1", direction: "up" });
  assert.strictEqual(moved.status, 302);
  assert.deepStrictEqual(
    listCombos()[0].models,
    ["glm/glm-4-flash", "mistral/mistral-large-latest"]
  );

  const urls = [];
  setCustomExecutor({
    async execute({ url }) {
      urls.push(url.includes("api.mistral.ai") ? "mistral" : "glm");
      return new Response(
        JSON.stringify({
          id: "chatcmpl_ok",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });

  assert.deepStrictEqual(urls, ["glm"], "glm harus dicoba pertama setelah urutan diubah");
  setCustomExecutor(null);
});

test("POST /dashboard/combos/update - rewriting the chain is refused and the list stays put", async () => {
  await createChain();

  const res = await post("/dashboard/combos/update", {
    name: "antai-utama",
    strategy: "fallback",
    models: "glm/glm-4-flash\nmodel-hantu",
  });

  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get("location"), /error=1/);
  assert.deepStrictEqual(listCombos()[0].models, ["mistral/mistral-large-latest", "glm/glm-4-flash"]);
  assert.strictEqual(listCombos().length, 1, "tidak boleh ada combo baru yang tersesat");
});

test("POST /dashboard/combos/toggle - a disabled combo stops routing but keeps its definition", async () => {
  seed();
  await post("/dashboard/combos/create", { name: "antai-utama", models: "mistral/mistral-large-latest\nglm/glm-4-flash" });
  await post("/dashboard/combos/create", { name: "cadangan", models: "glm/glm-4-flash" });

  const modelsBefore = JSON.parse(await (await app.request("/v1/models")).text());
  const listed = modelsBefore.data.filter((m) => m.combo).map((m) => m.id);
  assert.deepStrictEqual(listed.sort(), ["antai-utama", "cadangan"], "combo aktif terdaftar di /v1/models");

  const off = await post("/dashboard/combos/toggle", { name: "antai-utama" });
  assert.strictEqual(off.status, 302);
  assert.strictEqual(listCombos().find((c) => c.name === "antai-utama").enabled, 0);

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });
  assert.strictEqual(res.status, 404);
  assert.strictEqual((await res.json()).error.code, "model_not_found");

  const after = JSON.parse(await (await app.request("/v1/models")).text());
  const stillListed = after.data.filter((m) => m.combo).map((m) => m.id);
  assert.deepStrictEqual(stillListed, ["cadangan"], "combo nonaktif hilang dari daftar model");
  assert.ok(!JSON.stringify(after).includes("antai-utama"));

  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  assert.ok(html.includes("antai-utama"), "definisi tetap tampil di dashboard");
  assert.ok(html.includes("Nonaktif"));

  // Mengaktifkan kembali mengembalikan routing.
  await post("/dashboard/combos/toggle", { name: "antai-utama" });
  assert.strictEqual(listCombos().find((c) => c.name === "antai-utama").enabled, 1);
});

test("POST /dashboard/combos/delete - the definition is gone and the name no longer routes", async () => {
  await createChain();

  const res = await post("/dashboard/combos/delete", { name: "antai-utama" });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get("location"), /deleted=1/);
  assert.strictEqual(listCombos().length, 0);

  const chat = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });
  assert.strictEqual(chat.status, 404, "nama yang dihapus tidak lagi jadi target routing");

  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  assert.ok(html.includes("Belum ada combo"));
});

test("POST /dashboard/combos/create - a chain cannot point at another combo", async () => {
  await createChain("rantai-luar", "mistral/mistral-large-latest");
  await post("/dashboard/combos/create", { name: "rantai-dalam", models: "glm/glm-4-flash" });

  const res = await post("/dashboard/combos/create", {
    name: "rantai-luar-tambahan",
    models: "rantai-dalam\nmistral/mistral-large-latest",
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(listCombos().length, 2, "daftar tidak boleh bertambah");
  const html = await (await app.request(res.headers.get("location"))).text();
  assert.match(html, /combo di dalam combo/);
});

test("POST /dashboard/combos/update - the strategy form persists a valid value and refuses an unknown one", async () => {
  await createChain();

  const ok = await post("/dashboard/combos/update", { name: "antai-utama", strategy: "fallback" });
  assert.strictEqual(ok.status, 302);
  assert.match(ok.headers.get("location"), /updated=1/);
  assert.strictEqual(getComboByName("antai-utama").strategy, "fallback");

  const bad = await post("/dashboard/combos/update", { name: "antai-utama", strategy: "acak" });
  assert.strictEqual(bad.status, 302);
  assert.match(bad.headers.get("location"), /error=1/);
  assert.match(decodeURIComponent(bad.headers.get("location")), /tidak dikenal/);
  assert.strictEqual(getComboByName("antai-utama").strategy, "fallback", "nilai lama harus bertahan");

  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  assert.ok(html.includes('value="fallback" selected'), "pilihan aktif harus tercentang");
});

test("POST /dashboard/combos/reorder - the chain endpoints do not wrap around", async () => {
  await createChain();
  const original = getComboByName("antai-utama").models;

  await post("/dashboard/combos/reorder", { name: "antai-utama", index: "0", direction: "up" });
  assert.deepStrictEqual(getComboByName("antai-utama").models, original);

  await post("/dashboard/combos/reorder", { name: "antai-utama", index: "1", direction: "down" });
  assert.deepStrictEqual(getComboByName("antai-utama").models, original);

  // Hanya kartu combo pertama yang dibaca; "combo-move" juga muncul di blok CSS.
  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  const cardHtml = html.split('<div class="card combo-card">')[1];
  const firstMember = cardHtml.split("combo-member")[1];
  assert.ok(firstMember.includes('value="up"'));
  assert.ok(/value="up"[^>]*disabled/.test(firstMember), "anggota pertama tidak punya tombol naik");
  assert.ok(!/value="down"[^>]*disabled/.test(firstMember), "anggota pertama masih bisa turun");
});

test("GET /dashboard/combos - a hand written legacy row cannot inject markup through the dashboard", async () => {
  seed();
  // Nama seperti ini bisa masuk lewat DB lama atau salin manual, bukan lewat service.
  const hostile = `x'><img src=x onerror=alert(1)>`;
  getDb()
    .prepare(
      `INSERT INTO combos (name, strategy, models, enabled, created_at, updated_at)
       VALUES (?, 'fallback', '[]', 1, 0, 0)`
    )
    .run(hostile);

  const res = await app.request("/dashboard/providers?tab=combos");
  assert.strictEqual(res.status, 200);
  const html = await res.text();

  assert.ok(!html.includes("<img src=x"), "tag mentah tidak boleh sampai ke HTML");
  assert.ok(html.includes("&lt;img src=x"), "nama tetap tampil, asal ter-escape");
  const handler = html.match(/onsubmit="return confirm\([^)]*\)"/g) || [];
  assert.ok(handler.length > 0);
  for (const h of handler) assert.ok(!h.includes("onerror"), `handler tidak boleh memuat data: ${h}`);
});

test("POST /dashboard/combos/create - a member that would die at the upstream is rejected", async () => {
  seed();
  const before = listCombos().length;

  for (const bad of ["gpt-oss:20b", "glm/", "glm/ glm-4-flash"]) {
    const res = await post("/dashboard/combos/create", { name: "nyasar", models: bad });
    assert.strictEqual(res.status, 302);
    assert.match(res.headers.get("location"), /error=1/, `${bad} harus ditolak`);
  }

  assert.strictEqual(listCombos().length, before, "daftar tidak boleh berubah");
});

test("POST /dashboard/combos - delete and toggle report a missing combo instead of failing silently", async () => {
  await createChain();

  const del = await post("/dashboard/combos/delete", { name: "entah" });
  assert.strictEqual(del.status, 302);
  assert.match(del.headers.get("location"), /error=1/);
  assert.match(decodeURIComponent(del.headers.get("location")), /tidak ada/);

  const tog = await post("/dashboard/combos/toggle", { name: "entah" });
  assert.strictEqual(tog.status, 302);
  assert.match(tog.headers.get("location"), /error=1/);

  assert.strictEqual(listCombos().length, 1, "combo yang ada tidak boleh tersentuh");
});

test("POST /dashboard/combos/update - a stray space around the strategy is forgiven", async () => {
  await createChain();

  const res = await post("/dashboard/combos/update", { name: "antai-utama", strategy: "  fallback  " });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get("location"), /updated=1/);
  assert.strictEqual(getComboByName("antai-utama").strategy, "fallback");
});

test("GET /v1/models - a combo entry rolls up capabilities and the smallest context window", async () => {
  await createChain("antai-utama", "mistral/mistral-large-latest\nglm/glm-4-flash\nollama/gpt-oss:20b");

  const models = JSON.parse(await (await app.request("/v1/models")).text());
  const entry = models.data.find((m) => m.id === "antai-utama");

  assert.strictEqual(entry.owned_by, "combo");
  // mistral-large vision+256k, glm-4 reasoning+200k, gpt-oss reasoning+128k.
  assert.deepStrictEqual(entry.capabilities, { vision: true, reasoning: true });
  assert.strictEqual(entry.context_length, 128000, "ukuran konteks adalah anggota tersempit");
  assert.strictEqual(entry.combo, true);
});

test("GET /v1/models - a combo whose members are unknown claims nothing", async () => {
  seed();
  await post("/dashboard/combos/create", { name: "tanpa-data", models: "ollama/zzz-unknown-9000" });

  const models = JSON.parse(await (await app.request("/v1/models")).text());
  const entry = models.data.find((m) => m.id === "tanpa-data");

  assert.ok(entry, "combo tetap terdaftar");
  assert.strictEqual(entry.capabilities, undefined, "tanpa data kemampuan, tanpa klaim");
  assert.strictEqual(entry.context_length, undefined);
});

test("GET /dashboard/combos - the create form offers a model picker dialog", async () => {
  initDb(":memory:");

  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  assert.match(html, /<div class="modal-backdrop" id="model-picker-modal">/, "dialog pemilih model ada dan memakai pola modal");
  assert.ok(html.includes("/api/models"), "dialog mengambil daftar model dari endpoint");

  const createForm = html.match(/<form action="\/dashboard\/combos\/create"[\s\S]*?<\/form>/)?.[0] || "";
  assert.ok(createForm.includes("data-picker-open"), "form buat punya pemicu dialog");
  assert.ok(createForm.includes('class="combo-selected"'), "wadah preview rantai terpilih ada");
  assert.ok(createForm.includes('name="models"'), "textarea tetap ada sebagai sumber kebenaran tanpa JavaScript");
});

test("GET /dashboard/combos - every chain rewrite can open the same picker", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Key", credentials: { api_key: "k1" } });
  createCombo({ name: "antai-utama", models: ["glm/glm-4-flash"] });

  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  const editors = (html.match(/<details[^>]*>[\s\S]*?<\/details>/g) || []).find((d) => d.includes("combo-chain-editor")) || "";
  assert.ok(editors.includes('data-picker-open'), "bagian ganti rantai punya pemicu dialog yang sama");
  assert.ok(/<textarea name="models"[^>]*>glm\/glm-4-flash/.test(editors), "textarea edit tetap terisi rantai tersimpan");
});

test("GET /dashboard/combos - every inline script compiles, so the picker buttons are not dead", async () => {
  initDb(":memory:");

  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, "halaman punya skrip inline");
  for (const [i, src] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(src), `skrip inline #${i} harus valid secara sintaks`);
  }
});

/** DOM tiruan secukupnya untuk menjalankan skrip picker tanpa browser. */
function fakeEl(extra = {}) {
  let children = [];
  const el = {
    handlers: {},
    value: "",
    hidden: false,
    className: "",
    get children() {
      return children;
    },
    set textContent(v) {
      if (v === "") children = [];
    },
    appendChild(child) {
      children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      el.handlers[type] = fn;
    },
    click() {
      el.handlers.click?.();
    },
    ...extra,
  };
  return el;
}

async function runPickerScript(html, providers, { rejectFetch = false } = {}) {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((src) => src.includes("combo-picker-list"));
  const listEl = fakeEl();
  const searchEl = fakeEl();
  const selected = fakeEl();
  const ta = fakeEl({ value: "" });
  const wrap = fakeEl({ querySelector: (sel) => (sel.includes("textarea") ? ta : null) });
  const trigger = fakeEl({ closest: () => wrap });
  ta.parentElement = fakeEl({ querySelector: () => selected });
  const opened = [];

  const sandbox = {
    document: {
      getElementById: (id) => (id === "combo-picker-list" ? listEl : id === "combo-picker-search" ? searchEl : null),
      querySelectorAll: (sel) => (sel === "[data-picker-open]" ? [trigger] : sel === ".combo-chain-editor" ? [wrap] : []),
      createElement: () => fakeEl(),
    },
    fetch: async () => {
      if (rejectFetch) throw new Error("jaringan putus");
      return { ok: true, json: async () => ({ providers }) };
    },
    openModal: (id) => opened.push(id),
  };
  vm.runInNewContext(script, sandbox);
  return { ta, trigger, listEl, selected, opened };
}

const PICKER_FIXTURE = [
  { id: "glm", name: "GLM", icon: null, models: [{ id: "glm/glm-4-flash", capabilities: { vision: false, reasoning: false } }] },
];

test("GET /dashboard/combos - pressing the picker button opens the dialog and lists models", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  const page = await runPickerScript(html, PICKER_FIXTURE);

  assert.strictEqual(page.ta.hidden, true, "textarea mentah disembunyikan saat picker aktif");

  page.trigger.click();
  assert.deepStrictEqual(page.opened, ["model-picker-modal"], "tombol membuka dialog");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(page.listEl.children.length > 0, "daftar model terisi setelah dialog dibuka");
});

test("GET /dashboard/combos - choosing a model in the dialog adds it to the chain preview", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  assert.match(
    html,
    /\.combo-selected\s*\{[^}]*flex-direction:\s*column/,
    "preview rantai tersusun vertikal satu model per baris"
  );
  const page = await runPickerScript(html, PICKER_FIXTURE);

  page.trigger.click();
  await new Promise((r) => setTimeout(r, 0));
  const row = page.listEl.children.find((c) => c.className === "picker-row");
  assert.ok(row, "ada baris model yang bisa diklik");
  row.click();

  assert.strictEqual(page.ta.value, "glm/glm-4-flash", "model terpilih masuk ke rantai");
  assert.ok(page.selected.children.length > 0, "preview rantai menampilkan model terpilih");
  const item = page.selected.children[0];
  const actions = item.children.find((c) => c.className === "combo-selected-actions");
  assert.ok(actions, "tiap baris punya wadah tombol aksi (naik, turun, hapus)");
});

test("GET /dashboard/combos - the textarea comes back when the model list cannot load", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  const page = await runPickerScript(html, null);

  page.trigger.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(page.ta.hidden, false, "textarea muncul lagi supaya rantai tetap bisa ditulis manual");
});

test("GET /dashboard/combos - the hidden textarea is not required, so the form never stalls silently", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  const createForm = html.match(/<form action="\/dashboard\/combos\/create"[\s\S]*?<\/form>/)?.[0] || "";
  assert.ok(!/<textarea[^>]*\brequired\b/.test(createForm));
});

test("GET /dashboard/combos - the textarea also comes back when the request itself fails", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  const page = await runPickerScript(html, PICKER_FIXTURE, { rejectFetch: true });

  page.trigger.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(page.ta.hidden, false);
});

test("POST /dashboard/combos/rename - the combo answers to its new name there", async () => {
  seed();
  await app.request("/dashboard/combos/create", {
    method: "POST",
    body: form({ name: "antai-utama", models: "mistral/mistral-large-latest\nglm/glm-4-flash" }),
  });

  const res = await post("/dashboard/combos/rename", { name: "antai-utama", new_name: "antai-baru" });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get("location"), /^\/dashboard\/providers\?tab=combos&updated=1$/, "tujuan redirect menunjuk tab Combos");

  const combos = listCombos();
  assert.strictEqual(combos.length, 1, "rename bukan create");
  assert.strictEqual(combos[0].name, "antai-baru");
  assert.deepStrictEqual(combos[0].models, ["mistral/mistral-large-latest", "glm/glm-4-flash"]);

  // Nama baru adalah kunci routing: request memakai nama baru harus terlayani,
  // nama lama tidak dikenali lagi.
  setCustomExecutor({
    async execute({ url }) {
      if (url.includes("api.mistral.ai")) {
        return new Response(JSON.stringify({ error: { message: "rate limit reached" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl_ok",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 6 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });
  const routed = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-baru", messages: [{ role: "user", content: "halo" }] }),
  });
  assert.strictEqual(routed.status, 200, "nama baru yang merutekan");
  setCustomExecutor(null);

  const oldName = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "antai-utama", messages: [{ role: "user", content: "halo" }] }),
  });
  assert.notStrictEqual(oldName.status, 200, "nama lama sudah tidak dikenali");
});

test("POST /dashboard/combos/rename - a taken name is refused and both combos survive", async () => {
  seed();
  await app.request("/dashboard/combos/create", {
    method: "POST",
    body: form({ name: "antai-utama", models: "mistral/mistral-large-latest" }),
  });
  await app.request("/dashboard/combos/create", {
    method: "POST",
    body: form({ name: "antai-cadangan", models: "glm/glm-4-flash" }),
  });

  const res = await post("/dashboard/combos/rename", { name: "antai-utama", new_name: "antai-cadangan" });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.get("location"), /error=1/);

  const names = listCombos().map((c) => c.name).sort();
  assert.deepStrictEqual(names, ["antai-cadangan", "antai-utama"], "kedua combo tetap dengan nama aslinya");
});

test("GET /dashboard/combos - the card offers a rename form prefilled with the name", async () => {
  seed();
  await app.request("/dashboard/combos/create", {
    method: "POST",
    body: form({ name: "antai-utama", models: "glm/glm-4-flash" }),
  });

  const html = await (await app.request("/dashboard/providers?tab=combos")).text();
  const cardHtml = (html.split('<div class="card combo-card">')[1] || "").split('<div class="modal-backdrop"')[0];
  assert.ok(cardHtml.includes('action="/dashboard/combos/rename"'), "form rename menempel di kartu combo");
  assert.match(cardHtml, /<input[^>]*name="new_name"[^>]*value="antai-utama"/, "input terprefill nama lama");
  assert.ok(cardHtml.includes(">Edit</summary>"), "rename dan rantai menyatu di satu bagian Edit");
  assert.strictEqual(cardHtml.split("<details").length - 1, 1, "satu-satunya bagian terlipat di kartu adalah Edit");
});

test("GET /dashboard/combos - the old page redirects to the Combos tab, keeping the query", async () => {
  initDb(":memory:");

  const bare = await app.request("/dashboard/combos", { redirect: "manual" });
  assert.strictEqual(bare.status, 302);
  assert.strictEqual(bare.headers.get("location"), "/dashboard/providers?tab=combos");

  const withNotice = await app.request("/dashboard/combos?created=1", { redirect: "manual" });
  assert.strictEqual(withNotice.status, 302);
  assert.strictEqual(withNotice.headers.get("location"), "/dashboard/providers?tab=combos&created=1");
});

test("GET /dashboard/providers - the nav drops Combos and the page offers both tabs", async () => {
  initDb(":memory:");

  const html = await (await app.request("/dashboard/providers")).text();
  assert.ok(!html.includes('<a href="/dashboard/combos"'), "menu Combos tidak lagi ada di nav atas");
  assert.ok(html.includes("<span>Providers & Combos</span>"), "label sidebar mencakup Combos");
  assert.ok(html.includes('href="/dashboard/providers?tab=combos"'), "tab Combos terpasang");
  assert.match(html, /<a class="page-tab active" href="\/dashboard\/providers">Providers<\/a>/, "tab Providers aktif secara default");

  const combosHtml = await (await app.request("/dashboard/providers?tab=combos")).text();
  assert.match(combosHtml, /<a class="page-tab active" href="\/dashboard\/providers\?tab=combos">Combos<\/a>/, "tab Combos aktif saat ?tab=combos");
  assert.ok(combosHtml.includes("Buat Combo"), "isi tab Combos adalah halaman combo");
  assert.ok(!combosHtml.includes('class="card provider-card"'), "tab Combos tidak ikut merender kartu provider");
});
