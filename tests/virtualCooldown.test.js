import test from "node:test";
import assert from "node:assert/strict";
import {
  isVirtualInCooldown,
  parkThresholdReached,
  resetAccountStrikes,
  resetVirtualCooldowns,
  setVirtualCooldown,
  virtualLockKey,
} from "../src/services/accountCooldown.js";

const virtual = { id: null, provider: "ovh", name: "OVH (Virtual)" };

test("virtual - cooldown model tidak menutup model lain pada provider yang sama", () => {
  resetVirtualCooldowns();
  setVirtualCooldown("ovh", "ovh/gpt-oss-20b", Date.now() + 60_000);
  assert.equal(isVirtualInCooldown("ovh", "ovh/gpt-oss-20b"), true);
  assert.equal(isVirtualInCooldown("ovh", "ovh/Qwen3.6-27B"), false);
});

test("virtual - cooldown yang sudah lewat dianggap tidak aktif", () => {
  resetVirtualCooldowns();
  setVirtualCooldown("ovh", "ovh/gpt-oss-20b", Date.now() - 1);
  assert.equal(isVirtualInCooldown("ovh", "ovh/gpt-oss-20b"), false);
});

test("virtual - strike model-level mencapai threshold lintas request, bukan dalam request yang sama", () => {
  resetAccountStrikes();
  // Failure berulang dalam satu request tidak dihitung sebagai percobaan terpisah.
  assert.equal(parkThresholdReached(virtual, { modelId: "m1", requestId: "r1" }), false);
  assert.equal(parkThresholdReached(virtual, { modelId: "m1", requestId: "r1" }), false);
  // Request kedua yang berbeda memenuhi threshold.
  assert.equal(parkThresholdReached(virtual, { modelId: "m1", requestId: "r2" }), true);
});

test("virtual - strike model-level tidak bocor ke model lain", () => {
  resetAccountStrikes();
  parkThresholdReached(virtual, { modelId: "m1", requestId: "r1" });
  assert.equal(parkThresholdReached(virtual, { modelId: "m2", requestId: "r2" }), false);
});

test("virtual - lock key provider-wide dan model-level terpisah", () => {
  assert.equal(virtualLockKey("ovh"), "virtual:ovh");
  assert.equal(virtualLockKey("ovh", "m1"), "virtual:ovh:model:m1");
});
