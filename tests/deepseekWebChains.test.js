import test from "node:test";
import assert from "node:assert";
import {
  buildChainKey,
  createChainStore,
  evaluateChain,
  messageFingerprint,
  resolveChainLimits,
  CHAIN_MAIN_IDLE_MS,
  CHAIN_TTL_MS,
  MAX_AUX_CHAINS,
} from "../src/services/deepseekWeb/chains.js";
import { initDb } from "../src/db/index.js";
import { setSetting, deleteSetting } from "../src/services/settings.js";
import { resetTrafficGuardState } from "../src/services/trafficGuard.js";

function clockedStore(start = 1_000_000) {
  let now = start;
  return {
    store: createChainStore({ now: () => now }),
    advance: (ms) => {
      now += ms;
    },
  };
}

const account = (id = 1, provider = "deepseek-web") => ({ id, provider, auth_type: "session" });
const LIMITS = { main: 3, aux: MAX_AUX_CHAINS };

function add(store, connection, purpose, sessionKey) {
  return store.register({ connection, purpose, sessionKey, limits: LIMITS });
}

const keysOf = (result) => result.evicted.map((chain) => chain.key);

test("chains - a key separates accounts, purposes, and client sessions", () => {
  const a = buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "client-a" });
  const b = buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "client-b" });
  const c = buildChainKey({ connectionId: 2, purpose: "main", sessionKey: "client-a" });
  const d = buildChainKey({ connectionId: 1, purpose: "aux", sessionKey: "client-a" });

  assert.notStrictEqual(a, b, "two clients never share a chain");
  assert.notStrictEqual(a, c, "two accounts never share a chain");
  assert.notStrictEqual(a, d, "a conversation and its session title never share a chain");
  assert.strictEqual(a, buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "client-a" }));
});

test("chains - limits follow the provider cap, then the global cap", () => {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("max_account_concurrency", "4");

  let limits = resolveChainLimits({ id: 1, provider: "unregistered-provider", auth_type: "session" });
  assert.deepStrictEqual(limits, { main: 4, aux: MAX_AUX_CHAINS }, "provider tanpa cap sendiri memakai cap global");

  limits = resolveChainLimits(account());
  assert.deepStrictEqual(limits, { main: 2, aux: MAX_AUX_CHAINS }, "deepseek-web memakai concurrency dari registry");

  setSetting("provider_concurrency:deepseek-web", "5");
  limits = resolveChainLimits(account());
  assert.deepStrictEqual(limits, { main: 5, aux: MAX_AUX_CHAINS }, "setting per provider menang atas registry");

  deleteSetting("provider_concurrency:deepseek-web");
  limits = resolveChainLimits(account());
  assert.strictEqual(limits.main, 2);
});

test("chains - a fourth main chain drops auxiliary chains first, then the least recently used conversation", () => {
  const { store, advance } = clockedStore();
  const conn = account();

  for (const sessionKey of ["m1", "m2", "m3"]) {
    add(store, conn, "main", sessionKey);
    advance(1);
  }
  add(store, conn, "aux", "title");
  advance(1);
  add(store, conn, "aux", "memory");
  advance(1);

  const result = add(store, conn, "main", "m4");
  assert.deepStrictEqual(keysOf(result), [
    buildChainKey({ connectionId: 1, purpose: "aux", sessionKey: "title" }),
    buildChainKey({ connectionId: 1, purpose: "aux", sessionKey: "memory" }),
    buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "m1" }),
  ]);
  assert.deepStrictEqual(store.stats(1), { main: 3, aux: 0, busy: 0, total: 3 });
  assert.strictEqual(result.overflow, false);
});

test("chains - a third auxiliary chain evicts only the oldest auxiliary one", () => {
  const { store, advance } = clockedStore();
  const conn = account();

  add(store, conn, "aux", "title");
  advance(1);
  add(store, conn, "aux", "memory");
  advance(1);

  const result = add(store, conn, "aux", "compaction");
  assert.deepStrictEqual(keysOf(result), [buildChainKey({ connectionId: 1, purpose: "aux", sessionKey: "title" })]);
  assert.deepStrictEqual(store.stats(1), { main: 0, aux: 2, busy: 0, total: 2 });
  assert.ok(store.get(buildChainKey({ connectionId: 1, purpose: "aux", sessionKey: "memory" })));
});

