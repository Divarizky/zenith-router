import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnectionById, mergeConnectionCredentials } from "../src/db/index.js";
import {
  needsTokenRefresh,
  refreshOAuthToken,
  scanAndRefreshTokens,
  startTokenRefreshScheduler,
  stopTokenRefreshScheduler,
  setCustomTokenRefresher,
  setRefreshTimeoutMs,
} from "../src/services/tokenRefresh.js";
import { app } from "../src/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";
import { clearConsoleLogs, getConsoleLogs } from "../src/services/logger.js";

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

test("tokenRefresh - refresh keeps credentials written while it was in flight", async () => {
  initDb(":memory:");

  const conn = addConnection({
    provider: "claude",
    name: "Claude User",
    auth_type: "oauth",
    credentials: { access_token: "old", refresh_token: "keep-me", expires_at: Date.now() - 1000 },
  });

  setCustomTokenRefresher(async () => {
    // A quota sync finishes while the token endpoint is still answering.
    mergeConnectionCredentials(conn.id, { quota: { remaining: 7 } });
    return { access_token: "fresh", expires_at: Date.now() + 3600 * 1000 };
  });

  try {
    await refreshOAuthToken(conn);
  } finally {
    setCustomTokenRefresher(null);
  }

  const inDb = getConnectionById(conn.id);
  assert.strictEqual(inDb.credentials.access_token, "fresh");
  assert.strictEqual(inDb.credentials.refresh_token, "keep-me");
  assert.strictEqual(inDb.credentials.quota.remaining, 7);
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

test("tokenRefresh - background scheduler renews near-expiry accounts on its first pass", async () => {
  initDb(":memory:");

  addConnection({
    provider: "codex",
    name: "Scheduled Codex",
    auth_type: "oauth",
    credentials: {
      access_token: "old_scheduled",
      refresh_token: "ref_scheduled",
      expires_at: Date.now() + 60 * 1000, // 1 min left
    },
  });

  addConnection({
    provider: "codex",
    name: "Fresh Scheduled Codex",
    auth_type: "oauth",
    credentials: {
      access_token: "fresh_scheduled",
      refresh_token: "ref_scheduled2",
      expires_at: Date.now() + 3600 * 1000, // 1 hour left
    },
  });

  const refreshed = [];
  setCustomTokenRefresher(async (connection) => {
    refreshed.push(connection.name);
    return {
      access_token: `refreshed_${connection.name}`,
      refresh_token: "ref_updated",
      expires_at: Date.now() + 3600 * 1000,
    };
  });

  startTokenRefreshScheduler();
  await new Promise((resolve) => setTimeout(resolve, 100));
  stopTokenRefreshScheduler();

  assert.deepStrictEqual(refreshed, ["Scheduled Codex"], "the first background pass only renews the expiring account");

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

function freshOAuthConnection(provider = "antigravity") {
  return addConnection({
    provider,
    name: `${provider} OAuth`,
    auth_type: "oauth",
    credentials: {
      access_token: "still_valid",
      refresh_token: "ref_tok",
      expires_at: Date.now() + 3600 * 1000,
    },
  });
}

test("tokenRefresh - a refresh that turns out unnecessary does not stick, so a forced one still runs", async () => {
  initDb(":memory:");
  const conn = freshOAuthConnection();

  let executions = 0;
  setCustomTokenRefresher(async () => {
    executions++;
    return { access_token: `minted_${executions}`, expires_at: Date.now() + 3600 * 1000 };
  });

  try {
    // A caller holding a stale snapshot asks while the stored token is still fresh.
    const noop = await refreshOAuthToken(conn);
    assert.strictEqual(executions, 0);
    assert.strictEqual(noop.credentials.access_token, "still_valid");

    // Upstream then rejects the token: the forced refresh must reach the refresher.
    const forced = await refreshOAuthToken(getConnectionById(conn.id), { force: true });
    assert.strictEqual(executions, 1, "refresh paksa tidak boleh memakai hasil lama yang tertinggal");
    assert.strictEqual(forced.credentials.access_token, "minted_1");
    assert.strictEqual(getConnectionById(conn.id).credentials.access_token, "minted_1");
  } finally {
    setCustomTokenRefresher(null);
  }
});

test("tokenRefresh - after an unnecessary refresh, an expired token is renewed by a plain call", async () => {
  initDb(":memory:");
  const conn = freshOAuthConnection();

  let executions = 0;
  setCustomTokenRefresher(async () => {
    executions++;
    return { access_token: "renewed", expires_at: Date.now() + 3600 * 1000 };
  });

  try {
    await refreshOAuthToken(conn);
    mergeConnectionCredentials(conn.id, { expires_at: Date.now() - 1000 });

    const renewed = await refreshOAuthToken(getConnectionById(conn.id));
    assert.strictEqual(executions, 1);
    assert.strictEqual(renewed.credentials.access_token, "renewed");
  } finally {
    setCustomTokenRefresher(null);
  }
});

test("POST /v1/chat/completions - reactive 401 refreshes even after an earlier unnecessary refresh", async () => {
  initDb(":memory:");
  const conn = freshOAuthConnection("glm");

  let executions = 0;
  setCustomTokenRefresher(async () => {
    executions++;
    return { access_token: "reauthorized", expires_at: Date.now() + 3600 * 1000 };
  });

  const receivedAuth = [];
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.get?.("Authorization");
      receivedAuth.push(auth);
      if (auth !== "Bearer reauthorized") {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  try {
    // The quota sync / scheduler race: a no-op refresh before the request.
    await refreshOAuthToken(conn);

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(executions, 1, "refresh reaktif harus memanggil refresher");
    assert.deepStrictEqual(receivedAuth, ["Bearer still_valid", "Bearer reauthorized"]);
  } finally {
    setCustomExecutor(null);
    setCustomTokenRefresher(null);
  }
});

test("tokenRefresh - a token endpoint that never answers times out and frees the connection", async () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "antigravity",
    name: "Hanging Google",
    auth_type: "oauth",
    credentials: { access_token: "old", refresh_token: "ref_tok", expires_at: Date.now() - 1000 },
  });

  let calls = 0;
  setRefreshTimeoutMs(50);
  setOAuthFetch(async (url, init) => {
    calls++;
    if (calls === 1) {
      // Never answers; only the abort signal ends it.
      return new Promise((_, reject) => {
        // AbortSignal.timeout's own timer is unref'd, so nothing would keep the
        // event loop alive here (Node 22 then resolves the loop and kills the
        // still-pending promise). A referenced keep-alive timer stands in for the
        // real TCP socket and is cleared as soon as the abort arrives.
        const keepAlive = setTimeout(() => {}, 10000);
        init.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(init.signal.reason);
          },
          { once: true }
        );
      });
    }
    return new Response(JSON.stringify({ access_token: "after_timeout", expires_in: 3600 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  try {
    await assert.rejects(refreshOAuthToken(conn), /Google refresh timed out after 50ms/);

    // The timed-out attempt must not stay in flight for the next caller.
    const retried = await refreshOAuthToken(getConnectionById(conn.id));
    assert.strictEqual(calls, 2);
    assert.strictEqual(retried.credentials.access_token, "after_timeout");
  } finally {
    setOAuthFetch(null);
    setRefreshTimeoutMs(null);
  }
});

test("tokenRefresh - a successful refresh is logged with its new expiry", async () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "antigravity",
    name: "Logged",
    auth_type: "oauth",
    credentials: { access_token: "old", refresh_token: "ref_tok", expires_at: Date.now() - 1000 },
  });
  setCustomTokenRefresher(async () => ({ access_token: "new", expires_at: Date.now() + 3600 * 1000 }));
  clearConsoleLogs();

  try {
    await refreshOAuthToken(conn);
    const lines = getConsoleLogs().map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
    assert.ok(
      lines.some(
        (l) =>
          l.includes(`[zenith] Token antigravity #${conn.id} diperbarui, berlaku sampai `) && /sampai \d{2}:\d{2}$/.test(l)
      ),
      "refresh yang berhasil harus tercatat di Console Log"
    );
  } finally {
    setCustomTokenRefresher(null);
  }
});
