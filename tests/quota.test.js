import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnectionById, mergeConnectionCredentials } from "../src/db/index.js";
import {
  syncProviderQuota,
  isConnectionExhausted,
  getAllQuotaStatus,
  setCustomQuotaFetcher,
} from "../src/services/quota.js";
import { getActiveConnection } from "../src/services/auth.js";
import { app } from "../src/index.js";

test("quota service - syncProviderQuota updates quota cache in SQLite", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "glm",
    name: "GLM User",
    credentials: { api_key: "k1" },
  });

  setCustomQuotaFetcher(async (connection) => {
    return {
      remaining: 250000,
      total: 1000000,
      unit: "tokens",
      is_exhausted: false,
    };
  });

  const updatedQuota = await syncProviderQuota(conn);
  assert.ok(updatedQuota);
  assert.strictEqual(updatedQuota.remaining, 250000);
  assert.strictEqual(updatedQuota.is_exhausted, false);

  // Check persistence in SQLite
  const inDb = getConnectionById(conn.id);
  assert.deepStrictEqual(inDb.credentials.quota.remaining, 250000);

  setCustomQuotaFetcher(null);
});

test("quota service - sync keeps tokens rotated while the quota fetch was in flight", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "claude",
    name: "Claude OAuth",
    credentials: { access_token: "old-access", refresh_token: "old-refresh" },
  });

  setCustomQuotaFetcher(async () => {
    // A token refresh lands while the quota endpoint is still answering.
    mergeConnectionCredentials(conn.id, { access_token: "new-access", refresh_token: "new-refresh" });
    return { remaining: 10, unit: "requests", is_exhausted: false };
  });

  try {
    await syncProviderQuota(conn);
  } finally {
    setCustomQuotaFetcher(null);
  }

  const inDb = getConnectionById(conn.id);
  assert.strictEqual(inDb.credentials.refresh_token, "new-refresh");
  assert.strictEqual(inDb.credentials.access_token, "new-access");
  assert.strictEqual(inDb.credentials.quota.remaining, 10);
});

test("quota service - marks and skips exhausted connection", async () => {
  initDb(":memory:");

  const conn1 = addConnection({
    provider: "claude",
    name: "Claude Exhausted",
    credentials: {
      access_token: "tok1",
      quota: { remaining: 0, is_exhausted: true },
    },
  });

  const conn2 = addConnection({
    provider: "claude",
    name: "Claude Active",
    credentials: {
      access_token: "tok2",
      quota: { remaining: 500000, is_exhausted: false },
    },
  });

  assert.strictEqual(isConnectionExhausted(conn1), true);
  assert.strictEqual(isConnectionExhausted(conn2), false);

  // getActiveConnection should skip conn1 and pick conn2
  const picked = getActiveConnection("claude");
  assert.ok(picked);
  assert.strictEqual(picked.id, conn2.id);
});

test("GET /api/quota - returns quota status for all accounts", async () => {
  initDb(":memory:");

  addConnection({
    provider: "github",
    name: "Copilot Work",
    credentials: {
      api_key: "gh_key",
      quota: { remaining: 1500, unit: "requests" },
    },
  });

  const res = await app.request("/api/quota");
  assert.strictEqual(res.status, 200);

  const json = await res.json();
  assert.ok(Array.isArray(json));
  const githubEntry = json.find((item) => item.provider === "github");
  assert.ok(githubEntry);
  assert.strictEqual(githubEntry.name, "Copilot Work");
  assert.strictEqual(githubEntry.quota.remaining, 1500);
  // Prioritas dipakai klien usage untuk memilih akun seperti router.
  assert.strictEqual(typeof githubEntry.priority, "number");
});

test("quota service - getAllQuotaStatus includes virtual connection for ACP accounts", async () => {
  initDb(":memory:");
  const { setAntigravityAcpProfiles } = await import("../src/services/antigravityAcp/profiles.js");
  const testId = "11112222333344445555666677778888";
  await setAntigravityAcpProfiles([
    { id: testId, name: "ACP User", enabled: true },
  ]);

  const allStatus = getAllQuotaStatus();
  const acpEntry = allStatus.find((item) => item.id === `acp-${testId}`);
  assert.ok(acpEntry, "ACP account must be present in getAllQuotaStatus");
  assert.strictEqual(acpEntry.name, "ACP User");
  assert.strictEqual(acpEntry.provider, "antigravity-acp");
  assert.strictEqual(acpEntry.auth_type, "oauth");
  assert.strictEqual(acpEntry.is_active, 1);
  assert.ok(acpEntry.quota);
  assert.strictEqual(acpEntry.quota.type, "reset_time");
  assert.strictEqual(typeof acpEntry.is_exhausted, "boolean");
});
