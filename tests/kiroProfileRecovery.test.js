import test from "node:test";
import assert from "node:assert/strict";
import { addConnection, getConnectionById, initDb, updateConnection } from "../src/db/index.js";
import kiroProvider from "../src/providers/registry/kiro.js";
import { executeWithFallback } from "../src/services/fallback.js";
import { ensureKiroProfileArn, resetKiroProfileDiscoveryForTests } from "../src/services/kiroProfile.js";
import { setKiroProfileFetch, setOAuthFetch } from "../src/services/oauth/providers.js";

const ARN_A = "arn:aws:codewhisperer:us-east-1:111111111111:profile/account-a";
const ARN_B = "arn:aws:codewhisperer:us-east-1:222222222222:profile/account-b";
const ARN_C = "arn:aws:codewhisperer:us-east-1:333333333333:profile/account-c";

function profileResponse(...arns) {
  return new Response(JSON.stringify({ profiles: arns.map((arn) => ({ arn })) }), { status: 200 });
}

function setup(t) {
  initDb(":memory:");
  setOAuthFetch(null);
  setKiroProfileFetch(null);
  resetKiroProfileDiscoveryForTests();
  t.after(() => {
    setOAuthFetch(null);
    setKiroProfileFetch(null);
    resetKiroProfileDiscoveryForTests();
  });
}

function fakeExecutor(calls) {
  return {
    async execute({ body }) {
      calls.push(JSON.parse(body));
      return new Response("ok", { status: 200 });
    },
  };
}

async function executeKiro(connection, calls, payload = { model: "claude-sonnet-4.5", profileArn: "arn:attacker", messages: [] }) {
  const result = await executeWithFallback({
    provider: kiroProvider,
    targetFormat: "kiro",
    upstreamPayload: payload,
    baseHeaders: {},
    executor: fakeExecutor(calls),
    resolveUrl: () => "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    targetModel: "claude-sonnet-4.5",
    stream: false,
    requestId: `test-${connection?.id || "none"}`,
  });
  // executeWithFallback attaches the account-slot release to the response;
  // consume the fixture so the next in-memory database test starts clean.
  if (result.ok) await result.upstreamRes.arrayBuffer();
  return result;
}

test("discovers account ARN, persists it, overrides client input, and caches it", async (t) => {
  setup(t);
  let discoveryCalls = 0;
  setOAuthFetch(async () => {
    discoveryCalls += 1;
    return profileResponse(ARN_A);
  });
  const connection = addConnection({
    provider: "kiro",
    name: "Kiro A",
    auth_type: "oauth",
    credentials: { access_token: "token-a" },
  });

  const firstCalls = [];
  const first = await executeKiro(connection, firstCalls);
  assert.equal(first.ok, true);
  assert.equal(firstCalls[0].profileArn, ARN_A);
  assert.equal(discoveryCalls, 1);
  assert.equal(getConnectionById(connection.id).credentials.profile_arn, ARN_A);

  const secondCalls = [];
  const second = await executeKiro(connection, secondCalls);
  assert.equal(second.ok, true);
  assert.equal(secondCalls[0].profileArn, ARN_A);
  assert.equal(discoveryCalls, 1);
});

test("existing profile ARN bypasses discovery and remains connection-scoped", async (t) => {
  setup(t);
  setOAuthFetch(async () => {
    throw new Error("discovery must not run");
  });
  const connection = addConnection({
    provider: "kiro",
    name: "Kiro cached",
    auth_type: "oauth",
    credentials: { access_token: "token-cached", profileArn: ARN_B },
  });
  const calls = [];
  const result = await executeKiro(connection, calls, { model: "claude-sonnet-4.5", profileArn: ARN_A, messages: [] });
  assert.equal(result.ok, true);
  assert.equal(calls[0].profileArn, ARN_B);
});

test("keeps two accounts isolated and uses the selected proxy", async (t) => {
  setup(t);
  const calls = [];
  setKiroProfileFetch(async (_url, init, { proxyUrl }) => {
    const token = new Headers(init.headers).get("Authorization");
    calls.push({ token, proxyUrl });
    return profileResponse(token === "Bearer token-a" ? ARN_A : ARN_B);
  });
  const a = addConnection({ provider: "kiro", name: "A", auth_type: "oauth", proxy_url: "http://proxy-a.test:8080", credentials: { access_token: "token-a" } });
  const b = addConnection({ provider: "kiro", name: "B", auth_type: "oauth", proxy_url: "http://proxy-b.test:8080", credentials: { access_token: "token-b" } });

  const [resultA, resultB] = await Promise.all([
    ensureKiroProfileArn(a),
    ensureKiroProfileArn(b),
  ]);
  assert.equal(resultA.profileArn, ARN_A);
  assert.equal(resultB.profileArn, ARN_B);
  assert.deepEqual(calls.map((call) => call.proxyUrl), ["http://proxy-a.test:8080", "http://proxy-b.test:8080"]);
  assert.equal(getConnectionById(a.id).credentials.profile_arn, ARN_A);
  assert.equal(getConnectionById(b.id).credentials.profile_arn, ARN_B);
});

