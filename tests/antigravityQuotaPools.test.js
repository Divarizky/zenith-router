import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, replaceAntigravityAccountModels } from "../src/db/index.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";
import { parseQuotaPools, fetchAntigravityQuota } from "../src/services/quota/antigravity.js";
import { renderUsagePage } from "../src/ui/pages/usage.js";
import { listAvailableConnections } from "../src/services/fallback.js";
import { poolGroupForModel, isAntigravityPoolExhausted } from "../src/services/antigravityPools.js";

// Bentuk respons retrieveUserQuotaSummary dari agy 1.4.2 (akun Pro), dipangkas ke field yang dibaca.
const SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini-weekly", window: "weekly", resetTime: "2026-10-24T13:56:26Z", remainingFraction: 0.77323365 },
        { bucketId: "gemini-5h", window: "5h", resetTime: "2026-10-19T19:07:08Z", remainingFraction: 0.8350499 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        { bucketId: "3p-weekly", window: "weekly", resetTime: "2026-10-20T03:50:54Z", remainingFraction: 0 },
        { bucketId: "3p-5h", window: "5h", resetTime: "2026-10-19T20:58:51Z", disabled: true, remainingFraction: 1 },
      ],
    },
    {
      displayName: "Gemini 4 Argon",
      buckets: [
        { bucketId: "gemini-argon-wtu-weekly", window: "weekly", resetTime: "2026-10-24T11:52:16Z", remainingFraction: 0.66701853 },
        { bucketId: "gemini-argon-x", window: "monthly", resetTime: "2026-10-24T11:52:16Z", remainingFraction: 0.5 },
      ],
    },
  ],
};

const MODELS = {
  models: {
    "gemini-3.8-flash": { displayName: "Gemini 3.8 Flash", quotaInfo: { remainingFraction: 0.77, resetTime: "2026-10-24T13:56:26Z" } },
  },
  allowedTiers: [{ id: "standard-tier", isDefault: true }],
};

test("Antigravity pools - parser membaca limit per grup dan melewati bucket disabled atau window tak dikenal", () => {
  const pools = parseQuotaPools(SUMMARY);
  assert.deepStrictEqual(
    pools.map((p) => [p.label, p.window]),
    [
      ["Gemini Models · Mingguan", "weekly"],
      ["Gemini Models · 5 jam", "5h"],
      ["Claude and GPT models · Mingguan", "weekly"],
      ["Gemini 4 Argon · Mingguan", "weekly"],
    ],
    "3p-5h disabled dan window monthly tidak ikut"
  );
  const gemini5h = pools.find((p) => p.bucketId === "gemini-5h");
  assert.ok(Math.abs(gemini5h.remainingPercentage - 83.50499) < 1e-6, "sisa dinyatakan dalam persen");
  assert.strictEqual(gemini5h.resetAt, "2026-10-19T19:07:08.000Z");
  assert.strictEqual(pools.find((p) => p.bucketId === "3p-weekly").remainingPercentage, 0);
});

test("Antigravity pools - persen dibatasi di rentang 0-100", () => {
  const pools = parseQuotaPools({
    groups: [{ displayName: "G", buckets: [{ bucketId: "a", window: "5h", remainingFraction: 1.2 }, { bucketId: "b", window: "5h", remainingFraction: -0.1 }] }],
  });
  assert.deepStrictEqual(pools.map((p) => p.remainingPercentage), [100, 0]);
});

test("Antigravity pools - respons kosong atau tanpa groups menghasilkan daftar kosong", () => {
  assert.deepStrictEqual(parseQuotaPools(null), []);
  assert.deepStrictEqual(parseQuotaPools({}), []);
  assert.deepStrictEqual(parseQuotaPools({ groups: [{ buckets: [] }, { displayName: "X", buckets: "rusak" }] }), []);
  assert.deepStrictEqual(
    parseQuotaPools({ groups: [{ buckets: [{ bucketId: "a", window: "5h", remainingFraction: 0.5 }] }] }),
    [],
    "grup tanpa nama tidak dipakai meski bucketnya valid"
  );
});

