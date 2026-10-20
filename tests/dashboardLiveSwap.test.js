import test from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";

const ENGINE_SRC = readFileSync(new URL("../public/zr-live.js", import.meta.url), "utf8");
const PAGE_URL = "http://127.0.0.1:20120/dashboard/usage";

/** Elemen tiruan: getAttribute hanya mengembalikan atribut yang benar-benar ditulis di HTML. */
function fakeEl(tagName, attrs = {}, props = {}) {
  return {
    tagName,
    classList: { add() {}, remove() {} },
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(attrs, name),
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    setAttribute: (name, value) => { attrs[name] = String(value); },
    removeAttribute: (name) => { delete attrs[name]; },
    querySelector: () => null,
    ...props,
  };
}

/**
 * Jalankan engine di sandbox lalu kirim satu submit. Properti formAction tiruan meniru
 * browser: tanpa atribut formaction ia mengembalikan URL halaman, sumber bug 404.
 */
function submitThroughEngine({ formAttrs, fields, submitterAttrs = {}, submitterName, submitterValue }) {
  const calls = [];
  let onSubmit = null;
  const form = fakeEl("FORM", { ...formAttrs }, { action: PAGE_URL, __fields: fields });
  const submitter = fakeEl("BUTTON", { ...submitterAttrs }, {
    formAction: submitterAttrs.formaction || PAGE_URL,
    name: submitterName || "",
    value: submitterValue || "",
  });
  class SandboxFormData {
    constructor(f) { this.entries = Object.entries((f && f.__fields) || {}); }
    append(k, v) { this.entries.push([k, String(v)]); }
    forEach(fn) { this.entries.forEach(([k, v]) => fn(v, k)); }
  }
  const sandbox = {
    URL,
    FormData: SandboxFormData,
    setTimeout: () => 0,
    window: { location: { href: PAGE_URL, origin: "http://127.0.0.1:20120", pathname: "/dashboard/usage" } },
    document: {
      addEventListener: (type, fn) => { if (type === "submit") onSubmit = fn; },
      body: { appendChild() {} },
      createElement: () => fakeEl("DIV"),
    },
    fetch: (url, init) => {
      calls.push({ url: String(url), init });
      return new Promise(() => {});
    },
  };
  vm.runInNewContext(ENGINE_SRC, sandbox);
  assert.ok(onSubmit, "engine memasang listener submit");
  onSubmit({ defaultPrevented: false, target: form, submitter, preventDefault() {} });
  return calls;
}

test("no-reload - submit dikirim ke action form, bukan URL halaman (regresi 404)", () => {
  const calls = submitThroughEngine({
    formAttrs: { action: "/dashboard/quota/sync", method: "POST" },
    fields: { id: "29" },
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(new URL(calls[0].url).pathname, "/dashboard/quota/sync");
  assert.strictEqual(calls[0].init.method, "POST");
});

test("no-reload - atribut formaction dan formmethod tombol tetap dihormati", () => {
  const calls = submitThroughEngine({
    formAttrs: { id: "models-bulk-form", method: "POST" },
    fields: { provider: "glm" },
    submitterAttrs: { formaction: "/dashboard/providers/models/import/delete", formmethod: "post" },
  });
  assert.strictEqual(new URL(calls[0].url).pathname, "/dashboard/providers/models/import/delete");
  assert.strictEqual(calls[0].init.method, "POST");
});

test("no-reload - name/value tombol yang diklik ikut terkirim (tombol ↑↓)", () => {
  const calls = submitThroughEngine({
    formAttrs: { action: "/dashboard/providers/accounts/move", method: "POST" },
    fields: { id: "29" },
    submitterName: "direction",
    submitterValue: "down",
  });
  const sent = Object.fromEntries(calls[0].init.body.entries);
  assert.deepStrictEqual(sent, { id: "29", direction: "down" });
});

test("no-reload - engine swap tersedia sebagai static JS", async () => {
  const res = await app.request("/zr-live.js");
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /javascript/);
  const js = await res.text();
  assert.ok(js.includes("__zrSwapInit"), "registry init untuk inisialisasi ulang setelah swap");
  assert.ok(js.includes("__zrSwapCleanups"), "registry cleanup untuk timer/EventSource halaman lama");
  assert.ok(js.includes('"submit"'), "interceptor submit memakai delegation di document");
  assert.ok(js.includes("data-once"), "script sekali-jalan tidak dieksekusi ulang saat swap");
});

test("no-reload - layout memuat engine dan menandai script dasar data-once", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard")).text();
  assert.ok(html.includes('<script src="/zr-live.js" data-once></script>'));
  assert.ok(html.includes("<script data-once>"), "script dasar layout harus dilewati re-exec");
  assert.ok(!html.includes("data-native"), "tidak ada form yang sengaja kembali ke submit normal");
});

test("no-reload - kontrak server form dashboard tetap redirect untuk fallback non-JS", async () => {
  initDb(":memory:");
  const body = new FormData();
  body.append("require_api_key", "false");
  const res = await app.request("/dashboard/settings", { method: "POST", body });
  assert.strictEqual(res.status, 302, "handler tetap redirect; engine mengikuti redirect lalu swap");
  assert.ok(res.headers.get("location").startsWith("/dashboard/settings"));
});
