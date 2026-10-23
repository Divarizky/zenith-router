import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getDb, getConnections, getModelLockUntil } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { extractQuotaCooldownMs } from "../src/services/fallback.js";
import { getRecentUsage, getUsageStats, recordUsage } from "../src/services/usage.js";
import { isConnectionInCooldown } from "../src/services/auth.js";
import { renderUsagePage } from "../src/ui/pages/usage.js";

const MODEL_ID = "gemini-3.8-flash-high";
const PRIMARY_MODEL = `ag/${MODEL_ID}`;

function seedTwoAccounts() {
  initDb(":memory:");
  const c1 = addConnection({
    provider: "antigravity",
    name: "divarizky28@gmail.com",
    auth_type: "oauth",
    credentials: { access_token: "tok1", refresh_token: "ref1" },
  });
  const c2 = addConnection({
    provider: "antigravity",
    name: "deepa.rizky@gmail.com",
    auth_type: "oauth",
    credentials: { access_token: "tok2", refresh_token: "ref2" },
  });
  return { c1, c2 };
}

function okOpenAI(content = "hello world") {
  return new Response(
    JSON.stringify({
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: content }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function googleQuota429(retryDelaySec = "497880.916563646s") {
  const payload = {
    error: {
      code: 429,
      message: "Individual quota reached. Please upgrade your subscription.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "QUOTA_EXHAUSTED",
          domain: "cloudcode-pa.googleapis.com",
          metadata: {
            uiMessage: "true",
            model: MODEL_ID,
            quotaResetDelay: retryDelaySec,
            quotaResetTimeStamp: new Date(Date.now() + 497880 * 1000).toISOString(),
          },
        },
        {
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay: retryDelaySec,
        },
      ],
    },
  };
  return new Response(JSON.stringify(payload), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

test("extractQuotaCooldownMs - parses Google retryDelay and ErrorInfo metadata correctly", () => {
  const res = new Response("", { status: 429 });
  const googleBody = JSON.stringify({
    error: {
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.RetryInfo",
          retryDelay: "3600.5s",
        },
      ],
    },
  });
  const ms = extractQuotaCooldownMs(res, googleBody, 60000);
  assert.strictEqual(ms, 3600500);

  // Header Retry-After takes precedence if present
  const resHeader = new Response("", { status: 429, headers: { "Retry-After": "120" } });
  const msHeader = extractQuotaCooldownMs(resHeader, googleBody, 60000);
  assert.strictEqual(msHeader, 120000);

  // Timestamp format
  const futureTime = new Date(Date.now() + 50000).toISOString();
  const timestampBody = JSON.stringify({
    details: [
      {
        metadata: {
          quotaResetTimeStamp: futureTime,
        },
      },
    ],
  });
  const msTimestamp = extractQuotaCooldownMs(res, timestampBody, 60000);
  assert.ok(msTimestamp >= 48000 && msTimestamp <= 52000, `dapat ${msTimestamp}`);
});

test("quota failover - account 1 exhausted 429 locks for full duration and immediately switches to account 2", async () => {
  const { c1, c2 } = seedTwoAccounts();
  const attemptedAccounts = [];

  setCustomExecutor({
    async execute({ connection }) {
      attemptedAccounts.push(connection.name);
      if (connection.name === "divarizky28@gmail.com") {
        return googleQuota429("497880s");
      }
      return okOpenAI("berhasil dijawab akun 2");
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: PRIMARY_MODEL, messages: [{ role: "user", content: "test" }] }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, "berhasil dijawab akun 2");
    assert.deepStrictEqual(attemptedAccounts, ["divarizky28@gmail.com", "deepa.rizky@gmail.com"]);

    // Check headers returned
    assert.strictEqual(res.headers.get("X-Zenith-Account"), "deepa.rizky@gmail.com");

    // One 429 is not enough to park the account: the lock appears on the second
    // manual attempt, and only then does the lock last the full quota window.
    const conns = getConnections("antigravity");
    const conn1 = conns.find((c) => c.name === "divarizky28@gmail.com");
    assert.strictEqual(getModelLockUntil(conn1.id, MODEL_ID), null, "satu 429 belum mengunci model");

    attemptedAccounts.length = 0;
    const retry = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: PRIMARY_MODEL, messages: [{ role: "user", content: "test ulang" }] }),
    });
    assert.strictEqual(retry.status, 200);
    assert.deepStrictEqual(attemptedAccounts, ["divarizky28@gmail.com", "deepa.rizky@gmail.com"], "percobaan kedua masih mencoba akun 1");

    const lockUntil = getModelLockUntil(conn1.id, MODEL_ID);
    assert.ok(lockUntil, "lock per model harus ada setelah kegagalan kedua");
    const diffHours = (lockUntil - Date.now()) / (3600 * 1000);
    assert.ok(diffHours > 135 && diffHours < 140, `harus sekitar 138 jam, dapat ${diffHours} jam`);

    // Next immediate request must directly use account 2 without attempting account 1
    attemptedAccounts.length = 0;
    const res2 = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: PRIMARY_MODEL, messages: [{ role: "user", content: "test 2" }] }),
    });
    assert.strictEqual(res2.status, 200);
    assert.deepStrictEqual(attemptedAccounts, ["deepa.rizky@gmail.com"], "akun 1 yang terkunci langsung dilewati");
  } finally {
    setCustomExecutor(null);
  }
});

