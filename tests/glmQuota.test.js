import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection } from "../src/db/index.js";
import { syncProviderQuota } from "../src/services/quota.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readZcodeDeviceMid,
  fetchGlmQuota,
  fetchGlmPlanQuota,
  fetchGlmPaasQuota,
  parseGlmLimits,
  parseGlmPlanBalance,
  planQuotaBackoffActive,
} from "../src/services/quota/glm.js";
import { hasQuotaFetcher } from "../src/services/quota/index.js";
import { app } from "../src/index.js";

const PAAS_BODY = {
  code: 200,
  success: true,
  data: {
    limits: [
      { type: "TOKENS_LIMIT", unit: 3, percentage: 40, nextResetTime: 1770648402389 },
      { type: "TOKENS_LIMIT", unit: 6, percentage: 70, nextResetTime: 1771253202389 },
    ],
  },
};

const PLAN_BODY = {
  code: 0,
  msg: "success",
  data: {
    plans: [{ name: "Start Plan", status: "VALID" }],
    balances: [
      { show_name: "GLM-5.3", remaining_units: 100, total_units: 300, unit_type: "tokens" },
      { show_name: "GLM-5-Turbo", remaining_units: 500, total_units: 500, unit_type: "tokens" },
    ],
  },
};

function mockFetch(handler) {
  setOAuthFetch(async (url, init) => handler(url, init));
}

test("glm quota - fetcher terdaftar", () => {
  assert.strictEqual(hasQuotaFetcher("glm"), true);
});

test("glm quota - parseGlmLimits memetakan unit 3 dan 6", () => {
  const { sessionLimit, weeklyLimit, isExhausted } = parseGlmLimits(PAAS_BODY);
  assert.strictEqual(sessionLimit.used_percent, 40);
  assert.strictEqual(sessionLimit.reset_time, 1770648402389);
  assert.strictEqual(weeklyLimit.used_percent, 70);
  assert.strictEqual(weeklyLimit.reset_time, 1771253202389);
  assert.strictEqual(isExhausted, false);
});

test("glm quota - parseGlmLimits menandai exhausted saat persen 100", () => {
  const { isExhausted } = parseGlmLimits({
    data: { limits: [{ unit: 3, percentage: 100, nextResetTime: 1 }, { unit: 6, percentage: 10, nextResetTime: 2 }] },
  });
  assert.strictEqual(isExhausted, true);
});

test("glm quota - PaaS memakai endpoint monitor kuota yang baru", async () => {
  initDb(":memory:");
  let calledUrl = "";
  mockFetch((url, init) => {
    calledUrl = url;
    assert.match(String(init.headers.Authorization), /^Bearer paas-key-/);
    return new Response(JSON.stringify(PAAS_BODY), { status: 200 });
  });

  const conn = addConnection({ provider: "glm", name: "GLM", credentials: { api_key: "paas-key-abc" } });
  const quota = await fetchGlmPaasQuota(conn);

  assert.ok(calledUrl.includes("https://api.z.ai/api/monitor/usage/quota/limit"), calledUrl);
  assert.ok(!calledUrl.includes("/api/paas/v4/user/quota"), "endpoint lama yang 404 tidak boleh dipakai");
  assert.strictEqual(quota.provider, "glm");
  assert.strictEqual(quota.unit, "coding_plan");
  assert.strictEqual(quota.session_quota.used_percent, 40);
  assert.strictEqual(quota.weekly_quota.used_percent, 70);
  assert.strictEqual(quota.is_exhausted, false);

  setOAuthFetch(null);
});

test("glm quota - PaaS tanpa API key mengembalikan null", async () => {
  const quota = await fetchGlmPaasQuota({ provider: "glm", credentials: {} });
  assert.strictEqual(quota, null);
});

test("glm quota - PaaS HTTP 404 dilempar sebagai error", async () => {
  mockFetch(() => new Response("nope", { status: 404 }));
  await assert.rejects(() => fetchGlmPaasQuota({ provider: "glm", credentials: { api_key: "k" } }), /HTTP 404/);
  setOAuthFetch(null);
});