test("chains - a busy chain is never evicted, the pool overflows instead", () => {
  const { store } = clockedStore();
  const conn = account();

  for (const sessionKey of ["m1", "m2", "m3"]) {
    add(store, conn, "main", sessionKey);
    store.setBusy(buildChainKey({ connectionId: 1, purpose: "main", sessionKey }), true);
  }

  const result = add(store, conn, "main", "m4");
  assert.strictEqual(result.overflow, true, "nothing could be evicted while every chain streams");
  assert.deepStrictEqual(keysOf(result), []);
  assert.deepStrictEqual(store.stats(1), { main: 4, aux: 0, busy: 3, total: 4 });
});

test("chains - an expired chain is swept when the next one registers", () => {
  const { store, advance } = clockedStore();
  const conn = account();

  add(store, conn, "main", "stale");
  advance(CHAIN_TTL_MS + 1);
  const result = add(store, conn, "main", "fresh");

  assert.deepStrictEqual(keysOf(result), [buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "stale" })]);
  assert.strictEqual(store.stats(1).total, 1);
});

test("chains - a long-idle conversation is evicted before a recently used one", () => {
  const { store, advance } = clockedStore();
  const conn = account();

  add(store, conn, "main", "abandoned");
  advance(CHAIN_MAIN_IDLE_MS + 1);
  add(store, conn, "main", "active-1");
  advance(1);
  add(store, conn, "main", "active-2");
  advance(1);

  const result = add(store, conn, "main", "newcomer");
  assert.deepStrictEqual(keysOf(result), [
    buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "abandoned" }),
  ]);
});

test("chains - touching a chain protects it from eviction", () => {
  const { store, advance } = clockedStore();
  const conn = account();

  for (const sessionKey of ["m1", "m2", "m3"]) {
    add(store, conn, "main", sessionKey);
    advance(1);
  }
  advance(CHAIN_MAIN_IDLE_MS + 1);
  // m1 is used again, so m2 becomes the oldest conversation.
  store.touch(buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "m1" }), { count: 4 });

  const result = add(store, conn, "main", "m4");
  assert.deepStrictEqual(keysOf(result), [buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "m2" })]);
  assert.strictEqual(store.get(buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "m1" })).count, 4);
});

test("chains - sweep and reset clear idle state", () => {
  const { store, advance } = clockedStore();
  const conn = account();

  add(store, conn, "aux", "title");
  advance(CHAIN_TTL_MS + 1);
  assert.strictEqual(store.sweep().length, 1);
  assert.strictEqual(store.stats(1).total, 0);

  add(store, conn, "main", "m1");
  store.reset();
  assert.strictEqual(store.stats(1).total, 0);
  assert.strictEqual(store.get(buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "m1" })), null);
});

const message = (role, content) => ({ role, content });

function anchoredChain(history) {
  return { count: history.length, fingerprint: messageFingerprint(history[history.length - 1]), dirty: false };
}

test("watermark - a new chain renders the whole history", () => {
  const history = [message("system", "rules"), message("user", "hi")];
  const result = evaluateChain(null, history);

  assert.strictEqual(result.action, "reset");
  assert.strictEqual(result.reason, "new_chain");
  assert.deepStrictEqual(result.delta, history);
  assert.strictEqual(result.count, 2);
});

test("watermark - a matching anchor forwards only the new messages", () => {
  const history = [message("user", "one"), message("assistant", "two")];
  const next = [...history, message("user", "three")];
  const result = evaluateChain(anchoredChain(history), next);

  assert.strictEqual(result.action, "continue");
  assert.deepStrictEqual(result.delta.map((m) => m.content), ["three"]);
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.fingerprint, messageFingerprint(next[2]));
});

test("watermark - a shrunken or edited history resets the chain", () => {
  const history = [message("user", "one"), message("assistant", "two")];
  const chain = anchoredChain(history);

  assert.strictEqual(evaluateChain(chain, [message("user", "one")]).reason, "history_shrank");
  assert.strictEqual(
    evaluateChain(chain, [message("user", "one"), message("assistant", "edited")]).reason,
    "diverged"
  );
});

test("watermark - a dirty chain or an identical history resets", () => {
  const history = [message("user", "one")];
  assert.strictEqual(evaluateChain({ ...anchoredChain(history), dirty: true }, history).reason, "dirty");
  assert.strictEqual(evaluateChain(anchoredChain(history), history).reason, "no_new_messages");
});

