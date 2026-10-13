import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addProxyPool } from "../src/db/index.js";
import { setSetting, getSetting } from "../src/services/settings.js";
import {
  getProxyRotationStrategy,
  setProxyRotationStrategy,
  planProxyRotation,
  resetProxyRotation,
  PROXY_ROTATION_MAX_ATTEMPTS,
} from "../src/services/proxyPools.js";
import { setCustomExecutor } from "../src/executors/base.js";

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function seed() {
  initDb(":memory:");
  resetProxyRotation();
}

function okResponse() {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function failResponse() {
  return new Response(JSON.stringify({ error: { message: "Upstream transport failed", code: "bad_gateway" } }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

function chat(model = "opencode/big-pickle") {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

function poolUrls(count, prefix = "r") {
  const urls = [];
  for (let i = 1; i <= count; i++) {
    urls.push(addProxyPool({ name: `${prefix}${i}`, url: `http://${prefix}${i}.local:3128` }).url);
  }
  return urls;
}

test("strategi rotasi - nilai sah disimpan, nilai lain dinormalkan ke tidak aktif", () => {
  seed();
  assert.strictEqual(getProxyRotationStrategy("opencode"), "off", "default tidak aktif");
  setProxyRotationStrategy("opencode", "round_robin");
  assert.strictEqual(getProxyRotationStrategy("opencode"), "round_robin");
  setProxyRotationStrategy("opencode", "random");
  assert.strictEqual(getProxyRotationStrategy("opencode"), "random");
  setProxyRotationStrategy("opencode", "bogus");
  assert.strictEqual(getProxyRotationStrategy("opencode"), "off", "nilai tidak dikenal dianggap tidak aktif");
  assert.strictEqual(
    getSetting("proxy_rotation:opencode"),
    "off",
    "penyimpanan tidak pernah menyimpan nilai di luar daftar sah"
  );

  // Penjagaan getter: nilai tidak dikenal yang sempat masuk penyimpanan
  // langsung tetap dinormalkan, supaya jalur lalu lintas tidak pernah
  // menerima strategi di luar daftar sah.
  setSetting("proxy_rotation:opencode", "bogus");
  assert.strictEqual(getProxyRotationStrategy("opencode"), "off", "nilai tersimpan yang tidak dikenal dinormalkan");
});

test("rencana bergiliran - dimulai dari kursor, maksimal tiga proxy, maju satu langkah per request", () => {
  seed();
  const urls = poolUrls(5, "b");
  assert.deepStrictEqual(
    planProxyRotation("opencode", "round_robin"),
    [urls[0], urls[1], urls[2]],
    "rencana pertama dimulai dari proxy pertama"
  );
  assert.deepStrictEqual(
    planProxyRotation("opencode", "round_robin"),
    [urls[1], urls[2], urls[3]],
    "kursor maju satu langkah per request"
  );
  assert.strictEqual(planProxyRotation("opencode", "off").length, 0, "tidak aktif tidak membuat rencana");
});

test("rencana acak - maksimal tiga proxy berbeda dari daftar aktif", () => {
  seed();
  const urls = poolUrls(5, "a");
  addProxyPool({ name: "mati", url: "http://off.local:3128", is_active: 0 });
  for (let i = 0; i < 50; i++) {
    const plan = planProxyRotation("opencode", "random");
    assert.ok(plan.length <= PROXY_ROTATION_MAX_ATTEMPTS, "tidak lebih dari batas percobaan");
    assert.strictEqual(new Set(plan).size, plan.length, "proxy dalam satu request selalu berbeda");
    for (const url of plan) {
      assert.ok(urls.includes(url), "hanya proxy aktif yang dipilih");
    }
  }
});

test("chat - rotasi bergiliran menyebar request ke proxy aktif secara berurutan", async () => {
  seed();
  const urls = poolUrls(3);
  setProxyRotationStrategy("opencode", "round_robin");

  const calls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calls.push(proxyUrl);
      return okResponse();
    },
  });
  try {
    for (let i = 0; i < 3; i++) {
      const res = await chat();
      assert.strictEqual(res.status, 200, `request ke-${i} harus sukses`);
    }
  } finally {
    setCustomExecutor(null);
  }

  assert.deepStrictEqual(calls, [urls[0], urls[1], urls[2]], "tiga request memakai tiga proxy berbeda secara berurutan");

  resetProxyRotation();
  const afterReset = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      afterReset.push(proxyUrl);
      return okResponse();
    },
  });
  try {
    await chat();
  } finally {
    setCustomExecutor(null);
  }
  assert.strictEqual(afterReset[0], urls[0], "reset memulai lagi dari proxy pertama");
});