test("auth failover - if refresh token attempt fails with 401/403, router proceeds to account 2", async () => {
  seedTwoAccounts();
  const attemptedAccounts = [];

  setCustomExecutor({
    async execute({ connection }) {
      attemptedAccounts.push(connection.name);
      if (connection.name === "divarizky28@gmail.com") {
        return new Response(JSON.stringify({ error: { code: 401, message: "Invalid credentials" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return okOpenAI("dijawab akun 2 setelah akun 1 gagal auth");
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: PRIMARY_MODEL, messages: [{ role: "user", content: "auth test" }] }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.choices[0].message.content, "dijawab akun 2 setelah akun 1 gagal auth");
    assert.ok(attemptedAccounts.includes("deepa.rizky@gmail.com"));
    assert.strictEqual(res.headers.get("X-Zenith-Account"), "deepa.rizky@gmail.com");
  } finally {
    setCustomExecutor(null);
  }
});

test("UI attribution - Recent Requests hides the account, usage stats keeps by_account", () => {
  initDb(":memory:");
  const c = addConnection({
    provider: "antigravity",
    name: "divarizky28@gmail.com",
    credentials: { api_key: "k" },
  });

  recordUsage({
    connectionId: c.id,
    provider: "antigravity",
    model: "gemini-3.8-flash",
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 200,
  });

  // Verify getRecentUsage includes connection_name
  const recent = getRecentUsage(5);
  assert.strictEqual(recent.length, 1);
  assert.strictEqual(recent[0].connection_name, "divarizky28@gmail.com");

  // Verify getUsageStats includes by_account breakdown
  const stats = getUsageStats({ days: 30 });
  assert.ok(Array.isArray(stats.by_account));
  assert.strictEqual(stats.by_account.length, 1);
  assert.strictEqual(stats.by_account[0].name, "divarizky28@gmail.com");
  assert.strictEqual(stats.by_account[0].count, 1);
  assert.strictEqual(stats.by_account[0].total_tokens, 150);

  // Recent Requests no longer shows the account prefix; the breakdown table still does.
  const html = renderUsagePage({
    stats,
    quotas: [],
    topology: { nodes: [] },
    recent,
    antigravityInventory: new Map(),
    port: 20120,
    query: {},
  });

  assert.ok(!html.includes("[divarizky28@gmail.com]"), "Recent Requests tidak boleh menampilkan prefix akun");
  assert.ok(html.includes("Token Consumption by Account"));
  assert.ok(html.includes("gemini-3.8-flash"));
  assert.ok(html.includes("divarizky28@gmail.com"), "tabel per akun tetap menampilkan nama akun");
});
