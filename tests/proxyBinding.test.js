import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { app } from "../src/index.js";
import {
  initDb,
  addConnection,
  getConnectionById,
  getConnections,
  addProxyPool,
  moveConnection,
} from "../src/db/index.js";
import {
  resolveConnectionProxy,
  requireResolvedProxy,
  updateProxyPoolBindings,
  listProxyPools,
} from "../src/services/proxyPools.js";
import { setCustomExecutor } from "../src/executors/base.js";

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function seedChat() {
  initDb(":memory:");
}

test("resolver - list beats manual beats direct, inactive list blocks the account", () => {
  seedChat();
  const pool = addProxyPool({ name: "utama", url: "http://pool.local:3128" });
  const off = addProxyPool({ name: "mati", url: "http://off.local:3128", is_active: 0 });

  const inList = resolveConnectionProxy({ proxy_pool_id: pool.id, proxy_url: "http://manual.local:1" });
  assert.strictEqual(inList.blocked, false);
  assert.strictEqual(inList.proxyUrl, "http://pool.local:3128", "daftar diprioritaskan");

  const manual = resolveConnectionProxy({ proxy_url: "http://manual.local:1" });
  assert.strictEqual(manual.blocked, false);
  assert.strictEqual(manual.proxyUrl, "http://manual.local:1");

  const direct = resolveConnectionProxy({});
  assert.strictEqual(direct.blocked, false);
  assert.strictEqual(direct.proxyUrl, null);

  const blocked = resolveConnectionProxy({ proxy_pool_id: off.id });
  assert.strictEqual(blocked.blocked, true, "pool nonaktif memblokir akun");
  assert.strictEqual(blocked.proxyUrl, null);

  const orphan = resolveConnectionProxy({ proxy_pool_id: 99999 });
  assert.strictEqual(orphan.blocked, true, "pool terhapus tetap memblokir");

  assert.throws(
    () => requireResolvedProxy({ proxy_pool_id: off.id }),
    /nonaktif/,
    "jalur lalu lintas menolak akun terblokir, bukan jatuh ke langsung"
  );
});

test("chat - account traffic uses its effective proxy in list, manual, direct order", async () => {
  seedChat();
  const pool = addProxyPool({ name: "utama", url: "http://pool.local:3128" });
  const a = addConnection({
    provider: "glm",
    name: "GLM List",
    credentials: { api_key: "key-list" },
    proxy_pool_id: pool.id,
    proxy_url: "http://manual.local:1",
  });
  const b = addConnection({
    provider: "glm",
    name: "GLM Manual",
    credentials: { api_key: "key-manual" },
    proxy_url: "http://manual.local:1",
  });
  const c = addConnection({ provider: "glm", name: "GLM Direct", credentials: { api_key: "key-direct" } });

  const calls = [];
  setCustomExecutor({
    async execute({ headers, proxyUrl }) {
      calls.push({ auth: headers.Authorization, proxyUrl });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    for (const [i, target] of [a, b, c].entries()) {
      // Routing always takes #1, so raise each account to the top in turn.
      while (getConnections("glm")[0].id !== target.id) moveConnection(target.id, "up");
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.strictEqual(res.status, 200, `request ke-${i} harus sukses`);
    }
  } finally {
    setCustomExecutor(null);
  }

  assert.strictEqual(calls.length, 3, "tiga request, tiga akun berbeda (masing-masing di #1)");
  const byAuth = new Map(calls.map((x) => [x.auth, x.proxyUrl]));
  assert.strictEqual(byAuth.get("Bearer key-list"), "http://pool.local:3128", "akun daftar memakai proxy daftar");
  assert.strictEqual(byAuth.get("Bearer key-manual"), "http://manual.local:1", "akun manual memakai alamat manual");
  assert.strictEqual(byAuth.get("Bearer key-direct"), null, "tanpa pilihan = koneksi langsung");
  assert.ok(a.id && b.id && c.id);
});

test("chat - account bound to an inactive list proxy is skipped, never sent direct", async () => {
  seedChat();
  const off = addProxyPool({ name: "mati", url: "http://off.local:3128", is_active: 0 });
  addConnection({
    provider: "glm",
    name: "Terblokir",
    credentials: { api_key: "key-blocked" },
    proxy_pool_id: off.id,
  });

  const calls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calls.push(proxyUrl);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.strictEqual(res.status, 503, "satu-satunya akun terblokir -> tidak ada akun tersedia");
    const body = await res.json();
    assert.ok(
      JSON.stringify(body).includes("no_available_connection"),
      `pesan error tidak ada akun yang tersedia: ${JSON.stringify(body)}`
    );
    assert.strictEqual(calls.length, 0, "akun terblokir tidak pernah menghasilkan request");

    // Dengan akun sehat lain, permintaan dilayani oleh akun itu tanpa menyentuh yang terblokir.
    addConnection({ provider: "glm", name: "Sehat", credentials: { api_key: "key-sehat" } });
    const ok = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(calls.length, 1, "hanya akun sehat yang dipanggil");
    assert.strictEqual(calls[0], null, "akun sehat tetap langsung");
  } finally {
    setCustomExecutor(null);
  }
});

test("guard - no traffic path reads the manual proxy address outside the resolver", () => {
  const files = [
    "src/services/fallback.js",
    "src/services/tokenRefresh.js",
    "src/services/modelImport.js",
    "src/services/quota/antigravity.js",
    "src/services/quota/claude.js",
    "src/services/quota/codex.js",
    "src/services/quota/github.js",
    "src/services/quota/glm.js",
    "src/services/quota/kiro.js",
    "src/services/quota/ollama.js",
    "src/services/quota/openrouter.js",
    "src/services/quota/xkiro.js",
  ];
  for (const file of files) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(
      !/\.proxy_url\b/.test(src),
      `${file} membaca alamat proxy manual langsung; wajib lewat resolveConnectionProxy`
    );
  }
});

