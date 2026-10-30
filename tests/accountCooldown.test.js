import test from "node:test";
import assert from "node:assert";
import { ACCOUNT_PARK_MS, clearStrikes, parkThresholdReached, resetAccountStrikes } from "../src/services/accountCooldown.js";

const conn = { id: 7, provider: "glm", name: "GLM" };

test("park - the first failure parks nothing", () => {
  resetAccountStrikes();
  assert.strictEqual(parkThresholdReached(conn, { requestId: "r1" }), false);
});

test("park - the second separate request parks the account", () => {
  resetAccountStrikes();
  parkThresholdReached(conn, { requestId: "r1" });
  assert.strictEqual(parkThresholdReached(conn, { requestId: "r2" }), true);
});

test("park - failures inside one client request count once", () => {
  resetAccountStrikes();
  for (const id of ["r1", "r1", "r1"]) {
    assert.strictEqual(parkThresholdReached(conn, { requestId: id }), false, `attempt ${id} tidak memarkir`);
  }
  assert.strictEqual(parkThresholdReached(conn, { requestId: "r2" }), true, "percobaan klien kedua memarkir");
});

test("park - a success clears so sporadic failures never accumulate", () => {
  resetAccountStrikes();
  parkThresholdReached(conn, { requestId: "r1" });
  clearStrikes(conn, "glm-4-flash");
  assert.strictEqual(parkThresholdReached(conn, { requestId: "r2" }), false, "streak hilang, counter mulai lagi");
});

test("park - the park duration stays ten minutes", () => {
  resetAccountStrikes();
  assert.strictEqual(ACCOUNT_PARK_MS, 10 * 60 * 1000, "durasi parkir tetap 10 menit");
});

test("park - a model lock and the account lock are separate budgets", () => {
  resetAccountStrikes();
  parkThresholdReached(conn, { modelId: "glm-4-flash", requestId: "r1" });
  assert.strictEqual(parkThresholdReached(conn, { requestId: "r1" }), false, "limit per model tidak memparkir akun");
  parkThresholdReached(conn, { requestId: "r2" });
  assert.strictEqual(parkThresholdReached(conn, { requestId: "r3" }), true, "akun punya hitungannya sendiri");
});

test("park - a connection without an id (virtual free tier) is never parked", () => {
  resetAccountStrikes();
  const virtual = { id: null, provider: "ollama", name: "Ollama (Virtual Free)" };
  assert.strictEqual(parkThresholdReached(virtual, { requestId: "r1" }), false);
  assert.strictEqual(parkThresholdReached(virtual, { requestId: "r2" }), false);
});
