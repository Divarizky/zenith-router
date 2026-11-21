import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getConnections, getDb, setConnectionCooldown } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { resetTrafficGuardState } from "../src/services/trafficGuard.js";
import { createSessionPinStore, SESSION_PIN_TTL_MS } from "../src/services/sessionPin.js";

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

test("sessionPin store returns the pinned account only for the same provider and session", () => {
  const store = createSessionPinStore({ now: clock().now });
  store.set("glm", "sess-a", 7, "glm-4-flash");
  assert.strictEqual(store.get("glm", "sess-a", "glm-4-flash"), 7);
  assert.strictEqual(store.get("glm", "sess-b", "glm-4-flash"), null, "sesi lain tidak ikut pin");
  assert.strictEqual(store.get("other", "sess-a", "glm-4-flash"), null, "provider lain tidak ikut pin");
});

test("sessionPin store forgets a pin after its TTL of inactivity", () => {
  const c = clock();
  const store = createSessionPinStore({ now: c.now, ttlMs: SESSION_PIN_TTL_MS });
  store.set("glm", "sess-a", 7, "m");
  c.advance(SESSION_PIN_TTL_MS - 1);
  assert.strictEqual(store.get("glm", "sess-a", "m"), 7, "masih berlaku sebelum TTL");
  c.advance(2);
  assert.strictEqual(store.get("glm", "sess-a", "m"), null, "kedaluwarsa setelah TTL");
});

test("sessionPin store refreshes the TTL on each successful use", () => {
  const c = clock();
  const store = createSessionPinStore({ now: c.now, ttlMs: 1000 });
  store.set("glm", "sess-a", 7, "m");
  c.advance(800);
  store.set("glm", "sess-a", 7, "m");
  c.advance(800);
  assert.strictEqual(store.get("glm", "sess-a", "m"), 7, "TTL dihitung dari pemakaian terakhir");
});

test("sessionPin store evicts the least recently used session beyond its cap", () => {
  const store = createSessionPinStore({ now: clock().now, maxSessions: 2 });
  store.set("glm", "s1", 1, "m");
  store.set("glm", "s2", 2, "m");
  store.set("glm", "s3", 3, "m");
  assert.strictEqual(store.size(), 2);
  assert.strictEqual(store.get("glm", "s1", "m"), null, "entri tertua dibuang");
  assert.strictEqual(store.get("glm", "s3", "m"), 3);
});

test("sessionPin store drops every pin that points at a deleted connection", () => {
  const store = createSessionPinStore({ now: clock().now });
  store.set("glm", "s1", 1, "m");
  store.set("glm", "s2", 2, "m");
  store.dropConnection(1);
  assert.strictEqual(store.get("glm", "s1", "m"), null);
  assert.strictEqual(store.get("glm", "s2", "m"), 2);
});

test("sessionPin store ignores a missing session key", () => {
  const store = createSessionPinStore({ now: clock().now });
  store.set("glm", null, 7, "m");
  assert.strictEqual(store.size(), 0);
  assert.strictEqual(store.get("glm", null, "m"), null);
});

function gatewayChat(sessionId) {
  const headers = { "Content-Type": "application/json" };
  if (sessionId) headers["x-session-id"] = sessionId;
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
  });
}