test("Antigravity pools - fetchAntigravityQuota menyertakan pools dari retrieveUserQuotaSummary", async () => {
  initDb(":memory:");
  const calls = [];
  setOAuthFetch(async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.endsWith(":fetchAvailableModels")) return new Response(JSON.stringify(MODELS), { status: 200 });
    if (url.endsWith(":retrieveUserQuotaSummary")) return new Response(JSON.stringify(SUMMARY), { status: 200 });
    return new Response("not found", { status: 404 });
  });
  try {
    const quota = await fetchAntigravityQuota({ provider: "antigravity", credentials: { access_token: "t", project_id: "proj-1" } });
    assert.strictEqual(quota.pools.length, 4);
    assert.ok(quota.quotas["gemini-3.8-flash"], "bar per model tetap ada untuk baris per keluarga");
    const summaryCall = calls.find((c) => c.url.endsWith(":retrieveUserQuotaSummary"));
    assert.ok(summaryCall.url.startsWith("https://daily-cloudcode-pa.googleapis.com/"), "memakai host daily");
    assert.deepStrictEqual(summaryCall.body, { project: "proj-1" });
  } finally {
    setOAuthFetch(null);
  }
});

test("Antigravity pools - kegagalan endpoint summary tidak menggagalkan sinkron", async () => {
  initDb(":memory:");
  setOAuthFetch(async (url) => {
    if (url.endsWith(":fetchAvailableModels")) return new Response(JSON.stringify(MODELS), { status: 200 });
    return new Response("server error", { status: 500 });
  });
  try {
    const quota = await fetchAntigravityQuota({ provider: "antigravity", credentials: { access_token: "t" } });
    assert.deepStrictEqual(quota.pools, []);
    assert.ok(quota.quotas["gemini-3.8-flash"], "kuota per model tetap tersedia");
  } finally {
    setOAuthFetch(null);
  }
});

test("Dashboard usage - kartu Antigravity menampilkan limit 5 jam dan mingguan di atas baris keluarga", () => {
  initDb(":memory:");
  const c = addConnection({
    provider: "antigravity",
    name: "pro-akun",
    auth_type: "oauth",
    credentials: {
      quota: {
        provider: "antigravity",
        unit: "tier",
        plan: "Google AI Pro",
        pools: parseQuotaPools(SUMMARY),
        quotas: {
          "gemini-3.8-flash": { used: 230, total: 1000, remainingPercentage: 77, resetAt: "2026-10-24T13:56:26.000Z", displayName: "Gemini 3.8 Flash" },
        },
        updated_at: Date.now(),
      },
    },
  });
  replaceAntigravityAccountModels(c.id, "Google AI Pro", [
    { modelId: "gemini-3.8-flash", displayName: "Gemini 3.8 Flash", recommended: true, quotaRemaining: 0.77, currentTier: "Google AI Pro" },
  ]);
  const html = renderUsagePage(20120, {});
  assert.ok(html.includes("Gemini Models · 5 jam"), "label window 5 jam tampil");
  assert.ok(html.includes("Claude and GPT models · Mingguan"), "label grup mingguan tampil");
  assert.ok(html.includes("16% terpakai"), "persen terpakai dihitung dari sisa");
  const poolAt = html.indexOf("Gemini Models · 5 jam");
  const familyAt = html.indexOf(">Gemini 3.8 Flash<");
  assert.ok(poolAt > -1 && familyAt > -1 && poolAt < familyAt, "pool tampil sebelum baris keluarga");
});

test("Antigravity pools - model dipetakan ke grup pool lewat id", () => {
  assert.strictEqual(poolGroupForModel("gemini-4-argon-medium"), "Gemini 4 Argon");
  assert.strictEqual(poolGroupForModel("gemini-3.8-flash"), "Gemini Models");
  assert.strictEqual(poolGroupForModel("claude-opus-5-5-high"), "Claude and GPT models");
  assert.strictEqual(poolGroupForModel("gpt-oss-120b-medium"), "Claude and GPT models");
  assert.strictEqual(poolGroupForModel("chat_20706"), null, "model tanpa grup tidak punya pool");
});

