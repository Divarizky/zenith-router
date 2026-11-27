import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectAntigravityAcpAccountQuota,
  getAntigravityAcpCachedQuota,
  clearAntigravityAcpQuotaCacheForTests,
  parseAntigravityQuotaMessage,
} from "../src/services/antigravityAcp/quota.js";
import {
  getAntigravityAcpAccountLimitedUntil,
  getAntigravityAcpProfileStatus,
} from "../src/services/antigravityAcp/profiles.js";

test.beforeEach(() => {
  clearAntigravityAcpQuotaCacheForTests();
});

test("a. single-flight coalescing: two concurrent calls for same account run only 1 client probe", async () => {
  let createCalls = 0;
  let closeCalls = 0;
  let resolveInit;
  const initGate = new Promise((resolve) => { resolveInit = resolve; });

  const createClient = async () => {
    createCalls += 1;
    return {
      cwd: "/tmp",
      initialize: async () => { await initGate; return { protocolVersion: 1 }; },
      newSession: async () => ({ sessionId: "s1" }),
      close: async () => { closeCalls += 1; },
    };
  };

  const p1 = inspectAntigravityAcpAccountQuota("acc1", { createClient });
  const p2 = inspectAntigravityAcpAccountQuota("acc1", { createClient });

  resolveInit();
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(createCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(r1.status, "ready");
  assert.equal(r2.status, "ready");
  assert.equal(r1.checkedAt, r2.checkedAt);
});

test("b. TTL cache: second call within TTL does not invoke a new client worker", async () => {
  let createCalls = 0;
  const createClient = async () => {
    createCalls += 1;
    return {
      cwd: "/tmp",
      initialize: async () => ({ protocolVersion: 1 }),
      newSession: async () => ({ sessionId: "s1" }),
      close: async () => {},
    };
  };

  const first = await inspectAntigravityAcpAccountQuota("acc2", { createClient, ttlMs: 300_000 });
  const second = await inspectAntigravityAcpAccountQuota("acc2", { createClient, ttlMs: 300_000 });

  assert.equal(createCalls, 1);
  assert.equal(first.status, "ready");
  assert.equal(second.checkedAt, first.checkedAt);
  assert.ok(getAntigravityAcpCachedQuota("acc2"));
});

test("c. timeout handling: slow client is aborted and returns unknown without blocking", async () => {
  let aborted = false;
  let closeCalls = 0;

  const createClient = async (_workerId, { signal }) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return {
      cwd: "/tmp",
      initialize: () => new Promise(() => {}), // hangs forever
      newSession: async () => ({ sessionId: "s1" }),
      close: async () => { closeCalls += 1; },
    };
  };

  const result = await inspectAntigravityAcpAccountQuota("acc3", { createClient, timeoutMs: 40 });

  assert.equal(aborted, true);
  assert.equal(closeCalls, 1);
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "timeout");
  assert.equal(result.resetAt, null);
});

test("d. active limit detection: probe detecting limit sets account limited in profiles.js with resetAt", async () => {
  const expectedResetAt = Date.UTC(2026, 10, 28, 14, 0, 0);
  const limitMsg = "Usage Limit Reached. You have reached your current quota for this period. It will reset on Nov 28, 2026 14:00 UTC.";

  const createClient = async () => ({
    cwd: "/tmp",
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => {
      throw Object.assign(new Error(limitMsg), { code: -32000 });
    },
    close: async () => {},
  });

  const result = await inspectAntigravityAcpAccountQuota("acc4", { createClient });

  assert.equal(result.status, "limited");
  assert.equal(result.resetAt, expectedResetAt);
  assert.equal(getAntigravityAcpCachedQuota("acc4")?.resetAt, expectedResetAt);
});

test("e. passive quota parser: parses relative and absolute reset strings", () => {
  const nowMs = Date.UTC(2026, 10, 27, 10, 0, 0);

  const rel = parseAntigravityQuotaMessage(
    "Usage Limit Reached. You have reached your current quota for this period. It will reset in 2 hours and 30 minutes.",
    nowMs,
  );
  assert.deepEqual(rel, { resetAt: nowMs + 2 * 3_600_000 + 30 * 60_000 });

  const abs = parseAntigravityQuotaMessage(
    "Usage Limit Reached. You have reached your current quota for this period. It will reset on Nov 28, 2026 14:00 UTC.",
    nowMs,
  );
  assert.deepEqual(abs, { resetAt: Date.UTC(2026, 10, 28, 14, 0, 0) });

  assert.equal(parseAntigravityQuotaMessage("unrelated message", nowMs), null);
});
