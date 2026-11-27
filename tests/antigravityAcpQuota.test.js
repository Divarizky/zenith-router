import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectAntigravityAcpAccountQuota,
  getAntigravityAcpCachedQuota,
  clearAntigravityAcpQuotaCacheForTests,
  parseAntigravityQuotaMessage,
  parseAntigravityAcpUsageReply,
  parseResetTimestamp,
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

test("f. parseAntigravityAcpUsageReply: parses nested markdown list from real agy_acp_server output", () => {
  const usageOutput = `
### Current Plan
Free Tier (Antigravity Developer)

### Quota Limits
- **Gemini Models**
  *(Models within this group: gemini-2.5-pro, gemini-2.5-flash)*
  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 27, 2026, 09:12 UTC)
  - **Weekly Limit Remaining:** 95% remaining (resets Dec 04, 2026, 04:12 UTC)

- **Claude and GPT models**
  *(Models within this group: claude-3-7-sonnet, gpt-4o)*
  - **Five Hour Limit Remaining:** 45% remaining (resets Nov 27, 2026, 11:30 UTC)
  - **Weekly Limit Remaining:** 80% remaining (resets Dec 04, 2026, 04:12 UTC)

### Other Information
All limits are reset automatically.
`;

  const { windows, notes } = parseAntigravityAcpUsageReply(usageOutput);

  assert.equal(notes, null);
  assert.equal(windows.length, 4);

  assert.deepEqual(windows[0], {
    label: "Gemini Models · Five Hour Limit",
    group: "Gemini Models",
    bucket: "Five Hour Limit",
    remainingPercent: 100,
    usedPercent: 0,
    resetsAt: "2026-11-27T09:12:00.000Z",
  });

  assert.deepEqual(windows[1], {
    label: "Gemini Models · Weekly Limit",
    group: "Gemini Models",
    bucket: "Weekly Limit",
    remainingPercent: 95,
    usedPercent: 5,
    resetsAt: "2026-12-04T04:12:00.000Z",
  });

  assert.deepEqual(windows[2], {
    label: "Claude and GPT models · Five Hour Limit",
    group: "Claude and GPT models",
    bucket: "Five Hour Limit",
    remainingPercent: 45,
    usedPercent: 55,
    resetsAt: "2026-11-27T11:30:00.000Z",
  });

  assert.deepEqual(windows[3], {
    label: "Claude and GPT models · Weekly Limit",
    group: "Claude and GPT models",
    bucket: "Weekly Limit",
    remainingPercent: 80,
    usedPercent: 20,
    resetsAt: "2026-12-04T04:12:00.000Z",
  });
});

test("g. inspectAntigravityAcpAccountQuota: sends /usage prompt and populates quotas and windows", async () => {
  let promptCalls = [];
  let updateListener = null;

  const usageOutput = `
### Quota Limits
- **Gemini Models**
  - **Five Hour Limit Remaining:** 85% remaining (resets Nov 27, 2026, 12:00 UTC)
  - **Weekly Limit Remaining:** 90% remaining (resets Dec 04, 2026, 04:00 UTC)
`;

  const createClient = async () => ({
    cwd: "/tmp",
    onUpdate: (listener) => {
      updateListener = listener;
    },
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => {
      // simulate available_commands_update
      if (updateListener) {
        updateListener({
          type: "available_commands_update",
          availableCommands: ["usage", "help"],
        });
      }
      return {
        sessionId: "session-usage-1",
        _meta: { antigravity: { tier: { name: "Pro Tier" } } },
      };
    },
    prompt: async (args) => {
      promptCalls.push(args);
      // simulate chunk streaming via onUpdate
      if (updateListener) {
        updateListener({
          type: "agent_message_chunk",
          content: { text: usageOutput },
        });
      }
      return { ok: true };
    },
    close: async () => {},
  });

  const res = await inspectAntigravityAcpAccountQuota("acc-usage", { createClient });

  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0].sessionId, "session-usage-1");
  assert.equal(promptCalls[0].prompt[0].text, "/usage");

  assert.equal(res.status, "ready");
  assert.equal(res.planType, "Pro Tier");
  assert.equal(res.windows.length, 2);
  assert.ok(res.quotas);

  const keys = Object.keys(res.quotas);
  assert.equal(keys.length, 2);
  const q0 = res.quotas[keys[0]];
  assert.equal(q0.displayName, "Gemini Models · Five Hour Limit");
  assert.equal(q0.remaining, 85);
  assert.equal(q0.used, 15);
  assert.equal(q0.usedLabel, "15% used");
  assert.equal(q0.resetAt, "2026-11-27T12:00:00.000Z");
});

test("h. inspectAntigravityAcpAccountQuota: marks limited if any window has remainingPercent <= 0", async () => {
  let updateListener = null;

  const usageOutput = `
### Quota Limits
- **Gemini Models**
  - **Five Hour Limit Remaining:** 0% remaining (resets Nov 27, 2026, 14:00 UTC)
`;

  const createClient = async () => ({
    cwd: "/tmp",
    onUpdate: (listener) => {
      updateListener = listener;
    },
    initialize: async () => ({ protocolVersion: 1 }),
    newSession: async () => ({ sessionId: "s-zero" }),
    prompt: async () => {
      if (updateListener) {
        updateListener({
          type: "agent_message_chunk",
          content: { text: usageOutput },
        });
      }
      return { ok: true };
    },
    close: async () => {},
  });

  const res = await inspectAntigravityAcpAccountQuota("acc-zero", { createClient });

  assert.equal(res.status, "limited");
  assert.equal(res.resetAt, Date.UTC(2026, 10, 27, 14, 0, 0));
  assert.equal(getAntigravityAcpCachedQuota("acc-zero")?.status, "limited");
  assert.equal(getAntigravityAcpCachedQuota("acc-zero")?.resetAt, Date.UTC(2026, 10, 27, 14, 0, 0));
});