test("account form - manual proxy uses the same validation as the proxy list", async () => {
  seedChat();
  const res = await app.request("/dashboard/providers/accounts/add", {
    method: "POST",
    body: form({ provider: "glm", name: "Salah", api_key: "k", proxy_url: "https://host:1" }),
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(getConnections("glm").length, 0, "https:// ditolak, akun tidak tersimpan");

  const ok = await app.request("/dashboard/providers/accounts/add", {
    method: "POST",
    body: form({ provider: "glm", name: "Benar", api_key: "k", proxy_url: "http://host:1" }),
  });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(getConnections("glm").length, 1, "http:// diterima");
  assert.strictEqual(getConnections("glm")[0].proxy_url, "http://host:1");
});

test("account form - proxy picker choices are stored on the connection", async () => {
  seedChat();
  const pool = addProxyPool({ name: "rute", url: "http://pool.local:3128" });

  await app.request("/dashboard/providers/accounts/add", {
    method: "POST",
    body: form({ provider: "glm", name: "PakaiList", api_key: "k1", proxy_choice: `pool:${pool.id}` }),
  });
  await app.request("/dashboard/providers/accounts/add", {
    method: "POST",
    body: form({ provider: "glm", name: "PakaiDirect", api_key: "k2", proxy_choice: "" }),
  });

  const rows = getConnections("glm");
  assert.strictEqual(rows[0].proxy_pool_id, pool.id, "pilihan daftar tersimpan");
  assert.strictEqual(rows[0].proxy_url, null);
  assert.strictEqual(rows[1].proxy_pool_id, null, "koneksi langsung tersimpan");
  assert.strictEqual(rows[1].proxy_url, null);
});

test("account row - set-proxy route rebinds list, manual, and direct", async () => {
  seedChat();
  const pool = addProxyPool({ name: "rute", url: "http://pool.local:3128" });
  const acc = addConnection({ provider: "glm", name: "A", credentials: { api_key: "k" }, proxy_url: "http://m:1" });

  await app.request("/dashboard/providers/accounts/set-proxy", {
    method: "POST",
    body: form({ id: String(acc.id), provider: "glm", proxy_choice: `pool:${pool.id}` }),
  });
  let row = getConnectionById(acc.id);
  assert.strictEqual(row.proxy_pool_id, pool.id, "pindah ke daftar");
  assert.strictEqual(row.proxy_url, "http://m:1", "alamat manual lama tidak disentuh");

  await app.request("/dashboard/providers/accounts/set-proxy", {
    method: "POST",
    body: form({ id: String(acc.id), provider: "glm", proxy_choice: "direct" }),
  });
  row = getConnectionById(acc.id);
  assert.strictEqual(row.proxy_pool_id, null, "kembali langsung");
  assert.strictEqual(row.proxy_url, null, "alamat manual dibersihkan");

  await app.request("/dashboard/providers/accounts/set-proxy", {
    method: "POST",
    body: form({ id: String(acc.id), provider: "glm", proxy_choice: "manual", proxy_url: "https://x:1" }),
  });
  row = getConnectionById(acc.id);
  assert.strictEqual(row.proxy_pool_id, null);
  assert.strictEqual(row.proxy_url, null, "manual invalid tidak mengubah apapun");

  const bad = await app.request("/dashboard/providers/accounts/set-proxy", {
    method: "POST",
    body: form({ id: String(acc.id), provider: "glm", proxy_choice: "manual", proxy_url: "https://x:1" }),
  });
  assert.ok(bad.headers.get("location").includes("proxy_invalid"), "alasan ditolak diumumkan");
});

test("provider detail - proxy picker appears in the add form and per account row", async () => {
  seedChat();
  const pool = addProxyPool({ name: "tampil", url: "http://pool.local:3128" });
  const acc = addConnection({
    provider: "glm",
    name: "Row",
    credentials: { api_key: "k" },
    proxy_pool_id: pool.id,
  });

  let res = await app.request("/dashboard/providers/glm");
  if (res.status >= 300 && res.status < 400) res = await app.request(res.headers.get("location"));
  const html = await res.text();
  assert.ok(html.includes('name="proxy_choice"'), "form akun punya pilihan proxy");
  assert.ok(html.includes(`value="pool:${pool.id}"`), "daftar proxy muncul sebagai opsi");
  assert.ok(html.includes("Daftar: tampil"), "baris akun menampilkan proxy daftar yang dipakai");
  assert.ok(html.includes("/dashboard/providers/accounts/set-proxy"), "baris akun punya form ganti proxy");
  assert.ok(acc.id);
});

test("updateProxyPoolBindings - binds newly checked accounts and clears manual proxy_url", () => {
  seedChat();
  const pool = addProxyPool({ name: "pool-a", url: "http://pool-a.local:3128" });
  const a = addConnection({ provider: "glm", name: "Acc A", credentials: { api_key: "k1" }, proxy_url: "http://manual.local:8080" });
  const b = addConnection({ provider: "openai", name: "Acc B", credentials: { api_key: "k2" } });
  const c = addConnection({ provider: "anthropic", name: "Acc C", credentials: { api_key: "k3" } });

  // Bind accounts A and B to pool
  updateProxyPoolBindings(pool.id, [a.id, b.id]);

  const rowA = getConnectionById(a.id);
  const rowB = getConnectionById(b.id);
  const rowC = getConnectionById(c.id);

  assert.strictEqual(rowA.proxy_pool_id, pool.id, "Akun A terikat ke pool");
  assert.strictEqual(rowA.proxy_url, null, "Alamat proxy manual A dibersihkan");
  assert.strictEqual(rowB.proxy_pool_id, pool.id, "Akun B terikat ke pool");
  assert.strictEqual(rowC.proxy_pool_id, null, "Akun C tidak disentuh (tetap null)");
});

test("updateProxyPoolBindings - unbinds unchecked accounts from this pool without disturbing other pools", () => {
  seedChat();
  const pool1 = addProxyPool({ name: "pool-1", url: "http://pool-1.local:3128" });
  const pool2 = addProxyPool({ name: "pool-2", url: "http://pool-2.local:3128" });

  const a = addConnection({ provider: "glm", name: "Acc A", credentials: { api_key: "k1" }, proxy_pool_id: pool1.id });
  const b = addConnection({ provider: "glm", name: "Acc B", credentials: { api_key: "k2" }, proxy_pool_id: pool1.id });
  const c = addConnection({ provider: "openai", name: "Acc C", credentials: { api_key: "k3" }, proxy_pool_id: pool2.id });

  // Update pool 1 to only bind B (A unchecked)
  updateProxyPoolBindings(pool1.id, [b.id]);

  const rowA = getConnectionById(a.id);
  const rowB = getConnectionById(b.id);
  const rowC = getConnectionById(c.id);

  assert.strictEqual(rowA.proxy_pool_id, null, "Akun A dilepaskan dari pool 1");
  assert.strictEqual(rowB.proxy_pool_id, pool1.id, "Akun B tetap terikat ke pool 1");
  assert.strictEqual(rowC.proxy_pool_id, pool2.id, "Akun C di pool 2 tidak terganggu");
});

test("handleUpdateProxy - updates account bindings when bound_accounts_present sentinel is passed", async () => {
  seedChat();
  const pool = addProxyPool({ name: "pool-update", url: "http://pool.local:3128" });
  const a = addConnection({ provider: "glm", name: "Acc A", credentials: { api_key: "k1" } });
  const b = addConnection({ provider: "glm", name: "Acc B", credentials: { api_key: "k2" } });

  // 1. Submit with multiple bound_connection_ids
  const fd1 = form({
    id: String(pool.id),
    name: "pool-update",
    url: "http://pool.local:3128",
    bound_accounts_present: "1",
  });
  fd1.append("bound_connection_ids", String(a.id));
  fd1.append("bound_connection_ids", String(b.id));

  const res1 = await app.request("/dashboard/proxies/update", {
    method: "POST",
    body: fd1,
  });
  assert.strictEqual(res1.status, 302);
  assert.strictEqual(getConnectionById(a.id).proxy_pool_id, pool.id);
  assert.strictEqual(getConnectionById(b.id).proxy_pool_id, pool.id);

  // 2. Submit with single bound_connection_ids (only account A)
  const fd2 = form({
    id: String(pool.id),
    name: "pool-update",
    url: "http://pool.local:3128",
    bound_accounts_present: "1",
    bound_connection_ids: String(a.id),
  });

  const res2 = await app.request("/dashboard/proxies/update", {
    method: "POST",
    body: fd2,
  });
  assert.strictEqual(res2.status, 302);
  assert.strictEqual(getConnectionById(a.id).proxy_pool_id, pool.id);
  assert.strictEqual(getConnectionById(b.id).proxy_pool_id, null, "Akun B sekarang dilepaskan");

  // 3. Submit with zero accounts (all unchecked)
  const fd3 = form({
    id: String(pool.id),
    name: "pool-update",
    url: "http://pool.local:3128",
    bound_accounts_present: "1",
  });

  const res3 = await app.request("/dashboard/proxies/update", {
    method: "POST",
    body: fd3,
  });
  assert.strictEqual(res3.status, 302);
  assert.strictEqual(getConnectionById(a.id).proxy_pool_id, null, "Akun A sekarang dilepaskan");
  assert.strictEqual(getConnectionById(b.id).proxy_pool_id, null);
});

test("handleUpdateProxy - backward compatibility: preserves bindings when bound_accounts_present is omitted", async () => {
  seedChat();
  const pool = addProxyPool({ name: "pool-compat", url: "http://pool-compat.local:3128" });
  const a = addConnection({ provider: "glm", name: "Acc A", credentials: { api_key: "k1" }, proxy_pool_id: pool.id });

  // Update proxy name and url without bound_accounts_present
  const fd = form({
    id: String(pool.id),
    name: "pool-compat-renamed",
    url: "http://pool-compat-new.local:3128",
  });

  const res = await app.request("/dashboard/proxies/update", {
    method: "POST",
    body: fd,
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(getConnectionById(a.id).proxy_pool_id, pool.id, "Binding akun tetap utuh");
});

test("UI proxies page - renders bound accounts chips and Edit modal multi-select selector", async () => {
  seedChat();
  const pool = addProxyPool({ name: "pool-ui", url: "http://pool-ui.local:3128" });
  addConnection({
    provider: "glm",
    name: "GLM Production",
    credentials: { api_key: "k1" },
    proxy_pool_id: pool.id,
  });
  addConnection({
    provider: "openai",
    name: "OpenAI Fallback",
    credentials: { api_key: "k2" },
  });

  const res = await app.request("/dashboard/proxies");
  const html = await res.text();

  // Row bound accounts chips
  assert.ok(html.includes("Bound accounts:") || html.includes("Akun terikat:"), "label bound accounts tampil di baris");
  assert.ok(html.includes("GLM Production"), "nama akun terikat tampil di chip");
  assert.ok(html.includes("1 bound"), "badge jumlah bound tampil");

  // Edit modal
  assert.ok(html.includes('name="bound_accounts_present"'), "sentinel marker hadir di modal edit");
  assert.ok(html.includes('name="bound_connection_ids"'), "checkbox selector akun hadir di modal edit");
  assert.ok(html.includes("OpenAI Fallback"), "akun lain tampil di daftar pilihan edit modal");
  assert.ok(html.includes("Pilih Semua"), "tombol pilih semua tersedia");
  assert.ok(html.includes("Lepas Semua"), "tombol lepas semua tersedia");
});
