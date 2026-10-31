import test from "node:test";
import assert from "node:assert";
import { initDb, addProxyPool } from "../src/db/index.js";
import { createApiKey } from "../src/services/apiKeys.js";
import { createCombo } from "../src/services/combos.js";
import { renderApiKeysPage } from "../src/ui/pages/apiKeys.js";
import { app } from "../src/index.js";

test("rendered dashboard never calls the browser confirm() dialog", async () => {
  initDb(":memory:");
  for (const p of ["/dashboard/providers", "/dashboard/proxies", "/dashboard/combos", "/dashboard/settings", "/dashboard/keys"]) {
    const html = await (await app.request(p)).text();
    // Kegagalan yang dicegah: dialog bawaan browser tampil, tidak bertema dan tidak bisa diuji.
    // Hanya pemanggilan di dalam atribut handler yang diperiksa; komentar CSS tidak ikut.
    const handlers = [...html.matchAll(/\s(?:onclick|onsubmit)="([^"]*)"/g)].map((m) => m[1]);
    for (const h of handlers) {
      assert.ok(!/\bconfirm\s*\(/.test(h), `${p} handler still calls confirm(): ${h}`);
      assert.ok(!/\bconfirmSelected\s*\(/.test(h), `${p} handler still calls confirmSelected(): ${h}`);
    }
  }
});

test("confirm dialog is a labelled modal with cancel as the safe default", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/keys")).text();
  const start = html.indexOf('id="zr-confirm"');
  assert.ok(start !== -1, "dialog root rendered");
  const dialog = html.slice(start, html.indexOf('<script src="/zr-live.js"', start));
  // Kegagalan yang dicegah: screen reader tidak mengumumkan dialog, atau fokus tidak
  // bisa dikendalikan karena tidak ada role/aria-modal.
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /aria-labelledby="zr-confirm-title"/);
  assert.match(dialog, /id="zr-confirm-title"/);
  // Kegagalan yang dicegah: tombol Batal tidak bisa dijangkau sebagai pilihan aman.
  assert.match(dialog, /<button type="button" class="btn" id="zr-confirm-cancel">Batal<\/button>/);
});

test("destructive forms declare their confirmation message", async () => {
  initDb(":memory:");
  addProxyPool({ name: "uji", url: "http://127.0.0.1:9" });
  createCombo({ name: "uji-combo", models: ["mistral/mistral-large-latest"] });
  const pages = [
    ["/dashboard/proxies", "Hapus proxy ini dari daftar?"],
    ["/dashboard/providers?tab=combos", "Hapus combo ini beserta definisinya?"],
    ["/dashboard/settings", "Kembalikan password dashboard ke default (123456)? Password saat ini tetap diperlukan."],
  ];
  for (const [p, message] of pages) {
    const html = await (await app.request(p)).text();
    // Kegagalan yang dicegah: aksi hapus langsung terkirim tanpa konfirmasi.
    assert.ok(html.includes(`data-confirm="${message}"`), `${p} missing confirm for: ${message}`);
  }
});

test("creating an API key warns that the value is shown once and offers copy", async () => {
  initDb(":memory:");
  const created = createApiKey("uji");
  const html = renderApiKeysPage(20120, created);
  // Kegagalan yang dicegah: pengguna kehilangan kunci karena tidak tahu hanya muncul sekali.
  assert.ok(html.includes("tidak bisa dilihat lagi"), "one-time warning present");
  assert.ok(html.includes('data-copy-target="new-api-key"'), "copy button points at the key element");
  assert.ok(html.includes(`id="new-api-key"`), "copy target element exists");
  assert.ok(html.includes(created.key), "key itself is rendered once");
});
