import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import {
  checkSessionHealth,
  ensureSessionHealth,
  forgetSessionHealth,
  getSessionHealth,
  isSessionHealthFresh,
  HEALTH_ERROR_TTL_MS,
  HEALTH_TTL_MS,
  verifySessionToken,
} from "../src/services/deepseekWeb/health.js";

const connection = (overrides = {}) => ({
  id: 1,
  provider: "deepseek-web",
  auth_type: "session",
  credentials: { token: "tok_abc" },
  ...overrides,
});

const okTransport = (calls) => () => ({
  async fetchChallenge() {
    calls.push("challenge");
    return { challenge: "fixture" };
  },
});

function failing(error, calls) {
  return () => ({
    async fetchChallenge() {
      calls.push("challenge");
      throw error;
    },
  });
}

test("health - a live token is probed once through the challenge endpoint and cached", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const calls = [];
  const account = connection();

  const first = await ensureSessionHealth(account, { transportResolver: okTransport(calls) });
  assert.deepStrictEqual({ status: first.status, code: first.code, message: first.message }, { status: "ok", code: null, message: "" });
  assert.deepStrictEqual(calls, ["challenge"], "only create_pow_challenge is called, no session or completion");

  const second = await ensureSessionHealth(account, { transportResolver: okTransport(calls) });
  assert.strictEqual(second, first, "the cached verdict is reused");
  assert.deepStrictEqual(calls, ["challenge"]);

  assert.strictEqual(getSessionHealth(account).status, "ok");
});

test("health - a cached verdict expires and force always re-probes", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const calls = [];
  const account = connection();
  const start = 1_000_000;

  await ensureSessionHealth(account, { transportResolver: okTransport(calls), now: start });
  assert.strictEqual(calls.length, 1);

  await ensureSessionHealth(account, { transportResolver: okTransport(calls), now: start + HEALTH_TTL_MS - 1 });
  assert.strictEqual(calls.length, 1, "still fresh");

  await ensureSessionHealth(account, { transportResolver: okTransport(calls), now: start + HEALTH_TTL_MS + 1 });
  assert.strictEqual(calls.length, 2, "stale verdict is refreshed");

  await checkSessionHealth(account, { transportResolver: okTransport(calls), now: start + HEALTH_TTL_MS + 2 });
  assert.strictEqual(calls.length, 3, "Periksa sesi ignores the cache");
});

test("health - a rejected token is reported as expired, not as a transport error", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const calls = [];
  const unauthorized = Object.assign(new Error("DeepSeek Web session rejected: Unauthorized"), {
    status: 401,
    code: "invalid_token",
    authExpired: true,
  });

  const entry = await ensureSessionHealth(connection(), { transportResolver: failing(unauthorized, calls) });
  assert.strictEqual(entry.status, "expired");
  assert.strictEqual(entry.code, "invalid_token");
  assert.match(entry.message, /Unauthorized/);

  const forbidden = Object.assign(new Error("forbidden"), { status: 403 });
  const second = await ensureSessionHealth(connection({ id: 2 }), { transportResolver: failing(forbidden, calls) });
  assert.strictEqual(second.status, "expired", "403 also means the token is dead");
});

test("health - transport failures are errors and are retried sooner", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const calls = [];
  const boom = Object.assign(new Error("socket hang up"), { code: "upstream_error" });
  const start = 5_000_000;

  const entry = await ensureSessionHealth(connection(), { transportResolver: failing(boom, calls), now: start });
  assert.strictEqual(entry.status, "error");
  assert.strictEqual(entry.code, "upstream_error");
  assert.match(entry.message, /socket hang up/);

  assert.strictEqual(isSessionHealthFresh(entry, start + HEALTH_ERROR_TTL_MS - 1), true);
  assert.strictEqual(isSessionHealthFresh(entry, start + HEALTH_ERROR_TTL_MS + 1), false);
  assert.ok(HEALTH_ERROR_TTL_MS < HEALTH_TTL_MS);
});

test("health - a timeout becomes an error verdict", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const slow = () => ({
    fetchChallenge(signal) {
      return new Promise((_, reject) => {
        const keepAlive = setTimeout(() => {}, 1000);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(keepAlive);
            reject(new Error("The operation was aborted"));
          },
          { once: true }
        );
      });
    },
  });

  const entry = await ensureSessionHealth(connection(), { transportResolver: slow, timeoutMs: 10 });
  assert.strictEqual(entry.status, "error");
  assert.strictEqual(entry.code, "timeout");
});

test("health - a connection without a token never reaches the network", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const calls = [];
  const account = connection({ credentials: { cookies: "a=1" } });

  const entry = await ensureSessionHealth(account, { transportResolver: okTransport(calls) });
  assert.strictEqual(entry.status, "expired");
  assert.strictEqual(entry.code, "invalid_token");
  assert.deepStrictEqual(calls, []);
});

test("health - a blocked proxy is reported without calling upstream", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const calls = [];
  const account = connection({ proxy_pool_id: 999 });

  const entry = await ensureSessionHealth(account, { transportResolver: okTransport(calls) });
  assert.strictEqual(entry.status, "error");
  assert.strictEqual(entry.code, "proxy_blocked");
  assert.deepStrictEqual(calls, []);
});

test("health - concurrent probes for one account share a single request", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  let calls = 0;
  const slowOk = () => ({
    async fetchChallenge() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { challenge: "fixture" };
    },
  });

  const account = connection();
  const [a, b] = await Promise.all([
    ensureSessionHealth(account, { transportResolver: slowOk }),
    ensureSessionHealth(account, { transportResolver: slowOk }),
  ]);

  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(a, b);
});

test("health - a replaced token does not inherit the old verdict", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const calls = [];
  const oldAccount = connection();

  await ensureSessionHealth(oldAccount, { transportResolver: okTransport(calls) });
  assert.strictEqual(getSessionHealth(oldAccount).status, "ok");

  const newAccount = connection({ credentials: { token: "tok_new" } });
  assert.strictEqual(getSessionHealth(newAccount), null, "a different token is a different cache slot");

  forgetSessionHealth(oldAccount);
  assert.strictEqual(getSessionHealth(oldAccount), null);
});

test("health - a captured token is verified before it may become an account", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const calls = [];
  const ok = await verifySessionToken({ token: "eyJcaptured.token.value" }, { transportResolver: okTransport(calls) });
  assert.strictEqual(ok.status, "ok");
  assert.deepStrictEqual(calls, ["challenge"]);

  const rejected = await verifySessionToken(
    { token: "eyJstale.token.value" },
    {
      transportResolver: failing(
        Object.assign(new Error("DeepSeek Web session rejected: Unauthorized"), {
          status: 401,
          code: "invalid_token",
          authExpired: true,
        }),
        calls
      ),
    }
  );
  assert.strictEqual(rejected.status, "expired");
  assert.strictEqual(rejected.code, "invalid_token");
});

test("health - verification does not reuse the account cache", async () => {
  initDb(":memory:");
  forgetSessionHealth();
  const calls = [];
  // Same token twice: a fresh verdict each time, because the user may have just
  // logged in and the earlier answer was about the pre-login state.
  await verifySessionToken({ token: "eyJsame.token.value" }, { transportResolver: okTransport(calls) });
  await verifySessionToken({ token: "eyJsame.token.value" }, { transportResolver: okTransport(calls) });
  assert.strictEqual(calls.length, 2);
});
