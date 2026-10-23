import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import {
  acquireAccountSlot,
  releaseAccountSlot,
  resetTrafficGuardState,
  getActiveProviders,
} from "../src/services/trafficGuard.js";

test("Traffic Guard - enforces max concurrency cap per connection", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "true");
  setSetting("max_account_concurrency", "2");
  setSetting("request_jitter_enabled", "false");

  const conn = { id: 101, auth_type: "oauth" };

  // Acquire slot 1 and slot 2 (should resolve immediately)
  const rel1 = await acquireAccountSlot(conn);
  const rel2 = await acquireAccountSlot(conn);

  let slot3Acquired = false;
  const p3 = acquireAccountSlot(conn).then((rel) => {
    slot3Acquired = true;
    return rel;
  });

  // Slot 3 should be queued because max concurrency is 2
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(slot3Acquired, false, "Slot 3 must wait in queue when 2 slots are in flight");

  // Release slot 1 -> slot 3 should immediately acquire
  rel1();
  const rel3 = await p3;
  assert.strictEqual(slot3Acquired, true, "Slot 3 must be acquired once a slot is released");

  rel2();
  rel3();
});

test("Traffic Guard - a released slot goes to the waiter, not to a request arriving meanwhile", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "true");
  setSetting("max_account_concurrency", "1");
  setSetting("request_jitter_enabled", "false");

  const conn = { id: 103, auth_type: "oauth" };
  const rel1 = await acquireAccountSlot(conn);

  let waiterAcquired = false;
  let lateAcquired = false;
  const pWaiter = acquireAccountSlot(conn).then((rel) => ((waiterAcquired = true), rel));
  await new Promise((r) => setTimeout(r, 10));

  // Release, then a new request arrives before the waiter has resumed.
  rel1();
  const pLate = acquireAccountSlot(conn).then((rel) => ((lateAcquired = true), rel));

  const relWaiter = await pWaiter;
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(waiterAcquired, true);
  assert.strictEqual(lateAcquired, false, "The cap of 1 must hold: the late request waits");

  relWaiter();
  const relLate = await pLate;
  assert.strictEqual(lateAcquired, true);
  relLate();
});

test("Traffic Guard - handles client abort while waiting in queue", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "true");
  setSetting("max_account_concurrency", "1");
  setSetting("request_jitter_enabled", "false");

  const conn = { id: 102, auth_type: "oauth" };

  const rel1 = await acquireAccountSlot(conn);

  const controller = new AbortController();
  const p2 = acquireAccountSlot(conn, controller.signal);

  // Abort while queued
  controller.abort();

  await assert.rejects(p2, /aborted/i, "Aborted request must reject and exit queue");

  rel1();
});

test("Traffic Guard - no-auth virtual connection counts as active traffic", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "true");
  setSetting("max_account_concurrency", "1");
  setSetting("request_jitter_enabled", "false");

  // Virtual connection minted for a no-auth provider: no id, no DB row.
  const virtualConn = { id: null, provider: "opencode", auth_type: "noauth" };

  const release = await acquireAccountSlot(virtualConn);
  assert.deepStrictEqual([...getActiveProviders()], ["opencode"], "no-auth traffic is reported as in flight");

  release();
  release(); // double release must not underflow the count
  assert.deepStrictEqual([...getActiveProviders()], [], "active clears once the request finishes");
});

test("Traffic Guard - provider is active even when the guard is disabled", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "false");

  const release = await acquireAccountSlot({ id: 104, provider: "cline", auth_type: "oauth" });
  assert.deepStrictEqual([...getActiveProviders()], ["cline"], "topology stays honest with the guard off");

  release();
  assert.deepStrictEqual([...getActiveProviders()], []);
});

test("Traffic Guard - disabled state bypasses concurrency limiter", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "false");
  setSetting("max_account_concurrency", "1");

  const conn = { id: 103, auth_type: "oauth" };

  // When disabled, multiple calls acquire immediately without blocking
  const rel1 = await acquireAccountSlot(conn);
  const rel2 = await acquireAccountSlot(conn);
  const rel3 = await acquireAccountSlot(conn);

  assert.strictEqual(typeof rel1, "function");
  assert.strictEqual(typeof rel2, "function");
  assert.strictEqual(typeof rel3, "function");
});

test("Traffic Guard - enforces minimum throttle cool-off between requests on same session account", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "true");
  setSetting("max_account_concurrency", "2");
  setSetting("request_jitter_enabled", "false");
  setSetting("provider_throttle_ms:custom-session", "50");

  const conn = { id: 105, provider: "custom-session", auth_type: "session" };

  // Turn 1
  const rel1 = await acquireAccountSlot(conn);
  rel1(); // Finished turn 1

  // Turn 2 immediately after Turn 1: should be delayed by throttle (50ms)
  const start = Date.now();
  const rel2 = await acquireAccountSlot(conn);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 35, `Turn 2 must respect minimum throttle cool-off (elapsed: ${elapsed}ms)`);
  rel2();
});
