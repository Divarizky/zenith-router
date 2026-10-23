import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { normalizeSessionToken } from "../src/services/deepseekWeb/token.js";
import { applyConnectionAuth } from "../src/services/auth.js";

test("session token - a plain token is left alone", () => {
  assert.strictEqual(normalizeSessionToken("eyJhbGciOiJIUzI1NiJ9.payload.sig"), "eyJhbGciOiJIUzI1NiJ9.payload.sig");
  assert.strictEqual(normalizeSessionToken("  spaced-token  "), "spaced-token");
});

test("session token - the localStorage wrapper is unwrapped", () => {
  // Application -> Local Storage -> userToken on chat.deepseek.com.
  assert.strictEqual(normalizeSessionToken('{"value":"eyJabc123","__version":"0"}'), "eyJabc123");
  assert.strictEqual(normalizeSessionToken('{"token":"eyJother"}'), "eyJother");
});

test("session token - a pasted header or quoted value is cleaned", () => {
  assert.strictEqual(normalizeSessionToken("Bearer eyJabc123"), "eyJabc123");
  assert.strictEqual(normalizeSessionToken("bearer   eyJabc123"), "eyJabc123");
  assert.strictEqual(normalizeSessionToken('"eyJabc123"'), "eyJabc123");
  assert.strictEqual(normalizeSessionToken("'eyJabc123'"), "eyJabc123");
});

test("session token - SPA placeholders never become a token", () => {
  // The web app writes the wrapper before a session exists; accepting it used to
  // save an account and close the login browser immediately.
  assert.strictEqual(normalizeSessionToken('{"value":"undefined","__version":"0"}'), "");
  assert.strictEqual(normalizeSessionToken('{"value":"null","__version":"0"}'), "");
  assert.strictEqual(normalizeSessionToken("undefined"), "");
  assert.strictEqual(normalizeSessionToken("null"), "");
  assert.strictEqual(normalizeSessionToken("Bearer undefined"), "");
  assert.strictEqual(normalizeSessionToken('""'), "");
});

test("session token - empty or malformed input yields an empty string", () => {
  assert.strictEqual(normalizeSessionToken(""), "");
  assert.strictEqual(normalizeSessionToken("   "), "");
  assert.strictEqual(normalizeSessionToken(undefined), "");
  assert.strictEqual(normalizeSessionToken(null), "");
  assert.strictEqual(normalizeSessionToken({ token: "eyJ" }), "");
  // A broken wrapper must not be sent as-is either.
  assert.strictEqual(normalizeSessionToken('{"__version":"0"}'), '{"__version":"0"}');
});

test("session auth - a wrapped token still produces a clean Bearer header", () => {
  initDb(":memory:");
  const headers = applyConnectionAuth(
    {},
    {
      provider: "deepseek-web",
      auth_type: "session",
      credentials: { token: '{"value":"eyJreal","__version":"0"}', cookies: "intercom-id=1; ds_session_id=2" },
    }
  );
  assert.strictEqual(headers.Authorization, "Bearer eyJreal");
  assert.strictEqual(headers.Cookie, "intercom-id=1; ds_session_id=2");
});