test("fails closed for ambiguous discovery without dispatching chat", async (t) => {
  setup(t);
  setOAuthFetch(async () => profileResponse(ARN_A, ARN_B));
  const connection = addConnection({ provider: "kiro", name: "Ambiguous", auth_type: "oauth", credentials: { access_token: "token-ambiguous" } });
  const calls = [];
  const result = await executeKiro(connection, calls);
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 400);
  assert.equal(calls.length, 0);
  const body = await result.response.json();
  assert.equal(body.error.code, "kiro_profile_unavailable");
  assert.match(body.error.message, /Reconnect/);
  assert.doesNotMatch(JSON.stringify(body), /token-ambiguous|profile\/account/);
});

test("deduplicates concurrent lookups and refuses to persist a stale result", async (t) => {
  setup(t);
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const start = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  setOAuthFetch(async (_url, init) => {
    calls += 1;
    const token = new Headers(init.headers).get("Authorization");
    if (token === "Bearer token-a") {
      started();
      await gate;
      return profileResponse(ARN_A);
    }
    return profileResponse(ARN_C);
  });
  const connection = addConnection({ provider: "kiro", name: "Race", auth_type: "oauth", credentials: { access_token: "token-a", keep: "yes" } });

  const first = ensureKiroProfileArn(connection);
  await started;
  const second = ensureKiroProfileArn(connection);
  updateConnection(connection.id, { credentials: { access_token: "token-b", keep: "yes" } });
  release();
  const [stale, concurrent] = await Promise.all([first, second]);

  assert.equal(stale.ok, true);
  assert.equal(concurrent.ok, true);
  assert.equal(stale.profileArn, ARN_C);
  assert.equal(concurrent.profileArn, ARN_C);
  assert.equal(calls, 2);
  const stored = getConnectionById(connection.id);
  assert.equal(stored.credentials.access_token, "token-b");
  assert.equal(stored.credentials.keep, "yes");
  assert.equal(stored.credentials.profile_arn, ARN_C);
});

test("empty and failed discovery never dispatch chat", async (t) => {
  setup(t);
  let tokenNumber = 0;
  for (const response of [
    async () => profileResponse(),
    async () => new Response("upstream failure", { status: 503 }),
  ]) {
    setOAuthFetch(response);
    const connection = addConnection({ provider: "kiro", name: "Unavailable", auth_type: "oauth", credentials: { access_token: `token-${tokenNumber++}` } });
    const calls = [];
    const result = await executeKiro(connection, calls);
    assert.equal(result.ok, false);
    assert.equal(result.response.status, 400);
    assert.equal(calls.length, 0);
  }
});

test("unsupported Kiro credential types fail closed before discovery or chat", async (t) => {
  setup(t);
  let discoveryCalls = 0;
  setOAuthFetch(async () => {
    discoveryCalls += 1;
    return profileResponse(ARN_A);
  });
  const connection = addConnection({ provider: "kiro", name: "Missing token", auth_type: "oauth", credentials: {} });
  const calls = [];
  const result = await executeKiro(connection, calls);
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 400);
  assert.equal(discoveryCalls, 0);
  assert.equal(calls.length, 0);
});

test("preflight failure on account A falls back to healthy account B", async (t) => {
  setup(t);
  setOAuthFetch(async (_url, init) => {
    const token = new Headers(init.headers).get("Authorization");
    if (token === "Bearer token-fail") {
      return new Response("internal error", { status: 500 });
    }
    return profileResponse(ARN_B);
  });
  const connA = addConnection({
    provider: "kiro",
    name: "Kiro Fail",
    auth_type: "oauth",
    credentials: { access_token: "token-fail" },
  });
  const connB = addConnection({
    provider: "kiro",
    name: "Kiro Healthy",
    auth_type: "oauth",
    credentials: { access_token: "token-ok" },
  });

  const calls = [];
  const result = await executeKiro(null, calls);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileArn, ARN_B);
  assert.equal(result.connection.id, connB.id);
});

test("ensureKiroProfileArn fails closed without throwing TypeError when connection is removed", async (t) => {
  setup(t);
  const result = await ensureKiroProfileArn({ id: "non-existent-id", provider: "kiro" });
  assert.deepEqual(result, { ok: false, reason: "removed" });
});

test("ensureKiroProfileArn fails closed when proxy resolution throws", async (t) => {
  setup(t);
  const conn = addConnection({
    provider: "kiro",
    name: "Kiro Bad Proxy",
    auth_type: "oauth",
    proxy_pool_id: 999999,
    credentials: { access_token: "token-bad-proxy" },
  });
  const result = await ensureKiroProfileArn(conn);
  assert.deepEqual(result, { ok: false, reason: "proxy_invalid" });
});

