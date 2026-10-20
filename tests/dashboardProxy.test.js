import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { app } from "../src/index.js";
import http from "node:http";
import {
  initDb,
  getDb,
  closeDb,
  addConnection,
  updateConnection,
  getConnectionById,
  getProxyPools,
  addProxyPool,
} from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function redirectMsg(res) {
  const location = res.headers.get("location");
  return decodeURIComponent(new URL(location, "http://localhost").searchParams.get("msg") || "");
}

test("Proxy menu - sidebar menu Proxy Pools and dedicated page /dashboard/proxies", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers")).text();
  assert.ok(
    html.includes("<span>Proxy Pools</span>"),
    "label sidebar menyertakan Proxy Pools"
  );
  assert.ok(html.includes('href="/dashboard/proxies"'), "link menu Proxy Pools terpasang di sidebar");

  const redirectRes = await app.request("/dashboard/providers?tab=proxy");
  assert.strictEqual(redirectRes.status, 302, "tab proxy lama dialihkan ke halaman proxies");
  assert.match(redirectRes.headers.get("location"), /\/dashboard\/proxies/);

  const proxyHtml = await (await app.request("/dashboard/proxies")).text();
  assert.ok(
    proxyHtml.includes('<form action="/dashboard/proxies/add" method="POST">'),
    "halaman Proxy punya form tambah proxy"
  );
  assert.ok(
    proxyHtml.includes('<form action="/dashboard/proxies/import" method="POST">'),
    "halaman Proxy punya form batch import"
  );
  assert.ok(proxyHtml.includes("Proxy Pools"), "judul halaman Proxy Pools ada");
});