test("watermark - the fingerprint ignores volatile fields but not content", () => {
  const plain = { role: "user", content: "hello" };
  const withMarker = { role: "user", content: "hello", cache_control: { type: "ephemeral" } };
  assert.strictEqual(messageFingerprint(plain), messageFingerprint(withMarker));
  assert.notStrictEqual(messageFingerprint(plain), messageFingerprint({ role: "user", content: "hello!" }));
  assert.notStrictEqual(messageFingerprint(plain), messageFingerprint({ role: "assistant", content: "hello" }));

  const call = { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] };
  const sameCall = { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "bash", arguments: "{}" } }] };
  assert.notStrictEqual(messageFingerprint(call), messageFingerprint({ ...call, tool_calls: [] }));
  assert.ok(typeof messageFingerprint(sameCall) === "string");
});

test("watermark - markTurn records the anchor and markDirty flags the chain", () => {
  const { store } = clockedStore();
  const conn = account();
  const first = message("user", "one");
  const key = buildChainKey({ connectionId: 1, purpose: "main", sessionKey: "s" });

  store.register({ connection: conn, sessionKey: "s", limits: LIMITS, count: 1, fingerprint: messageFingerprint(first) });
  store.markDirty(key);
  assert.strictEqual(store.get(key).dirty, true);

  store.markTurn(key, { count: 2, fingerprint: "abc", chatSessionId: "chat-1", parentMessageId: "msg-9" });
  const chain = store.get(key);
  assert.strictEqual(chain.dirty, false);
  assert.strictEqual(chain.count, 2);
  assert.strictEqual(chain.chatSessionId, "chat-1");
  assert.strictEqual(chain.parentMessageId, "msg-9");
});

test("single-flight - turns on one chain run one at a time", async () => {
  const { store } = clockedStore();
  const key = "chain-a";
  const order = [];
  let active = 0;
  let maxActive = 0;

  const turn = (label, ms) =>
    store.withLock(key, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(label);
      await new Promise((resolve) => setTimeout(resolve, ms));
      active--;
      return label;
    });

  const results = await Promise.all([turn("a", 10), turn("b", 1), turn("c", 1)]);
  assert.deepStrictEqual(order, ["a", "b", "c"]);
  assert.strictEqual(maxActive, 1, "a chain never runs two turns at once");
  assert.deepStrictEqual(results, ["a", "b", "c"]);
  // Lock bookkeeping settles on its own microtask after the turn resolves.
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(store.lockCount(), 0, "the lock tail is cleaned up");
});

test("single-flight - a failed turn does not block the next one", async () => {
  const { store } = clockedStore();
  const key = "chain-b";

  const failed = store.withLock(key, async () => {
    throw new Error("boom");
  });
  const after = store.withLock(key, async () => "ok");

  await assert.rejects(failed, /boom/);
  assert.strictEqual(await after, "ok");
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(store.lockCount(), 0);
});

test("single-flight - different chains still run in parallel", async () => {
  const { store } = clockedStore();
  let active = 0;
  let maxActive = 0;

  const turn = (key) =>
    store.withLock(key, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    });

  await Promise.all([turn("chain-c"), turn("chain-d")]);
  assert.strictEqual(maxActive, 2, "separate conversations are not serialized together");
});

test("chains - a changed tool catalog starts a fresh chat, reordering does not", () => {
  const msgs = [
    { role: "user", content: "satu" },
    { role: "assistant", content: "dua" },
  ];
  const toolA = { type: "function", function: { name: "Bash", description: "run", parameters: { type: "object" } } };
  const toolB = { type: "function", function: { name: "Read", description: "read", parameters: { type: "object" } } };

  const first = evaluateChain(null, msgs, [toolA, toolB]);
  const chain = { count: msgs.length, fingerprint: first.fingerprint, dirty: false, toolsFingerprint: first.toolsFingerprint };

  const same = evaluateChain(chain, [...msgs, { role: "user", content: "tiga" }], [toolB, toolA]);
  assert.strictEqual(same.action, "continue", "same tools in another order keep the chat");

  const changed = evaluateChain(chain, [...msgs, { role: "user", content: "tiga" }], [toolA]);
  assert.strictEqual(changed.action, "reset");
  assert.strictEqual(changed.reason, "tools_changed");
});
