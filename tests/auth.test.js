import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnectionById } from "../src/db/index.js";
import {
  getActiveConnection,
  markConnectionCooldown,
  isConnectionInCooldown,
  applyConnectionAuth,
} from "../src/services/auth.js";

test("auth service - returns virtual connection for noAuth provider only", () => {
  initDb(":memory:");

  const conn = getActiveConnection("opencode");
  assert.ok(conn, "Must return a virtual connection");
  assert.strictEqual(conn.auth_type, "noauth");
  assert.strictEqual(conn.provider, "opencode");

  const ovh = getActiveConnection("ovhcloud");
  assert.ok(ovh, "OVHcloud must return a virtual connection");
  assert.strictEqual(ovh.auth_type, "noauth");
  assert.strictEqual(ovh.provider, "ovhcloud");

  // Free tier but requires login: no virtual connection without a real account.
  assert.strictEqual(getActiveConnection("kiro"), null);
});

test("auth service - handles cloudflare accountId:apiToken split in applyConnectionAuth", () => {
  const h1 = applyConnectionAuth({}, {
    provider: "cloudflare-ai",
    auth_type: "apikey",
    credentials: { api_key: "acc123:tokenXYZ" },
  });
  assert.strictEqual(h1["Authorization"], "Bearer tokenXYZ");

  const h2 = applyConnectionAuth({}, {
    provider: "openrouter",
    auth_type: "apikey",
    credentials: { api_key: "sk-or-v1-abc" },
  });
  assert.strictEqual(h2["Authorization"], "Bearer sk-or-v1-abc");
});

test("auth service - always picks the #1 account, regardless of last use", () => {
  initDb(":memory:");

  const c1 = addConnection({
    provider: "glm",
    name: "Key 1",
    credentials: { api_key: "key-1" },
  });
  const c2 = addConnection({
    provider: "glm",
    name: "Key 2",
    credentials: { api_key: "key-2" },
  });

  const picked1 = getActiveConnection("glm");
  assert.ok(picked1);
  assert.strictEqual(picked1.id, c1.id);

  // Picking #1 stamps its last use; it must stay first anyway.
  const picked2 = getActiveConnection("glm");
  assert.ok(picked2);
  assert.strictEqual(picked2.id, c1.id);
  assert.ok(c2.id);
});

test("auth service - skips connection in cooldown", () => {
  initDb(":memory:");

  const c1 = addConnection({
    provider: "claude",
    name: "Account 1",
    credentials: { access_token: "tok-1" },
  });
  const c2 = addConnection({
    provider: "claude",
    name: "Account 2",
    credentials: { access_token: "tok-2" },
  });

  // Mark c1 as cooldown for 60 seconds
  markConnectionCooldown(c1.id, 60000);

  const picked = getActiveConnection("claude");
  assert.ok(picked);
  assert.strictEqual(picked.id, c2.id, "Must skip c1 and pick c2");

  // If both in cooldown, returns null
  markConnectionCooldown(c2.id, 60000);
  const pickedNone = getActiveConnection("claude");
  assert.strictEqual(pickedNone, null, "Must return null when all accounts in cooldown");
});

test("auth service - recovers after cooldown expires", () => {
  initDb(":memory:");

  const c1 = addConnection({
    provider: "github",
    name: "Copilot 1",
    credentials: { access_token: "copilot-tok" },
  });

  // Set cooldown in the past
  markConnectionCooldown(c1.id, -1000);

  const picked = getActiveConnection("github");
  assert.ok(picked);
  assert.strictEqual(picked.id, c1.id);
  assert.strictEqual(isConnectionInCooldown(picked), false);
});
