import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnectionById } from "../src/db/index.js";
import { canRefresh, needsTokenRefresh, refreshOAuthToken } from "../src/services/tokenRefresh.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";

test("github copilot token exchange refreshes copilot token from github token", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "github",
    name: "Copilot Test",
    auth_type: "oauth",
    credentials: {
      github_token: "gho_test_123",
      access_token: "stale_copilot_token",
      expires_at: Date.now() - 1000,
    },
  });

  assert.strictEqual(canRefresh(conn), true);
  assert.strictEqual(needsTokenRefresh(conn), true);

  setOAuthFetch(async (url, init) => {
    if (url.includes("/copilot_internal/v2/token")) {
      assert.strictEqual(init.headers.Authorization, "token gho_test_123");
      return new Response(
        JSON.stringify({
          token: "tid=fresh_copilot_token;exp=9999999999;sku=copilot_enterprise",
          expires_at: 9999999999,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 404 });
  });

  try {
    const refreshed = await refreshOAuthToken(conn);
    assert.ok(refreshed);

    const updated = getConnectionById(conn.id);
    assert.strictEqual(updated.credentials.access_token, "tid=fresh_copilot_token;exp=9999999999;sku=copilot_enterprise");
    assert.strictEqual(updated.credentials.github_token, "gho_test_123");
  } finally {
    setOAuthFetch(null);
  }
});