function recordingExecutor(attempts) {
  return {
    async execute({ headers }) {
      attempts.push(headers.Authorization || headers.authorization);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

test("Session affinity - turns with the same session header reuse the account of turn one", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  const first = addConnection({ provider: "glm", name: "GLM Pin 1", credentials: { api_key: "key-1" } });
  addConnection({ provider: "glm", name: "GLM Pin 2", credentials: { api_key: "key-2" } });

  const attempts = [];
  setCustomExecutor(recordingExecutor(attempts));
  try {
    // Turn 1: the first account is parked, so the session lands on the second one and is pinned there.
    setConnectionCooldown(first.id, Date.now() + 5 * 60 * 1000);
    assert.strictEqual((await gatewayChat("affinity-sess-A")).status, 200);
    assert.deepStrictEqual(attempts, ["Bearer key-2"]);

    // The first account recovers. Without a pin, priority order would send turn 2 back to it.
    // Test setup only: an account lock never shortens in production, so recovery is simulated directly.
    getDb().prepare("UPDATE connections SET cooldown_until = 0 WHERE id = ?").run(first.id);
    attempts.length = 0;
    assert.strictEqual((await gatewayChat("affinity-sess-A")).status, 200);
    assert.deepStrictEqual(attempts, ["Bearer key-2"], "turn kedua tetap di akun pin");
  } finally {
    setCustomExecutor(null);
  }
});

test("Session affinity - turns with the same session header reuse the same account", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  addConnection({ provider: "glm", name: "GLM Pin 1", credentials: { api_key: "key-1" } });
  addConnection({ provider: "glm", name: "GLM Pin 2", credentials: { api_key: "key-2" } });

  const attempts = [];
  setCustomExecutor(recordingExecutor(attempts));
  try {
    assert.strictEqual((await gatewayChat("affinity-sess-A")).status, 200);
    assert.strictEqual((await gatewayChat("affinity-sess-A")).status, 200);
    assert.strictEqual((await gatewayChat("affinity-sess-A")).status, 200);
    assert.strictEqual(attempts.length, 3);
    assert.strictEqual(new Set(attempts).size, 1, `turn sesi yang sama harus memakai akun yang sama: ${attempts}`);
  } finally {
    setCustomExecutor(null);
  }
});

test("Session affinity - a pinned account in cooldown hops to a sibling instead of sticking", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  addConnection({ provider: "glm", name: "GLM Hop 1", credentials: { api_key: "key-1" } });
  addConnection({ provider: "glm", name: "GLM Hop 2", credentials: { api_key: "key-2" } });

  const attempts = [];
  setCustomExecutor(recordingExecutor(attempts));
  try {
    assert.strictEqual((await gatewayChat("hop-sess-B")).status, 200);
    const pinnedAuth = attempts[0];
    const pinnedConn = getConnections("glm").find((c) => `Bearer ${c.credentials.api_key}` === pinnedAuth);
    setConnectionCooldown(pinnedConn.id, Date.now() + 5 * 60 * 1000);

    attempts.length = 0;
    assert.strictEqual((await gatewayChat("hop-sess-B")).status, 200);
    assert.strictEqual(attempts.length, 1);
    assert.notStrictEqual(attempts[0], pinnedAuth, "akun pin yang sedang cooldown tidak boleh dipakai ulang");
  } finally {
    setCustomExecutor(null);
  }
});

test("sessionPin TTL follows the runtime setting and falls back to 15 minutes", async () => {
  const { setSetting } = await import("../src/services/settings.js");
  const { sessionPinTtlFromSettings, SESSION_PIN_TTL_SETTING } = await import("../src/services/sessionPin.js");
  setSetting(SESSION_PIN_TTL_SETTING, "5");
  assert.strictEqual(sessionPinTtlFromSettings(), 5 * 60 * 1000);
  setSetting(SESSION_PIN_TTL_SETTING, "");
  assert.strictEqual(sessionPinTtlFromSettings(), SESSION_PIN_TTL_MS);
  setSetting(SESSION_PIN_TTL_SETTING, "-3");
  assert.strictEqual(sessionPinTtlFromSettings(), SESSION_PIN_TTL_MS);
  setSetting(SESSION_PIN_TTL_SETTING, "999999");
  assert.strictEqual(sessionPinTtlFromSettings(), 1440 * 60 * 1000, "clamped to 24 hours");
});

test("sessionPin store applies a TTL that is read at call time", () => {
  const c = clock();
  let ttl = 60_000;
  const store = createSessionPinStore({ ttlMs: () => ttl, now: c.now });
  store.set("glm", "sess-ttl", 3, "m");
  ttl = 10_000;
  c.advance(20_000);
  assert.strictEqual(store.get("glm", "sess-ttl", "m"), null, "a shorter TTL applies to an existing pin");
});

test("sessionPin client and apikey namespaces never share an entry", () => {
  const store = createSessionPinStore({ now: clock().now });
  store.set("glm", "same-id", 4, "m", "client");
  assert.strictEqual(store.get("glm", "same-id", "m", "apikey"), null, "a gateway key scope does not read a client pin");
  assert.strictEqual(store.get("glm", "same-id", "m", "client"), 4);
});