test("chat - proxy gagal dilewati ke proxy berikutnya dalam request yang sama, maksimal tiga percobaan", async () => {
  seed();
  const urls = poolUrls(5);
  setProxyRotationStrategy("opencode", "round_robin");

  const failed = new Set([urls[0], urls[1]]);
  const calls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calls.push(proxyUrl);
      return failed.has(proxyUrl) ? failResponse() : okResponse();
    },
  });
  try {
    const res = await chat();
    assert.strictEqual(res.status, 200, "request berhasil setelah proxy gagal dilewati");
  } finally {
    setCustomExecutor(null);
  }
  assert.deepStrictEqual(calls, [urls[0], urls[1], urls[2]], "dua proxy gagal dilewati, percobaan ketiga berhasil");

  const allFailCalls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      allFailCalls.push(proxyUrl);
      return failResponse();
    },
  });
  try {
    const res2 = await chat();
    assert.strictEqual(res2.status, 502, "semua proxy gagal: client menerima 502");
  } finally {
    setCustomExecutor(null);
  }
  assert.strictEqual(
    allFailCalls.length,
    PROXY_ROTATION_MAX_ATTEMPTS,
    "request tidak melebihi batas percobaan walau daftar proxy lebih banyak"
  );
});

test("chat - strategi tidak aktif tetap memakai koneksi langsung", async () => {
  seed();
  const urls = poolUrls(3, "d");
  setProxyRotationStrategy("opencode", "off");

  const calls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calls.push(proxyUrl);
      return okResponse();
    },
  });
  try {
    const res = await chat();
    assert.strictEqual(res.status, 200);
  } finally {
    setCustomExecutor(null);
  }
  assert.deepStrictEqual(calls, [null], "strategi tidak aktif berarti koneksi langsung");
  assert.ok(urls.length === 3);
});

test("chat - daftar proxy aktif kosong tetap memakai koneksi langsung", async () => {
  seed();
  addProxyPool({ name: "mati", url: "http://off.local:3128", is_active: 0 });
  setProxyRotationStrategy("opencode", "round_robin");

  const calls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calls.push(proxyUrl);
      return okResponse();
    },
  });
  try {
    const res = await chat();
    assert.strictEqual(res.status, 200);
  } finally {
    setCustomExecutor(null);
  }
  assert.deepStrictEqual(calls, [null], "tanpa proxy aktif, request tetap langsung");
});

test("chat - proxy nonaktif tidak ikut rotasi", async () => {
  seed();
  addProxyPool({ name: "mati", url: "http://off.local:3128", is_active: 0 });
  const live = addProxyPool({ name: "hidup", url: "http://live.local:3128" });
  setProxyRotationStrategy("opencode", "round_robin");

  const calls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calls.push(proxyUrl);
      return okResponse();
    },
  });
  try {
    for (let i = 0; i < 2; i++) {
      const res = await chat();
      assert.strictEqual(res.status, 200);
    }
  } finally {
    setCustomExecutor(null);
  }
  assert.deepStrictEqual(calls, [live.url, live.url], "hanya proxy aktif yang dipakai");
});

test("kartu provider tanpa akun - pilihan strategi rotasi tersedia dan tersimpan", async () => {
  seed();
  setProxyRotationStrategy("opencode", "off");

  const page = await app.request("/dashboard/providers/opencode");
  const html = await page.text();
  assert.match(html, /action="\/dashboard\/providers\/proxy-rotation"/, "form penyimpanan strategi ada");
  assert.match(html, /name="strategy"/, "pilihan strategi ada");
  assert.match(html, /value="round_robin"/, "pilihan bergiliran ada");
  assert.match(html, /value="random"/, "pilihan acak ada");
  assert.match(html, /value="off"/, "pilihan tidak aktif ada");
  assert.match(html, /<option value="off"[^>]*selected/, "strategi tersimpan ditandai terpilih");

  const res = await app.request("/dashboard/providers/proxy-rotation", {
    method: "POST",
    body: form({ provider: "opencode", strategy: "round_robin" }),
  });
  assert.strictEqual(res.status, 302);
  const params = new URL(res.headers.get("location"), "http://localhost").searchParams;
  assert.match(params.get("notice"), /rotation_updated/, "redirect dengan konfirmasi");
  assert.strictEqual(getProxyRotationStrategy("opencode"), "round_robin", "strategi tersimpan");

  const page2 = await app.request("/dashboard/providers/opencode");
  const html2 = await page2.text();
  assert.match(html2, /<option value="round_robin"[^>]*selected/, "pilihan bergiliran ditandai terpilih");
});

test("kartu provider tanpa akun - strategi tidak dikenal ditolak dengan notice error", async () => {
  seed();
  setProxyRotationStrategy("opencode", "round_robin");
  const res = await app.request("/dashboard/providers/proxy-rotation", {
    method: "POST",
    body: form({ provider: "opencode", strategy: "bogus" }),
  });
  const params = new URL(res.headers.get("location"), "http://localhost").searchParams;
  assert.match(params.get("notice"), /rotation_invalid/, "strategi tak dikenal ditolak");
  assert.strictEqual(getProxyRotationStrategy("opencode"), "round_robin", "strategi lama tidak berubah");

  const page = await app.request("/dashboard/providers/opencode?notice=rotation_invalid");
  const html = await page.text();
  assert.match(html, /Strategi rotasi tidak dikenal/, "notice error ditampilkan di halaman");
  assert.match(html, /notice-error/, "notice diberi gaya error");
});

test("kartu provider berkredensial - tidak menampilkan pilihan rotasi proxy", async () => {
  seed();
  const page = await app.request("/dashboard/providers/glm");
  const html = await page.text();
  assert.doesNotMatch(html, /action="\/dashboard\/providers\/proxy-rotation"/, "rotasi hanya untuk provider tanpa akun");
});