test("Antigravity pools - exhausted hanya saat sisa 0 dan reset masih di depan", () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 3600_000).toISOString();
  const quota = {
    pools: [
      { group: "Claude and GPT models", window: "weekly", remainingPercentage: 0, resetAt: future },
      { group: "Gemini Models", window: "5h", remainingPercentage: 0, resetAt: past },
      { group: "Gemini 4 Argon", window: "weekly", remainingPercentage: 40, resetAt: future },
    ],
  };
  assert.strictEqual(isAntigravityPoolExhausted(quota, "claude-sonnet-4-6"), true);
  assert.strictEqual(isAntigravityPoolExhausted(quota, "gemini-3.8-flash"), false, "reset sudah lewat, data basi");
  assert.strictEqual(isAntigravityPoolExhausted(quota, "gemini-4-argon-medium"), false, "sisa 40% tidak memblokir");
  assert.strictEqual(isAntigravityPoolExhausted(null, "claude-sonnet-4-6"), false);
  assert.strictEqual(isAntigravityPoolExhausted(quota, "chat_20706"), false);
});

test("Routing Antigravity - pool Claude habis memblokir akun itu untuk model Claude saja", () => {
  initDb(":memory:");
  const future = new Date(Date.now() + 3600_000).toISOString();
  const pools = [
    { group: "Claude and GPT models", window: "weekly", remainingPercentage: 0, resetAt: future },
    { group: "Gemini Models", window: "weekly", remainingPercentage: 80, resetAt: future },
  ];
  const habis = addConnection({ provider: "antigravity", name: "habis", auth_type: "oauth", credentials: { quota: { pools } } });
  const sehat = addConnection({ provider: "antigravity", name: "sehat", auth_type: "oauth", credentials: {} });
  const rows = [
    { modelId: "claude-opus-5-5-high", displayName: "Opus 5.5", recommended: true, quotaRemaining: 1 },
    { modelId: "gemini-3.8-flash", displayName: "Flash", recommended: true, quotaRemaining: 1 },
  ];
  replaceAntigravityAccountModels(habis.id, "free-tier", rows);
  replaceAntigravityAccountModels(sehat.id, "free-tier", rows);

  const claude = listAvailableConnections("antigravity", { model: "claude-opus-5-5-high" }).map((c) => c.id);
  assert.deepStrictEqual(claude, [sehat.id], "akun dengan pool Claude habis dilewati");
  const gemini = listAvailableConnections("antigravity", { model: "gemini-3.8-flash" }).map((c) => c.id);
  assert.deepStrictEqual(gemini, [habis.id, sehat.id], "pool Claude tidak memblokir model Gemini");
});

test("Routing Antigravity - pool habis juga memblokir akun yang belum punya inventaris", () => {
  initDb(":memory:");
  const future = new Date(Date.now() + 3600_000).toISOString();
  const belum = addConnection({
    provider: "antigravity",
    name: "belum-sinkron",
    auth_type: "oauth",
    credentials: { quota: { pools: [{ group: "Claude and GPT models", window: "5h", remainingPercentage: 0, resetAt: future }] } },
  });
  const polos = addConnection({ provider: "antigravity", name: "tanpa-pool", auth_type: "oauth", credentials: {} });
  const ids = listAvailableConnections("antigravity", { model: "claude-sonnet-4-6" }).map((c) => c.id);
  assert.deepStrictEqual(ids, [polos.id], "pool habis memblokir akun belum sinkron, akun tanpa pool tetap dilayani");
  assert.ok(!ids.includes(belum.id));
});

test("Routing Antigravity - pool tanpa data tidak memblokir", () => {
  initDb(":memory:");
  const polos = addConnection({ provider: "antigravity", name: "tanpa-pool", auth_type: "oauth", credentials: {} });
  replaceAntigravityAccountModels(polos.id, "free-tier", [
    { modelId: "claude-opus-5-5-high", displayName: "Opus 5.5", recommended: true, quotaRemaining: 1 },
  ]);
  assert.deepStrictEqual(listAvailableConnections("antigravity", { model: "claude-opus-5-5-high" }).map((c) => c.id), [polos.id]);
});
