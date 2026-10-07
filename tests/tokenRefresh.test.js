import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnectionById } from "../src/db/index.js";
import {
  needsTokenRefresh,
  refreshOAuthToken,
  scanAndRefreshTokens,
  setCustomTokenRefresher,
} from "../src/services/tokenRefresh.js";
import { app } from "../src/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

test("tokenRefresh - needsTokenRefresh detects expired or near-expiry token", () => {
  const notExpired = {
    auth_type: "oauth",
    credentials: {
      access_token: "valid",
      refresh_token: "ref",
      expires_at: Date.now() + 10 * 60 * 1000, // 10 min left
    },
  };
  assert.strictEqual(needsTokenRefresh(notExpired), false);

  const nearExpiry = {
    auth_type: "oauth",
    credentials: {
      access_token: "valid",
      refresh_token: "ref",
      expires_at: Date.now() + 2 * 60 * 1000, // 2 min left (< 5 min)
    },
  };
  assert.strictEqual(needsTokenRefresh(nearExpiry), true);

  const expired = {
    auth_type: "oauth",
    credentials: {
      access_token: "expired",
      refresh_token: "ref",
      expires_at: Date.now() - 1000, // already expired
    },
  };
  assert.strictEqual(needsTokenRefresh(expired), true);

  const apiKeyConn = {
    auth_type: "apikey",
    credentials: { api_key: "key" },
  };
  assert.strictEqual(needsTokenRefresh(apiKeyConn), false);
});

test("tokenRefresh - refreshOAuthToken updates SQLite with new token", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "claude",
    name: "Claude User",
    auth_type: "oauth",
    credentials: {
      access_token: "old_access_token",
      refresh_token: "test_refresh_token",
      expires_at: Date.now() - 10000,
    },
  });

  // Setup mock refresher
  setCustomTokenRefresher(async (connection) => {
    return {
      access_token: "newly_minted_access_token",
      refresh_token: "new_refresh_token",
      expires_at: Date.now() + 3600 * 1000,
    };
  });

  const refreshed = await refreshOAuthToken(conn);
  assert.ok(refreshed);
  assert.strictEqual(refreshed.credentials.access_token, "newly_minted_access_token");
  assert.strictEqual(refreshed.credentials.refresh_token, "new_refresh_token");

  // Verify persistence in SQLite
  const inDb = getConnectionById(conn.id);
  assert.strictEqual(inDb.credentials.access_token, "newly_minted_access_token");

  setCustomTokenRefresher(null);
});

test("tokenRefresh - scanAndRefreshTokens renews all near-expiry accounts", async () => {
  initDb(":memory:");

  addConnection({
    provider: "codex",
    name: "Expiring Codex",
    auth_type: "oauth",
    credentials: {
      access_token: "old_cx",
      refresh_token: "ref_cx",
      expires_at: Date.now() + 60 * 1000, // 1 min left
    },
  });

  addConnection({
    provider: "codex",
    name: "Fresh Codex",
    auth_type: "oauth",
    credentials: {
      access_token: "fresh_cx",
      refresh_token: "ref_cx2",
      expires_at: Date.now() + 3600 * 1000, // 1 hour left
    },
  });

  setCustomTokenRefresher(async (connection) => {
    return {
      access_token: `refreshed_${connection.name}`,
      refresh_token: "ref_updated",
      expires_at: Date.now() + 3600 * 1000,
    };
  });

  const count = await scanAndRefreshTokens();
  assert.strictEqual(count, 1, "Only the expiring account should be refreshed");

  setCustomTokenRefresher(null);
});

test("POST /v1/chat/completions - reactive 401 triggers token refresh and retries", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "glm",
    name: "GLM OAuth",
    auth_type: "oauth",
    credentials: {
      access_token: "stale_token",
      refresh_token: "valid_refresh",
      expires_at: Date.now() + 3600 * 1000,
    },
  });

  let refreshCalled = false;
  setCustomTokenRefresher(async (connection) => {
    refreshCalled = true;
    return {
      access_token: "fresh_reauthorized_token",
      refresh_token: "valid_refresh",
      expires_at: Date.now() + 3600 * 1000,
    };
  });

  let callCount = 0;
  let receivedAuth = [];

  const mockExecutor = {
    async execute({ headers }) {
      callCount++;
      const auth = headers.Authorization || headers.get?.("Authorization");
      receivedAuth.push(auth);

      if (callCount === 1) {
        // First call fails with 401 Unauthorized
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Second call succeeds
      return new Response(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "Retry success!" } }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    },
  };
  setCustomExecutor(mockExecutor);

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm/glm-4-flash",
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(callCount, 2, "Must retry once after 401");
  assert.strictEqual(refreshCalled, true, "Refresher must have been invoked");
  assert.strictEqual(receivedAuth[0], "Bearer stale_token");
  assert.strictEqual(receivedAuth[1], "Bearer fresh_reauthorized_token");

  setCustomExecutor(null);
  setCustomTokenRefresher(null);
});

test("tokenRefresh - concurrent calls for the same expiring connection share single refresh promise", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "claude",
    name: "Concurrent Claude",
    auth_type: "oauth",
    credentials: {
      access_token: "old_tok",
      refresh_token: "ref_tok",
      expires_at: Date.now() - 5000,
    },
  });

  let executions = 0;
  setCustomTokenRefresher(async (connection) => {
    executions++;
    await new Promise((r) => setTimeout(r, 40));
    return {
      access_token: "single_fresh_token",
      refresh_token: "single_fresh_refresh",
      expires_at: Date.now() + 3600 * 1000,
    };
  });

  const results = await Promise.all([
    refreshOAuthToken(conn),
    refreshOAuthToken(conn),
    refreshOAuthToken(conn),
    refreshOAuthToken(conn),
    refreshOAuthToken(conn),
  ]);

  assert.strictEqual(executions, 1, "Must only invoke underlying refresher once for concurrent calls");
  for (const res of results) {
    assert.strictEqual(res.credentials.access_token, "single_fresh_token");
  }

  // After completion, another call when token is already valid re-checks DB and does not re-refresh
  const subsequent = await refreshOAuthToken(conn);
  assert.strictEqual(executions, 1, "Subsequent call must not re-refresh when DB already has fresh token");
  assert.strictEqual(subsequent.credentials.access_token, "single_fresh_token");

  setCustomTokenRefresher(null);
});