test("glm quota - Start-Plan memakai plan_token dan parsing balances", async () => {
  initDb(":memory:");
  let calledUrl = "";
  let lastInit = null;
  mockFetch((url, init) => {
    calledUrl = url;
    lastInit = init;
    assert.match(String(init.headers.Authorization), /^Bearer plan-jwt-/);
    return new Response(JSON.stringify(PLAN_BODY), { status: 200 });
  });

  const conn = addConnection({
    provider: "glm",
    name: "GLM Plan",
    credentials: { plan_token: "plan-jwt-xyz" },
  });
  const quota = await fetchGlmPlanQuota(conn);

  assert.ok(calledUrl.includes("https://zcode.z.ai/api/v1/zcode-plan/billing/balance"), calledUrl);
  // Kegagalan yang dicegah: endpoint billing membalas 400 code 3001 "parameter error"
  // tanpa query app_version dan header X-Device-Mid yang dikirim ZCode desktop asli.
  assert.ok(calledUrl.includes("app_version="), "balance URL harus menyertakan query app_version");
  const planHeaders = lastInit.headers;
  assert.ok(planHeaders["X-ZCode-App-Version"], "header X-ZCode-App-Version wajib ada");
  assert.strictEqual(quota.provider, "glm");
  assert.strictEqual(quota.unit, "coding_plan");
  assert.strictEqual(quota.remaining, 600);
  assert.strictEqual(quota.total, 800);
  assert.strictEqual(quota.plan_quota.length, 2);
  assert.strictEqual(quota.plan_quota[0].name, "GLM-5.3");
  assert.strictEqual(quota.plan_quota[0].remaining_percent, 100 * (100 / 300));
  assert.strictEqual(quota.plan_quota[1].remaining_percent, 100);
  assert.strictEqual(quota.is_exhausted, false);

  setOAuthFetch(null);
});

test("glm quota - Start-Plan 401/403 ditandai perlu login ulang, tanpa crash", async () => {
  for (const status of [401, 403]) {
    mockFetch(() => new Response("", { status }));
    const quota = await fetchGlmPlanQuota({ provider: "glm", credentials: { plan_token: "jwt" } });
    assert.ok(quota.error.includes(String(status)), quota.error);
    assert.ok(/login ulang/i.test(quota.error), quota.error);
    assert.strictEqual(quota.is_exhausted, false);
    assert.strictEqual(quota.plan_quota, undefined);
  }
  setOAuthFetch(null);
});

test("glm quota - Start-Plan HTTP lain dikembalikan sebagai error non-fatal dengan backoff", async () => {
  mockFetch(() => new Response(JSON.stringify({ code: 3001, msg: "parameter error" }), { status: 400 }));
  const conn = { provider: "glm", id: 777, credentials: { plan_token: "jwt" } };
  const quota = await fetchGlmPlanQuota(conn);
  assert.ok(quota.error.includes("400"), quota.error);
  assert.ok(quota.error.includes("parameter error"), quota.error);
  assert.strictEqual(quota.is_exhausted, false);
  // Kegagalan yang dicegah: endpoint billing bermasalah menggagalkan seluruh sync
  // dan mengspam console tiap siklus. Setelah gagal, backoff aktif sehingga
  // pemanggilan berikutnya melewati endpoint (skipped) tanpa hit jaringan.
  assert.ok(planQuotaBackoffActive(conn), "backoff harus aktif setelah gagal");
  let fetchCount = 0;
  mockFetch(() => {
    fetchCount += 1;
    return new Response("", { status: 500 });
  });
  const skipped = await fetchGlmPlanQuota(conn);
  assert.strictEqual(skipped.skipped, true);
  assert.strictEqual(fetchCount, 0, "saat backoff aktif tidak boleh ada request jaringan");
  setOAuthFetch(null);
});

test("glm quota - koneksi tanpa plan_token tidak berubah perilaku (PaaS saja)", async () => {
  mockFetch((url) => {
    assert.ok(String(url).includes("api.z.ai"), "hanya endpoint PaaS yang dipanggil: " + url);
    return new Response(JSON.stringify(PAAS_BODY), { status: 200 });
  });

  const quota = await fetchGlmQuota({ provider: "glm", credentials: { api_key: "k" } });
  assert.strictEqual(quota.session_quota.used_percent, 40);
  assert.strictEqual(quota.weekly_quota.used_percent, 70);
  assert.strictEqual(quota.plan_quota, undefined);
  assert.strictEqual(quota.error, undefined);

  setOAuthFetch(null);
});

test("glm quota - koneksi dengan plan_token menggabungkan PaaS dan Start-Plan", async () => {
  mockFetch((url) => {
    if (String(url).includes("api.z.ai")) return new Response(JSON.stringify(PAAS_BODY), { status: 200 });
    if (String(url).includes("zcode.z.ai")) return new Response(JSON.stringify(PLAN_BODY), { status: 200 });
    return new Response("unexpected", { status: 404 });
  });

  const quota = await fetchGlmQuota({ provider: "glm", credentials: { api_key: "k", plan_token: "jwt" } });
  assert.strictEqual(quota.session_quota.used_percent, 40);
  assert.strictEqual(quota.weekly_quota.used_percent, 70);
  assert.strictEqual(quota.plan_quota.length, 2);
  assert.strictEqual(quota.remaining, 600);
  assert.strictEqual(quota.error, undefined);

  setOAuthFetch(null);
});