test("POST proxies/add - valid proxy is saved and listed with its password masked", async () => {
  initDb(":memory:");
  const res = await app.request("/dashboard/proxies/add", {
    method: "POST",
    body: form({ name: "utama", url: "http://alice:s3cret-pw@10.0.0.2:3128" }),
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/proxies?created=1");

  const html = await (await app.request("/dashboard/proxies")).text();
  assert.ok(html.includes("utama"), "nama proxy tampil di daftar");
  assert.ok(
    html.includes("alice:****@10.0.0.2:3128"),
    "alamat tampil dengan password tersamar"
  );
  assert.ok(!html.includes("s3cret-pw"), "password tidak boleh muncul di HTML");
  assert.ok(html.includes("Belum dites"), "kolom hasil tes tampil");
  assert.ok(html.includes("0 akun") || html.includes("0 bound"), "kolom jumlah akun tampil");
  assert.strictEqual(getProxyPools().length, 1, "proxy tersimpan di database");
});

test("POST proxies/add - invalid proxies are rejected with a reason and the list does not change", async () => {
  initDb(":memory:");
  await app.request("/dashboard/providers/proxies/add", {
    method: "POST",
    body: form({ name: "awal", url: "http://127.0.0.1:9000" }),
  });

  const cases = [
    { url: "https://10.0.0.2:3128", reason: /skema https:\/\/.*belum didukung/i },
    { url: "socks5://10.0.0.2:1080", reason: /SOCKS/ },
    { url: "http://", reason: /host/i },
    { url: "10.0.0.2:3128", reason: /http:\/\//i },
    { url: "http://my proxy:3128", reason: /spasi/i },
  ];
  for (const [i, c] of cases.entries()) {
    const res = await app.request("/dashboard/providers/proxies/add", {
      method: "POST",
      body: form({ name: `tolak-${i}`, url: c.url }),
    });
    assert.strictEqual(res.status, 302, `tolakan ${c.url} tetap redirect`);
    assert.match(redirectMsg(res), c.reason, `alasan untuk ${c.url}`);
    const html = await (await app.request("/dashboard/proxies")).text();
    assert.ok(!html.includes(`tolak-${i}`), `${c.url} tidak masuk daftar`);
    assert.ok(html.includes("awal"), "daftar tetap berisi proxy lama");
  }

  const dup = await app.request("/dashboard/providers/proxies/add", {
    method: "POST",
    body: form({ name: "awal", url: "http://127.0.0.1:9001" }),
  });
  assert.match(redirectMsg(dup), /sudah dipakai/i, "nama ganda ditolak dengan alasannya");
  assert.strictEqual(getProxyPools().length, 1, "daftar tidak berubah oleh tolakan");

  // Halaman menampilkan pesan error sebagai notice, bukan diam.
  const errPage = await (await app.request(
    `/dashboard/providers${new URL(dup.headers.get("location"), "http://x").search}`
  )).text();
  assert.ok(errPage.includes("notice-error"), "pesan error tampil di tab Proxy");
});

test("Provider detail - manual proxy password is masked in the account row", async () => {
  initDb(":memory:");
  addConnection({
    provider: "mistral",
    name: "Bermesin Proksi",
    credentials: { api_key: "k" },
    proxy_url: "http://bob:hush-pass@10.9.9.9:3128",
  });
  let res = await app.request("/dashboard/providers/mistral");
  if (res.status >= 300 && res.status < 400) {
    res = await app.request(res.headers.get("location"));
  }
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(!html.includes("hush-pass"), "password proxy manual tidak boleh tampil");
  assert.ok(html.includes("bob:****@10.9.9.9:3128"), "alamat manual tampil tersamar");
});

test("Migration - legacy database gains proxy storage while manual proxy stays intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "zenith-proxy-"));
  const file = join(dir, "legacy.db");
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'apikey',
        credentials TEXT NOT NULL DEFAULT '{}',
        proxy_url TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_used_at INTEGER DEFAULT 0,
        cooldown_until INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO connections (provider, name, credentials, proxy_url, created_at)
        VALUES ('mistral', 'Lawas', '{"api_key":"k"}', 'http://bob:hush-pass@10.9.9.9:3128', 1);
    `);
    legacy.close();

    initDb(file);

    const table = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_pools'")
      .get();
    assert.ok(table, "tabel proxy_pools dibuat otomatis di database lama");
    const cols = getDb()
      .prepare("PRAGMA table_info(connections)")
      .all()
      .map((c) => c.name);
    assert.ok(cols.includes("proxy_pool_id"), "kolom hubungan akun-proxy ditambahkan");
    assert.strictEqual(
      getConnectionById(1).proxy_url,
      "http://bob:hush-pass@10.9.9.9:3128",
      "alamat manual akun tetap utuh"
    );

    // Init ulang tidak boleh gagal maupun menggandakan struktur.
    initDb(file);
    const again = getDb()
      .prepare("PRAGMA table_info(connections)")
      .all()
      .map((c) => c.name);
    assert.ok(again.includes("proxy_pool_id"));
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Bulk parser - full URL, host:port, host:port:user:pass, and rejects the rest", async () => {
  const { parseProxyLine } = await import("../src/services/proxyPools.js");

  const full = parseProxyLine("http://1.2.3.4:8080");
  assert.strictEqual(full.ok, true);
  assert.strictEqual(full.url, "http://1.2.3.4:8080");

  const short = parseProxyLine("10.0.0.1:3128");
  assert.strictEqual(short.ok, true, "host:port diterima");
  assert.strictEqual(short.url, "http://10.0.0.1:3128");

  const auth = parseProxyLine("10.0.0.1:3128:alice:s3cret");
  assert.strictEqual(auth.ok, true, "host:port:user:pass diterima");
  assert.strictEqual(auth.url, "http://alice:s3cret@10.0.0.1:3128", "kredensial jadi userinfo URL");

  const https = parseProxyLine("https://x:1");
  assert.strictEqual(https.ok, false, "https:// tetap ditolak");
  assert.match(https.reason, /https:\/\//);

  const partial = parseProxyLine("10.0.0.1:3128:bob");
  assert.strictEqual(partial.ok, false, "tiga bagian bukan format yang dikenal");

  const noPort = parseProxyLine("baris aneh tanpa port");
  assert.strictEqual(noPort.ok, false);
});

test("Bulk import - created, skipped duplicates, failed lines do not affect the rest", async () => {
  initDb(":memory:");
  const { importProxyLines } = await import("../src/services/proxyPools.js");

  const text = [
    "http://a.example:8080",
    "10.0.0.2:3128",
    "10.0.0.3:3128:bob:hush",
    "https://x:1",
    "http://a.example:8080",
    "",
    "baris aneh tanpa port",
  ].join("\n");

  const summary = importProxyLines(text);
  assert.deepStrictEqual(summary, { created: 3, skipped: 1, failed: 2 });

  const urls = getProxyPools().map((p) => p.url);
  assert.ok(urls.includes("http://a.example:8080"));
  assert.ok(urls.includes("http://10.0.0.2:3128"));
  assert.ok(urls.includes("http://bob:hush@10.0.0.3:3128"), "kredensial tersimpan");

  // Impor ulang: semua alamat valid dilewati, tidak ada duplikat.
  // (Empat baris melewati: tiga alamat valid + baris kembar yang kini juga sudah ada.)
  const again = importProxyLines(text);
  assert.deepStrictEqual(again, { created: 0, skipped: 4, failed: 2 });
  assert.strictEqual(getProxyPools().length, 3, "daftar tidak bertambah saat impor ulang");

  // host:port sama dengan kredensial berbeda = alamat berbeda, nama disuffiks.
  const both = importProxyLines("10.0.0.9:80:a:1\n10.0.0.9:80:b:2");
  assert.deepStrictEqual(both, { created: 2, skipped: 0, failed: 0 });
  const names = getProxyPools().map((p) => p.name);
  assert.ok(names.includes("10.0.0.9:80"), "nama dasar host:port");
  assert.ok(names.includes("10.0.0.9:80 (2)"), "tabrakan nama disuffiks, bukan ditolak");
});

test("Bulk import - dashboard reports created, skipped, and failed counts", async () => {
  initDb(":memory:");
  const text = ["10.0.0.2:3128", "10.0.0.3:3128:a:b", "https://x:1"].join("\n");

  const res = await app.request("/dashboard/proxies/import", {
    method: "POST",
    body: form({ bulk: text }),
  });
  assert.strictEqual(res.status, 302);
  const loc = new URL(res.headers.get("location"), "http://localhost");
  assert.strictEqual(loc.searchParams.get("imported"), "1");
  assert.strictEqual(loc.searchParams.get("created"), "2");
  assert.strictEqual(loc.searchParams.get("skipped"), "0");
  assert.strictEqual(loc.searchParams.get("failed"), "1");

  const html = await (await app.request("/dashboard/proxies?imported=1&created=2&skipped=0&failed=1")).text();
  assert.ok(html.includes("Dibuat: 2"), "jumlah dibuat ditampilkan");
  assert.ok(html.includes("Dilewati: 0"), "jumlah dilewati ditampilkan");
  assert.ok(html.includes("Gagal: 1"), "jumlah gagal ditampilkan");
  assert.ok(
    html.includes('<form action="/dashboard/proxies/import" method="POST">'),
    "form tempel massal ada di tab Proxy"
  );
});

test("Health test - any HTTP response through the proxy counts as healthy, 8s cap, active untouched", async () => {
  initDb(":memory:");
  const { testProxyPool, PROXY_TEST_TIMEOUT_MS } = await import("../src/services/proxyPools.js");
  assert.strictEqual(PROXY_TEST_TIMEOUT_MS, 8000, "batas waktu tes 8 detik");

  // Proxy tiruan di loopback: selalu menjawab 403 — respons apa pun = sehat.
  const server = http.createServer((req, res) => {
    res.writeHead(403);
    res.end("nope");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const pool = addProxyPool({ name: "tiru-sehat", url: `http://127.0.0.1:${server.address().port}` });

  try {
    const result = await testProxyPool(pool.id);
    assert.strictEqual(result.ok, true, "respons 403 lewat proxy tetap dihitung sehat");
    const row = getProxyPools().find((p) => p.id === pool.id);
    assert.strictEqual(row.last_test_ok, 1, "status sehat tercatat");
    assert.ok(Number.isFinite(row.last_test_ms) && row.last_test_ms >= 0, "latensi tercatat");
    assert.ok(row.last_test_at > 0, "waktu tes tercatat");
    assert.strictEqual(row.last_test_error, null, "tidak ada error terakhir saat sehat");
    assert.strictEqual(row.is_active, 1, "tes tidak mengubah status aktif");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Health test - dead proxy records the error and stays active", async () => {
  initDb(":memory:");
  const { testProxyPool } = await import("../src/services/proxyPools.js");

  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));

  const pool = addProxyPool({ name: "tiru-mati", url: `http://127.0.0.1:${port}` });
  const result = await testProxyPool(pool.id);
  assert.strictEqual(result.ok, false, "proxy mati dilaporkan gagal");
  const row = getProxyPools().find((p) => p.id === pool.id);
  assert.strictEqual(row.last_test_ok, 0, "status gagal tercatat");
  assert.ok(row.last_test_error && row.last_test_error.length > 0, "pesan error terakhir tercatat");
  assert.ok(Number.isFinite(row.last_test_ms) && row.last_test_ms >= 0, "latensi tercatat");
  assert.ok(row.last_test_at > 0, "waktu tes tercatat");
  assert.strictEqual(row.is_active, 1, "tes tidak pernah menonaktifkan proxy");
});

test("Delete - rejected while accounts use it (message names the count), allowed once detached", async () => {
  initDb(":memory:");
  const pool = addProxyPool({ name: "dipakai", url: "http://10.0.0.5:3128" });
  const a = addConnection({ provider: "glm", name: "A", credentials: { api_key: "k1" }, proxy_pool_id: pool.id });
  const b = addConnection({ provider: "glm", name: "B", credentials: { api_key: "k2" }, proxy_pool_id: pool.id });

  const res = await app.request("/dashboard/providers/proxies/delete", {
    method: "POST",
    body: form({ id: String(pool.id) }),
  });
  assert.strictEqual(res.status, 302);
  const msg = redirectMsg(res);
  assert.match(msg, /2/, `pesan menyebut jumlah akun: ${msg}`);
  assert.match(msg, /akun/);
  assert.ok(getProxyPools().some((p) => p.id === pool.id), "proxy tetap ada saat ditolak");

  updateConnection(a.id, { proxy_pool_id: null });
  const res2 = await app.request("/dashboard/providers/proxies/delete", {
    method: "POST",
    body: form({ id: String(pool.id) }),
  });
  assert.match(redirectMsg(res2), /1/, "masih ada 1 akun lain — tetap ditolak dengan jumlah");
  assert.ok(getProxyPools().some((p) => p.id === pool.id));

  updateConnection(b.id, { proxy_pool_id: null });
  const res3 = await app.request("/dashboard/providers/proxies/delete", {
    method: "POST",
    body: form({ id: String(pool.id) }),
  });
  assert.strictEqual(res3.headers.get("location").includes("deleted=1"), true, "tanpa akun: terhapus");
  assert.ok(!getProxyPools().some((p) => p.id === pool.id), "proxy hilang dari daftar");
});

test("Update - same validation as save, masked password kept, next request uses the new address", async () => {
  initDb(":memory:");
  const pool = addProxyPool({ name: "rute", url: "http://alice:s3cret@10.1.1.1:3128" });
  const row = () => getProxyPools().find((p) => p.id === pool.id);

  // Validasi sama dengan simpan baru: https:// ditolak dan tidak ada yang berubah.
  const bad = await app.request("/dashboard/providers/proxies/update", {
    method: "POST",
    body: form({ id: String(pool.id), name: "rute", url: "https://10.1.1.1:3128" }),
  });
  assert.match(redirectMsg(bad), /https:\/\//, "alasan penolakannya diumumkan");
  assert.strictEqual(row().url, "http://alice:s3cret@10.1.1.1:3128", "alamat lama utuh");

  // Alamat tersamar dipakai apa adanya: password asli dipertahankan dari penyimpanan.
  const masked = await app.request("/dashboard/providers/proxies/update", {
    method: "POST",
    body: form({ id: String(pool.id), name: "rute-baru", url: "http://alice:****@10.1.1.1:3128" }),
  });
  assert.strictEqual(masked.headers.get("location").includes("updated=1"), true);
  assert.strictEqual(row().name, "rute-baru", "nama baru tersimpan");
  assert.strictEqual(row().url, "http://alice:s3cret@10.1.1.1:3128", "password lama dipertahankan");

  // Request akun berikutnya memakai alamat baru.
  const acc = addConnection({ provider: "glm", name: "X", credentials: { api_key: "k" }, proxy_pool_id: pool.id });
  const seen = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      seen.push(proxyUrl);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  try {
    await app.request("/dashboard/providers/proxies/update", {
      method: "POST",
      body: form({ id: String(pool.id), name: "rute-baru", url: "http://10.9.9.9:3128" }),
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(seen, ["http://10.9.9.9:3128"], "akun terikat langsung memakai alamat baru");
  } finally {
    setCustomExecutor(null);
  }
  assert.ok(acc.id);
});

test("Proxy list row - test, edit, and delete controls are present per entry", async () => {
  initDb(":memory:");
  addProxyPool({ name: "lihat", url: "http://10.0.0.7:3128" });
  const html = await (await app.request("/dashboard/proxies")).text();
  assert.ok(html.includes("/dashboard/proxies/test"), "tombol tes per baris");
  assert.ok(html.includes("openEditModal"), "tombol ubah membuka modal");
  assert.ok(html.includes("/dashboard/proxies/delete"), "tombol hapus per baris");
  assert.ok(
    html.includes("http://10.0.0.7:3128"),
    "alamat tersamar yang ada tampil"
  );
  assert.ok(html.includes("edit-proxy-modal"), "modal ubah proxy tersedia");
});

test("UI proxy pools - badges, empty state, and toggle/bulk controls", async () => {
  initDb(":memory:");
  // Empty state
  const emptyHtml = await (await app.request("/dashboard/proxies")).text();
  assert.ok(emptyHtml.includes("Belum ada entri proxy pool"), "empty state ditampilkan saat kosong");
  assert.ok(emptyHtml.includes("Add Proxy Pool"), "tombol add proxy pool ada di empty state");
  assert.ok(emptyHtml.includes("Batch Import"), "tombol batch import ada di header");

  // Tambah proxy aktif dan inaktif
  const p1 = addProxyPool({ name: "p-aktif", url: "http://10.0.0.1:3128", is_active: 1 });
  const p2 = addProxyPool({ name: "p-nonaktif", url: "http://10.0.0.2:3128", is_active: 0 });

  const html = await (await app.request("/dashboard/proxies")).text();
  assert.ok(html.includes("Total: 2"), "badge total ditampilkan");
  assert.ok(html.includes("Active: 1"), "badge active count ditampilkan");
  assert.ok(html.includes("pill-success\">active<"), "badge status aktif tampil");
  assert.ok(html.includes("inactive<"), "badge status inaktif tampil");

  // Toggle satu proxy
  const toggleRes = await app.request("/dashboard/proxies/toggle", {
    method: "POST",
    body: form({ id: String(p1.id) }),
  });
  assert.strictEqual(toggleRes.status, 302);
  assert.strictEqual(getProxyPools().find((p) => p.id === p1.id).is_active, 0, "proxy aktif menjadi inaktif setelah toggle");

  // Bulk enable
  const bulkEnableRes = await app.request("/dashboard/proxies/bulk-enable", {
    method: "POST",
    body: form({ ids: String(p1.id) }),
  });
  assert.strictEqual(bulkEnableRes.status, 302);
  assert.strictEqual(getProxyPools().find((p) => p.id === p1.id).is_active, 1, "proxy aktif kembali lewat bulk-enable");
});

test("Proxy list row - a name with quotes cannot break out of the edit handler", async () => {
  initDb(":memory:");
  const evil = "x');throw new Error('XSS');//";
  addProxyPool({ name: evil, url: "http://10.0.0.9:3128" });
  const html = await (await app.request("/dashboard/proxies")).text();

  const m = html.match(/onclick="(openEditModal\([^"]*)"/);
  assert.ok(m, "handler edit ada di baris proxy");
  assert.ok(!m[1].includes("'"), "atribut tidak memuat quote mentah yang bisa keluar dari string JS");

  // Decode seperti browser (entitas HTML didekode sebelum JS dievaluasi).
  const decoded = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

  const vm = await import("node:vm");
  let captured = null;
  vm.runInNewContext(decoded, {
    openEditModal: (id, name, url, active) => {
      captured = { id, name, url, active };
    },
  });
  assert.ok(captured, "handler berjalan tanpa error");
  assert.strictEqual(captured.name, evil, "nama asli utuh kembali ke handler edit");
  assert.strictEqual(captured.id, 1, "id pool tetap angka");
  assert.strictEqual(typeof captured.active, "number");
});