test("reactive refresh falls back to next account when preflight fails on refreshed connection", async (t) => {
  setup(t);
  // Account A starts with expired/invalid credentials that trigger 401 on chat dispatch.
  // When refreshed via OIDC, account A's refreshed token fails Kiro profile preflight.
  // Fallback must continue to account B and succeed.
  let refreshCalled = false;
  let preflightRefreshedCalls = 0;
  const connA = addConnection({
    provider: "kiro",
    name: "Kiro Needs Refresh",
    auth_type: "oauth",
    credentials: {
      access_token: "token-a-initial",
      refresh_token: "refresh-a",
      client_id: "client-a",
      client_secret: "secret-a",
      profile_arn: ARN_A,
    },
  });
  const connB = addConnection({
    provider: "kiro",
    name: "Kiro Backup",
    auth_type: "oauth",
    credentials: { access_token: "token-b" },
  });

  setOAuthFetch(async (url, init) => {
    const urlStr = String(url);
    if (urlStr.includes("oidc.") && urlStr.includes("/token")) {
      refreshCalled = true;
      return new Response(JSON.stringify({
        accessToken: "token-a-refreshed",
        refreshToken: "refresh-a-2",
        expiresIn: 3600,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const token = new Headers(init.headers).get("Authorization");

    if (token === "Bearer token-a-refreshed") {
      // Preflight fails on reactive refresh for account A
      preflightRefreshedCalls++;
      return new Response("preflight error after refresh", { status: 500 });
    }
    if (token === "Bearer token-b") {
      return profileResponse(ARN_B);
    }
    return new Response("not found", { status: 404 });
  });

  const calls = [];
  const executor = {
    async execute({ headers, body }) {
      const auth = headers.Authorization || headers.authorization;
      if (auth === "Bearer token-a-initial") {
        // Simulasi token rotation: token A kedaluwarsa di upstream dan kredensial di DB kehilangan profile_arn
        const currentA = getConnectionById(connA.id);
        const { profile_arn, ...remaining } = currentA.credentials;
        updateConnection(connA.id, { credentials: remaining });
        return new Response("unauthorized", { status: 401 });
      }
      calls.push(JSON.parse(body));
      return new Response("ok", { status: 200 });
    },
  };

  const result = await executeWithFallback({
    provider: kiroProvider,
    targetFormat: "kiro",
    upstreamPayload: { model: "claude-sonnet-4.5", profileArn: "arn:attacker", messages: [] },
    baseHeaders: {},
    executor,
    resolveUrl: () => "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
    targetModel: "claude-sonnet-4.5",
    stream: false,
    requestId: "test-reactive-fallback",
  });

  if (result.ok) await result.upstreamRes.arrayBuffer();
  assert.equal(result.ok, true);
  assert.equal(refreshCalled, true, "OIDC refresh endpoint harus dipanggil dan berhasil");
  assert.ok(preflightRefreshedCalls >= 1, "ensureKiroProfileArn harus dipanggil untuk token hasil refresh");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileArn, ARN_B);
  assert.equal(result.connection.id, connB.id);

  // Verifikasi connA di DB telah ter-update token barunya, tetapi profile_arn tidak ada/kosong
  const updatedConnA = getConnectionById(connA.id);
  assert.equal(updatedConnA.credentials.access_token, "token-a-refreshed");
  assert.equal(updatedConnA.credentials.refresh_token, "refresh-a-2");
  assert.equal(updatedConnA.credentials.profile_arn, undefined);
});

test("sharedDiscovery isolates inflight lookups by proxyUrl", async (t) => {
  setup(t);
  let releaseA, releaseB;
  const gateA = new Promise((res) => { releaseA = res; });
  const gateB = new Promise((res) => { releaseB = res; });
  const started = [];

  setKiroProfileFetch(async (_url, _init, { proxyUrl }) => {
    started.push(proxyUrl);
    if (proxyUrl === "http://proxy-1.test:8080") {
      await gateA;
      return profileResponse(ARN_A);
    }
    await gateB;
    return profileResponse(ARN_B);
  });

  const conn = addConnection({
    provider: "kiro",
    name: "Kiro Dual Proxy",
    auth_type: "oauth",
    credentials: { access_token: "token-shared" },
  });

  const p1 = ensureKiroProfileArn(conn, { proxyUrl: "http://proxy-1.test:8080" });
  const p2 = ensureKiroProfileArn(conn, { proxyUrl: "http://proxy-2.test:8080" });

  // Kedua request discovery harus berjalan paralel tanpa tertukar karena beda proxy
  assert.equal(started.length, 2);
  assert.ok(started.includes("http://proxy-1.test:8080"));
  assert.ok(started.includes("http://proxy-2.test:8080"));

  releaseA();
  releaseB();
  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(res1.ok, true);
  assert.equal(res2.ok, true);
});