test("glm quota - PaaS gagal tapi Start-Plan tetap tampil", async () => {
  mockFetch((url) => {
    if (String(url).includes("api.z.ai")) return new Response("gone", { status: 404 });
    if (String(url).includes("zcode.z.ai")) return new Response(JSON.stringify(PLAN_BODY), { status: 200 });
    return new Response("unexpected", { status: 404 });
  });

  const quota = await fetchGlmQuota({ provider: "glm", credentials: { api_key: "k", plan_token: "jwt" } });
  assert.strictEqual(quota.plan_quota.length, 2);
  assert.ok(quota.paas_error.includes("404"), quota.paas_error);

  setOAuthFetch(null);
});

test("glm quota - plan_token ditolak saat PaaS juga gagal: error re-login tampil", async () => {
  mockFetch((url) => {
    if (String(url).includes("api.z.ai")) return new Response("gone", { status: 404 });
    if (String(url).includes("zcode.z.ai")) return new Response("", { status: 401 });
    return new Response("unexpected", { status: 404 });
  });

  const quota = await fetchGlmQuota({ provider: "glm", credentials: { api_key: "k", plan_token: "jwt" } });
  assert.ok(quota.error.includes("401"), quota.error);
  assert.ok(/login ulang/i.test(quota.error));
  assert.strictEqual(quota.session_quota, undefined);

  setOAuthFetch(null);
});

test("glm quota - parseGlmPlanBalance dengan balances kosong", () => {
  const parsed = parseGlmPlanBalance({ code: 0, data: { balances: [] } });
  assert.strictEqual(parsed.balances.length, 0);
  assert.strictEqual(parsed.remaining, null);
  assert.strictEqual(parsed.total, null);
});

test("glm quota - syncProviderQuota menyimpan plan_quota ke kredensial", async () => {
  initDb(":memory:");
  mockFetch((url) => {
    if (String(url).includes("api.z.ai")) return new Response(JSON.stringify(PAAS_BODY), { status: 200 });
    if (String(url).includes("zcode.z.ai")) return new Response(JSON.stringify(PLAN_BODY), { status: 200 });
    return new Response("unexpected", { status: 404 });
  });

  const conn = addConnection({
    provider: "glm",
    name: "GLM Full",
    credentials: { api_key: "k", plan_token: "jwt" },
  });
  const quota = await syncProviderQuota(conn);
  assert.strictEqual(quota.session_quota.used_percent, 40);
  assert.strictEqual(quota.plan_quota.length, 2);

  setOAuthFetch(null);
});

test("glm quota - halaman usage menampilkan label PaaS dan Start-Plan", async () => {
  initDb(":memory:");
  addConnection({
    provider: "glm",
    name: "GLM UI",
    credentials: {
      api_key: "k",
      quota: {
        provider: "glm",
        unit: "coding_plan",
        is_exhausted: false,
        session_quota: { used_percent: 40, reset_time: 1770648402389 },
        weekly_quota: { used_percent: 70, reset_time: 1771253202389 },
        plan_quota: [
          { name: "GLM-5.3", remaining_units: 100, total_units: 300, remaining_percent: 33.33, unit_type: "tokens" },
        ],
        updated_at: Date.now(),
      },
    },
  });

  const res = await app.request("/dashboard/usage");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("GLM UI"));
  assert.ok(html.includes("PaaS 5h"), "label kuota PaaS 5h tampil");
  assert.ok(html.includes("PaaS Mingguan"), "label kuota PaaS mingguan tampil");
  assert.ok(html.includes("Start-Plan Harian"), "label kuota Start-Plan tampil");
  assert.ok(html.includes("100 / 300 tokens"), "sisa token Start-Plan tampil");
});

test("glm quota - readZcodeDeviceMid membaca deviceMid dari telemetry-state ZCode", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zr-zcode-home-"));
  try {
    fs.mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".zcode", "v2", "telemetry-state.json"),
      JSON.stringify({ deviceMid: "  test-device-mid  " }),
    );
    assert.strictEqual(readZcodeDeviceMid(home), "test-device-mid");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("glm quota - readZcodeDeviceMid tanpa file ZCode mengembalikan null tanpa crash", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "zr-zcode-empty-"));
  try {
    assert.strictEqual(readZcodeDeviceMid(home), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
