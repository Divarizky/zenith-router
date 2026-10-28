import test from "node:test";
import assert from "node:assert";
import { clientSession } from "../src/gateway/session.js";

const none = () => null;
const headers = (map) => (name) => map[name] ?? null;

test("clientSession - reports a session header as source header", () => {
  assert.deepStrictEqual(clientSession({ header: headers({ "x-session-id": "s-1" }) }), { key: "s-1", source: "header" });
});

test("clientSession - reports a prompt_cache_key as a body source that may seed the cache key", () => {
  const s = clientSession({ header: none, body: { prompt_cache_key: "pk-9" } });
  assert.strictEqual(s.source, "body");
  assert.strictEqual(s.promptCacheKey, true);
  assert.strictEqual(s.key, "pk-9");
});

test("clientSession - a user_id marker wins over prompt_cache_key and is not a cache key source", () => {
  const s = clientSession({ header: none, body: { metadata: { user_id: "u-1" }, prompt_cache_key: "pk-9" } });
  assert.strictEqual(s.key, "u-1");
  assert.strictEqual(s.promptCacheKey, false);
});

test("clientSession - the gateway key fallback is reported as apikey, never as a client source", () => {
  assert.deepStrictEqual(clientSession({ header: none, body: {}, apiKeyId: 7 }), { key: "apikey:7", source: "apikey" });
});

test("clientSession - no identity reports a null key and null source", () => {
  assert.deepStrictEqual(clientSession({ header: none, body: {} }), { key: null, source: null });
});
