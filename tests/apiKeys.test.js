import test from "node:test";
import assert from "node:assert";
import { initDb, getDb } from "../src/db/index.js";
import {
  createApiKey,
  listApiKeys,
  countActiveApiKeys,
  setApiKeyActive,
  deleteApiKey,
  verifyApiKey,
  hashApiKey,
  extractClientApiKey,
} from "../src/services/apiKeys.js";

test("apiKeys - createApiKey returns plaintext once and stores only the hash", () => {
  initDb(":memory:");

  const created = createApiKey("Claude Code laptop");
  assert.match(created.key, /^zr_[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(created.key_prefix, created.key.slice(0, 10));

  const row = getDb().prepare("SELECT * FROM api_keys WHERE id = ?").get(created.id);
  assert.strictEqual(row.key_hash, hashApiKey(created.key));
  assert.ok(!Object.values(row).includes(created.key), "Plaintext key must not be stored");

  const listed = listApiKeys();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].key_hash, undefined, "Listing must not expose hashes");
  assert.strictEqual(listed[0].name, "Claude Code laptop");
});

test("apiKeys - createApiKey rejects an empty name", () => {
  initDb(":memory:");
  assert.throws(() => createApiKey("   "), /name is required/);
});

test("apiKeys - generated keys are unique", () => {
  initDb(":memory:");
  const keys = new Set(Array.from({ length: 20 }, (_, i) => createApiKey(`k${i}`).key));
  assert.strictEqual(keys.size, 20);
});

test("apiKeys - verifyApiKey accepts active keys and records last use", () => {
  initDb(":memory:");
  const created = createApiKey("Pi");

  const verified = verifyApiKey(created.key);
  assert.deepStrictEqual(verified, { id: created.id, name: "Pi" });
  assert.ok(listApiKeys()[0].last_used_at > 0);

  assert.strictEqual(verifyApiKey("zr_wrong"), null);
  assert.strictEqual(verifyApiKey("sk-not-ours"), null);
  assert.strictEqual(verifyApiKey(""), null);
});

test("apiKeys - disabled and deleted keys are rejected", () => {
  initDb(":memory:");
  const a = createApiKey("A");
  const b = createApiKey("B");
  assert.strictEqual(countActiveApiKeys(), 2);

  setApiKeyActive(a.id, false);
  assert.strictEqual(verifyApiKey(a.key), null);
  assert.strictEqual(countActiveApiKeys(), 1);

  setApiKeyActive(a.id, true);
  assert.ok(verifyApiKey(a.key));

  assert.strictEqual(deleteApiKey(b.id), true);
  assert.strictEqual(verifyApiKey(b.key), null);
});

test("apiKeys - extractClientApiKey reads Bearer or x-api-key", () => {
  assert.strictEqual(extractClientApiKey(new Headers({ Authorization: "Bearer zr_abc" })), "zr_abc");
  assert.strictEqual(extractClientApiKey(new Headers({ "x-api-key": "zr_def" })), "zr_def");
  assert.strictEqual(extractClientApiKey(new Headers()), null);
});
