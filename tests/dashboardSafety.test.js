import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { app } from "../src/index.js";

// Ambil fungsi esc() yang didefinisikan di skrip topologi halaman Usage, lalu jalankan.
async function loadTopologyEsc() {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/usage")).text();
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const body = scripts.find((s) => s.includes("function renderTopology") || s.includes("topology-wrap"));
  assert.ok(body, "topology script rendered");
  const start = body.indexOf("function esc(s)");
  assert.ok(start !== -1, "topology esc() present");
  const end = body.indexOf("\n      }", start) + "\n      }".length;
  return new Function(`${body.slice(start, end)}; return esc;`)();
}

test("topology esc() neutralises quotes so an icon URL cannot break out of href", async () => {
  const esc = await loadTopologyEsc();
  const hostile = `/x.png" onerror="alert(1)`;
  const out = esc(hostile);
  // Kegagalan yang dicegah: kutip dari URL ikon menutup atribut href dan menyisipkan handler.
  assert.ok(!out.includes('"'), "no raw double quote survives");
  assert.ok(out.includes("&quot;"), "quote is entity-encoded");
});

test("topology esc() still encodes angle brackets and ampersands", async () => {
  const esc = await loadTopologyEsc();
  // Kegagalan yang dicegah: nama node berisi tag mentah dan dirender sebagai markup.
  assert.strictEqual(esc("<b>&</b>"), "&lt;b&gt;&amp;&lt;/b&gt;");
});
