import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { addConnection, getConnections, initDb } from "../src/db/index.js";
import { forgetSessionHealth, getSessionHealth } from "../src/services/deepseekWeb/health.js";
import { resetDeepSeekTransportFactory, setDeepSeekTransportFactory } from "../src/services/deepseekWeb/transport.js";

function seed(token = "tok_abc") {
  initDb(":memory:");
  forgetSessionHealth();
  addConnection({
    provider: "deepseek-web",
    name: "Web",
    auth_type: "session",
    credentials: { token, cookies: "a=1" },
  });
  return getConnections("deepseek-web")[0];
}

/** Health checks only ever need the challenge call; anything else would throw. */
function fakeChallenge({ fail = null } = {}) {
  const state = { calls: 0 };
  setDeepSeekTransportFactory(() => ({
    async fetchChallenge() {
      state.calls += 1;
      if (fail) throw fail;
      return { challenge: "fixture" };
    },
  }));
  return state;
}

const expiredError = () =>
  Object.assign(new Error("DeepSeek Web session rejected: Unauthorized"), {
    status: 401,
    code: "invalid_token",
    authExpired: true,
  });

test("dashboard - opening the detail page checks the session and shows the verdict", async () => {
  const connection = seed();
  const state = fakeChallenge();

  try {
    const html = await (await app.request("/dashboard/providers/deepseek-web")).text();

    assert.ok(html.includes("<th>Sesi</th>"), "session providers get their own column");
    assert.ok(html.includes("Sesi OK"));
    assert.ok(html.includes("Periksa sesi"));
    assert.ok(html.includes("Perbarui sesi"));
    assert.strictEqual(state.calls, 1);
    assert.strictEqual(getSessionHealth(connection).status, "ok");

    await (await app.request("/dashboard/providers/deepseek-web")).text();
    assert.strictEqual(state.calls, 1, "the cached verdict is reused on the next visit");
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("dashboard - an expired token is shown as expired", async () => {
  seed();
  fakeChallenge({ fail: expiredError() });

  try {
    const html = await (await app.request("/dashboard/providers/deepseek-web")).text();
    assert.ok(html.includes("Sesi kedaluwarsa"));
    assert.ok(!html.includes("Sesi OK"));
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("dashboard - Periksa sesi forces a probe and reports the result", async () => {
  const connection = seed();
  const state = fakeChallenge();

  try {
    const res = await app.request("/dashboard/providers/accounts/check-session", {
      method: "POST",
      body: new URLSearchParams({ id: String(connection.id), provider: "deepseek-web" }),
    });

    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/dashboard/providers/deepseek-web?notice=session_ok");
    assert.strictEqual(state.calls, 1);

    await app.request("/dashboard/providers/accounts/check-session", {
      method: "POST",
      body: new URLSearchParams({ id: String(connection.id), provider: "deepseek-web" }),
    });
    assert.strictEqual(state.calls, 2, "the button ignores the cache");
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("dashboard - Periksa sesi on a dead token redirects with session_expired", async () => {
  const connection = seed();
  fakeChallenge({ fail: expiredError() });

  try {
    const res = await app.request("/dashboard/providers/accounts/check-session", {
      method: "POST",
      body: new URLSearchParams({ id: String(connection.id), provider: "deepseek-web" }),
    });

    assert.strictEqual(res.headers.get("location"), "/dashboard/providers/deepseek-web?notice=session_expired");
    assert.strictEqual(getSessionHealth(connection).status, "expired");
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("dashboard - Perbarui sesi stores the new token and drops the old verdict", async () => {
  const connection = seed();
  fakeChallenge();

  try {
    await app.request("/dashboard/providers/accounts/check-session", {
      method: "POST",
      body: new URLSearchParams({ id: String(connection.id), provider: "deepseek-web" }),
    });
    assert.strictEqual(getSessionHealth(connection).status, "ok");

    const res = await app.request("/dashboard/providers/accounts/update-session", {
      method: "POST",
      body: new URLSearchParams({
        id: String(connection.id),
        provider: "deepseek-web",
        token: "tok_new",
        cookies: "b=2",
      }),
    });

    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/dashboard/providers/deepseek-web?notice=session_updated");
    assert.deepStrictEqual(getConnections("deepseek-web")[0].credentials, { token: "tok_new", cookies: "b=2" });
    assert.strictEqual(getSessionHealth(connection), null, "the verdict belonged to the old token");
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("dashboard - Perbarui sesi without a token changes nothing", async () => {
  const connection = seed();
  fakeChallenge();

  try {
    const res = await app.request("/dashboard/providers/accounts/update-session", {
      method: "POST",
      body: new URLSearchParams({ id: String(connection.id), provider: "deepseek-web", token: "  " }),
    });

    assert.strictEqual(res.headers.get("location"), "/dashboard/providers/deepseek-web?notice=session_token_missing");
    assert.deepStrictEqual(getConnections("deepseek-web")[0].credentials, { token: "tok_abc", cookies: "a=1" });
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("dashboard - the provider list warns when a session is expired", async () => {
  const connection = seed();
  fakeChallenge({ fail: expiredError() });

  try {
    await app.request("/dashboard/providers/accounts/check-session", {
      method: "POST",
      body: new URLSearchParams({ id: String(connection.id), provider: "deepseek-web" }),
    });

    const html = await (await app.request("/dashboard/providers")).text();
    assert.ok(html.includes("Sesi kedaluwarsa"), "the card carries the warning from the cache");
  } finally {
    resetDeepSeekTransportFactory();
  }
});
