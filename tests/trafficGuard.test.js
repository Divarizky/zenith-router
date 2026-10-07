import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import {
  acquireAccountSlot,
  releaseAccountSlot,
  resetTrafficGuardState,
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
