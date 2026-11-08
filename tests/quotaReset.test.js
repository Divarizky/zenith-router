import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, mergeConnectionCredentials, setConnectionCooldown, getConnectionById } from "../src/db/index.js";
import { isQuotaBlocking, isQuotaProbeDue, QUOTA_PROBE_MS } from "../src/services/quota.js";
import { listAvailableConnections } from "../src/services/fallback.js";

const NOW = 1_800_000_000_000;

function glmPair() {
  initDb(":memory:");
  const a = addConnection({ provider: "glm", name: "akun-1", auth_type: "api_key", credentials: { api_key: "x" } });
  addConnection({ provider: "glm", name: "akun-2", auth_type: "api_key", credentials: { api_key: "y" } });
  return a;
}

const names = () => listAvailableConnections("glm", { model: "glm-4-flash" }).map((c) => c.name);

test("quota reset - exhausted account with a passed reset time is routable again", () => {
  const a = glmPair();
  mergeConnectionCredentials(a.id, { quota: { remaining: 0, is_exhausted: true, reset_at: NOW - 60_000, updated_at: NOW - 120_000 } });
  assert.strictEqual(isQuotaBlocking(getConnectionById(a.id), NOW), false);
});

test("quota reset - exhausted account before its reset time stays blocked", () => {
  const a = glmPair();
  mergeConnectionCredentials(a.id, { quota: { remaining: 0, is_exhausted: true, reset_at: NOW + 3_600_000, updated_at: NOW } });
  assert.strictEqual(isQuotaBlocking(getConnectionById(a.id), NOW), true);
});

test("quota probe - exhausted account without reset time is probed only after the probe window", () => {
  const a = glmPair();
  mergeConnectionCredentials(a.id, { quota: { remaining: 0, is_exhausted: true, updated_at: NOW - 60_000 } });
  assert.strictEqual(isQuotaProbeDue(getConnectionById(a.id), NOW), false);

  mergeConnectionCredentials(a.id, { quota: { remaining: 0, is_exhausted: true, updated_at: NOW - QUOTA_PROBE_MS - 1 } });
  assert.strictEqual(isQuotaProbeDue(getConnectionById(a.id), NOW), true);
});

// Mencegah: probe akun prioritas 1 dengan cache basi melewati akun sehat prioritas 2.
test("quota probe - a probed account takes the slot only when no healthy account can serve", () => {
  const a = glmPair();
  mergeConnectionCredentials(a.id, { quota: { remaining: 0, is_exhausted: true, updated_at: Date.now() - QUOTA_PROBE_MS - 1000 } });
  assert.deepStrictEqual(names(), ["akun-2"], "akun sehat dipakai, probe tidak ikut dipasang");
});

// Mencegah: probe ikut dipasang saat akun sehat tersedia, sehingga urutan prioritas rusak.
test("quota probe - a stale priority-1 account does not displace a healthy priority-2 account", () => {
  initDb(":memory:");
  const p1 = addConnection({ provider: "glm", name: "akun-1", auth_type: "api_key", credentials: { api_key: "x" } });
  addConnection({ provider: "glm", name: "akun-2", auth_type: "api_key", credentials: { api_key: "y" } });
  mergeConnectionCredentials(p1.id, { quota: { remaining: 0, is_exhausted: true, updated_at: Date.now() - QUOTA_PROBE_MS - 1000 } });
  const order = names();
  assert.strictEqual(order[0], "akun-2");
});

test("cooldown extension - a longer deadline replaces an active shorter one", () => {
  const a = glmPair();
  const base = Date.now();
  setConnectionCooldown(a.id, base + 60_000);
  setConnectionCooldown(a.id, base + 3_600_000);
  assert.strictEqual(getConnectionById(a.id).cooldown_until, base + 3_600_000);
});

test("cooldown extension - a shorter deadline never shortens an active lock", () => {
  const a = glmPair();
  const base = Date.now();
  setConnectionCooldown(a.id, base + 3_600_000);
  setConnectionCooldown(a.id, base + 60_000);
  assert.strictEqual(getConnectionById(a.id).cooldown_until, base + 3_600_000);
});

// Mencegah: sync yang gagal mencap updated_at baru, sehingga akun basi tidak pernah
// jatuh tempo untuk probe selama scheduler terus berjalan. Memakai jalur produksi
// (fetchLiveQuota), bukan setCustomQuotaFetcher yang tidak dipakai di src/.
test("quota sync - a failed live fetch keeps the previous updated_at so the probe can become due", async () => {
  const a = glmPair();
  const { syncProviderQuota } = await import("../src/services/quota.js");
  const oldStamp = Date.now() - QUOTA_PROBE_MS - 1000;
  mergeConnectionCredentials(a.id, { quota: { remaining: 0, is_exhausted: true, updated_at: oldStamp } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("gagal", { status: 500 });
  try {
    await syncProviderQuota(getConnectionById(a.id), { quiet: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const stored = getConnectionById(a.id).credentials.quota;
  assert.strictEqual(stored.updated_at, oldStamp, "cap sync gagal tidak boleh diperbarui");
  assert.strictEqual(isQuotaProbeDue(getConnectionById(a.id)), true, "akun tetap jatuh tempo untuk probe");
});
