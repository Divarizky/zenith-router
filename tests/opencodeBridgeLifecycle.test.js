import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureOpencodeBridge,
  setOpencodeBridgeActive,
} from "../src/services/opencodeBridge.js";

test("ensureOpencodeBridge respawns when the active flag outlives its worker", async () => {
  // Simulates a bridge that was started outside this process and has since died:
  // the flag is still set, no managed child is held, and the port no longer answers.
  setOpencodeBridgeActive(true);
  let started = 0;

  const ok = await ensureOpencodeBridge({
    isRunning: async () => false,
    start: async () => {
      started += 1;
      return { ok: true, url: "http://127.0.0.1:20129" };
    },
  });

  assert.equal(ok, true);
  assert.equal(started, 1, "a dead bridge must be respawned instead of trusted");

  setOpencodeBridgeActive(false);
});

test("ensureOpencodeBridge keeps a live external bridge without spawning another", async () => {
  setOpencodeBridgeActive(true);
  let started = 0;

  const ok = await ensureOpencodeBridge({
    isRunning: async () => true,
    start: async () => {
      started += 1;
      return { ok: true, url: "http://127.0.0.1:20129" };
    },
  });

  assert.equal(ok, true);
  assert.equal(started, 0, "a reachable bridge must not be duplicated");

  setOpencodeBridgeActive(false);
});
