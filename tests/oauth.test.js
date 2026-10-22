import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getConnections, addConnection } from "../src/db/index.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";
import {
  startOAuthFlow,
  pollOAuthFlow,
  completeManual,
  importLocalLogin,
  resetOAuthFlows,
} from "../src/services/oauth/flows.js";
import { canRefresh, needsTokenRefresh, refreshOAuthToken } from "../src/services/tokenRefresh.js";
import { app } from "../src/index.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

/** Route mocked upstream calls by URL substring; records every call with its parsed body. */
function mockFetch(routes) {
  const calls = [];
  setOAuthFetch(async (url, init = {}) => {
    let body = init.body;
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    else if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    calls.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body });
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) return json({ error: "unmocked" }, 404);
    const handler = routes[key];
    return typeof handler === "function" ? handler(String(url), init, calls) : handler.clone();
  });
  return calls;
}

function reset() {
  setOAuthFetch(null);
  resetOAuthFlows();
}

const ORIGIN = "http://127.0.0.1:20120";

test("github device flow - code, pending, then Copilot token saved with the GitHub token", async (t) => {
  t.after(reset);
  initDb(":memory:");
  let polls = 0;
  const calls = mockFetch({
    "github.com/login/device/code": json({
      device_code: "dev1",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval: 1,
    }),
    "github.com/login/oauth/access_token": () =>
      ++polls === 1 ? json({ error: "authorization_pending" }) : json({ access_token: "gho_live" }),
    "copilot_internal/v2/token": json({ token: "cop_tok", expires_at: 4102444800 }),
    "api.github.com/user": json({ login: "octo", email: "octo@example.com" }),
  });

  const started = await startOAuthFlow({ providerId: "github", origin: ORIGIN });
  assert.strictEqual(started.flowType, "device_code");
  assert.strictEqual(started.userCode, "ABCD-1234");
  assert.strictEqual(started.verificationUri, "https://github.com/login/device");

  assert.strictEqual((await pollOAuthFlow(started.flowId)).status, "pending");
  // Polls inside the provider interval answer from memory without hitting GitHub.
  assert.strictEqual((await pollOAuthFlow(started.flowId)).status, "pending");
  assert.strictEqual(polls, 1);

  await new Promise((r) => setTimeout(r, 1050));
  const done = await pollOAuthFlow(started.flowId);
  assert.strictEqual(done.status, "done");
  assert.strictEqual(done.account, "octo@example.com");

  const [conn] = getConnections("github");
  assert.strictEqual(conn.auth_type, "oauth");
  assert.strictEqual(conn.credentials.access_token, "cop_tok");
  assert.strictEqual(conn.credentials.github_token, "gho_live");
  assert.strictEqual(conn.credentials.expires_at, 4102444800 * 1000);
  const copilotCall = calls.find((c) => c.url.includes("copilot_internal"));
  assert.strictEqual(copilotCall.headers.Authorization, "token gho_live");
});

test("claude PKCE flow - official redirect, manual completion, and status done", async (t) => {
  t.after(reset);
  initDb(":memory:");
  const calls = mockFetch({
    "api.anthropic.com/v1/oauth/token": json({
      access_token: "sk-ant-oat01-a",
      refresh_token: "rt1",
      expires_in: 3600,
      account: { email_address: "me@example.com" },
    }),
    "api.anthropic.com/api/claude_cli/bootstrap": json({
      oauth_account: {
        account_uuid: "acct-1",
        account_email: "me@example.com",
        organization_uuid: "org-1",
        organization_name: "Acme",
        organization_rate_limit_tier: "default",
      },
    }),
  });

  const started = await startOAuthFlow({ providerId: "claude", origin: ORIGIN, name: "Max" });
  assert.strictEqual(started.flowType, "authorization_code");
  assert.strictEqual(started.manualOnly, true, "login Claude diselesaikan manual");
  assert.strictEqual(started.listening, false);
  const auth = new URL(started.authUrl);
  assert.strictEqual(auth.origin + auth.pathname, "https://claude.ai/oauth/authorize");
  assert.strictEqual(
    auth.searchParams.get("redirect_uri"),
    "https://platform.claude.com/oauth/code/callback",
    "redirect URI resmi Claude"
  );
  assert.strictEqual(auth.searchParams.get("code_challenge_method"), "S256");
  assert.strictEqual(auth.searchParams.get("code"), "true");
  assert.strictEqual(auth.searchParams.get("prompt"), "login", "memaksa autentikasi ulang");
  const scope = auth.searchParams.get("scope").split(" ");
  assert.ok(scope.includes("user:sessions:claude_code"));
  assert.ok(scope.includes("user:mcp_servers"));
  const state = auth.searchParams.get("state");

  // A callback for an unknown state is rejected without touching the flow.
  const bogus = await app.request("/callback?code=x&state=nope");
  assert.strictEqual(bogus.status, 400);
  assert.strictEqual((await pollOAuthFlow(started.flowId)).status, "pending");

  // Claude redirects to its own page, so the user pastes the callback back.
  const pasted = await completeManual(
    started.flowId,
    `https://platform.claude.com/oauth/code/callback?code=c0de&state=${encodeURIComponent(state)}`
  );
  assert.strictEqual(pasted.ok, true);
  assert.strictEqual(pasted.account, "Max");

  const exchange = calls.find((c) => c.url.includes("oauth/token"));
  assert.strictEqual(exchange.body.code, "c0de");
  assert.strictEqual(
    exchange.body.redirect_uri,
    "https://platform.claude.com/oauth/code/callback",
    "token exchange memakai redirect URI yang sama"
  );
  assert.ok(exchange.body.code_verifier.length >= 43);

  assert.deepStrictEqual(await pollOAuthFlow(started.flowId), { status: "done", error: undefined, account: "Max" });
  const [conn] = getConnections("claude");
  assert.strictEqual(conn.name, "Max");
  assert.strictEqual(conn.credentials.refresh_token, "rt1");
  assert.strictEqual(conn.credentials.email, "me@example.com");
  assert.strictEqual(conn.credentials.organization_uuid, "org-1");
  assert.strictEqual(conn.credentials.organization_rate_limit_tier, "default");
  assert.ok(conn.credentials.expires_at > Date.now());
});

test("claude login - bootstrap gagal tidak membatalkan login", async (t) => {
  t.after(reset);
  initDb(":memory:");
  mockFetch({
    "api.anthropic.com/v1/oauth/token": json({
      access_token: "sk-ant-oat01-b",
      refresh_token: "rt2",
      expires_in: 3600,
    }),
    "api.anthropic.com/api/claude_cli/bootstrap": new Response("nope", { status: 403 }),
  });

  const started = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const state = new URL(started.authUrl).searchParams.get("state");
  const res = await completeManual(started.flowId, `code-ok#${state}`);
  assert.strictEqual(res.ok, true);
  const [conn] = getConnections("claude");
  assert.strictEqual(conn.credentials.access_token, "sk-ant-oat01-b");
  assert.strictEqual(conn.credentials.organization_uuid, undefined);
});

test("claude login - error dari provider ditampilkan tanpa menyimpan token", async (t) => {
  t.after(reset);
  initDb(":memory:");
  mockFetch({
    "api.anthropic.com/v1/oauth/token": new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "code expired" }),
      { status: 400 }
    ),
  });

  const started = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const state = new URL(started.authUrl).searchParams.get("state");
  const res = await completeManual(started.flowId, `code-bad#${state}`);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /code expired/);
  assert.strictEqual(getConnections("claude").length, 0);
});

test("claude login - input code#state mengirim code dan state yang benar ke token endpoint", async (t) => {
  t.after(reset);
  initDb(":memory:");
  const calls = mockFetch({
    "api.anthropic.com/v1/oauth/token": json({
      access_token: "sk-ant-oat01-hs",
      refresh_token: "rths",
      expires_in: 3600,
    }),
  });

  const started = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const state = new URL(started.authUrl).searchParams.get("state");

  // The manual page shows "code#state".
  const res = await completeManual(started.flowId, `code123#${state}`);
  assert.strictEqual(res.ok, true);
  const exchange = calls.find((c) => c.url.includes("oauth/token"));
  assert.strictEqual(exchange.body.code, "code123", "hanya bagian sebelum # yang jadi code");
  assert.strictEqual(exchange.body.state, state, "bagian setelah # jadi state");

  // A "code#" without a state falls back to the flow's own state.
  const started2 = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const state2 = new URL(started2.authUrl).searchParams.get("state");
  const res2 = await completeManual(started2.flowId, "code-no-state#");
  assert.strictEqual(res2.ok, true);
  const exchange2 = calls.filter((c) => c.url.includes("oauth/token")).pop();
  assert.strictEqual(exchange2.body.code, "code-no-state");
  assert.strictEqual(exchange2.body.state, state2, "state kosong memakai state flow");
});

test("claude login - parser menerima code polos, URL tidak valid, dan URL tanpa scheme", async (t) => {
  t.after(reset);
  initDb(":memory:");
  const calls = mockFetch({
    "api.anthropic.com/v1/oauth/token": json({
      access_token: "sk-ant-oat01-c",
      refresh_token: "rtc",
      expires_in: 3600,
    }),
  });

  const started = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const state = new URL(started.authUrl).searchParams.get("state");

  // A bare code with no state falls back to the flow's own state.
  const bare = await completeManual(started.flowId, "bare-code");
  assert.strictEqual(bare.ok, true);
  const exchange = calls.find((c) => c.url.includes("oauth/token"));
  assert.strictEqual(exchange.body.code, "bare-code");
  assert.strictEqual(exchange.body.state, state);

  // A URL that cannot be parsed is rejected before any token call.
  const started2 = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const invalid = await completeManual(started2.flowId, "https://");
  assert.strictEqual(invalid.ok, false);
  assert.match(invalid.error, /tidak valid/i);

  // A bare host without a scheme is not treated as a callback URL.
  const started3 = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const noScheme = await completeManual(started3.flowId, "platform.claude.com/oauth/code/callback?code=x");
  assert.strictEqual(noScheme.ok, true);
  const last = calls.filter((c) => c.url.includes("oauth/token")).pop();
  assert.strictEqual(last.body.code, "platform.claude.com/oauth/code/callback?code=x");
});

test("claude login - code di fragment callback URL tetap dipakai", async (t) => {
  t.after(reset);
  initDb(":memory:");
  const calls = mockFetch({
    "api.anthropic.com/v1/oauth/token": json({
      access_token: "sk-ant-oat01-frag",
      refresh_token: "rtf",
      expires_in: 3600,
    }),
  });

  const started = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const state = new URL(started.authUrl).searchParams.get("state");
  const res = await completeManual(
    started.flowId,
    `https://platform.claude.com/oauth/code/callback#code=frag-code&state=${encodeURIComponent(state)}`
  );
  assert.strictEqual(res.ok, true);
  const exchange = calls.find((c) => c.url.includes("oauth/token"));
  assert.strictEqual(exchange.body.code, "frag-code");
});

test("claude login - token exchange dan bootstrap memakai identitas Claude Code", async (t) => {
  t.after(reset);
  initDb(":memory:");
  const calls = mockFetch({
    "api.anthropic.com/v1/oauth/token": json({
      access_token: "sk-ant-oat01-h",
      refresh_token: "rth",
      expires_in: 3600,
    }),
    "api.anthropic.com/api/claude_cli/bootstrap": json({
      oauth_account: {
        account_uuid: "acct-h",
        account_email: "h@example.com",
        organization_uuid: "org-h",
        organization_name: "Org H",
        organization_type: "claude_code",
        organization_rate_limit_tier: "default",
      },
    }),
  });

  const started = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const state = new URL(started.authUrl).searchParams.get("state");
  const res = await completeManual(started.flowId, `code-h#${state}`);
  assert.strictEqual(res.ok, true);

  const exchange = calls.find((c) => c.url.includes("oauth/token"));
  assert.match(exchange.headers["User-Agent"], /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
  assert.strictEqual(exchange.headers["X-App"], "cli");
  assert.strictEqual(exchange.headers["Anthropic-Dangerous-Direct-Browser-Access"], "true");

  const bootstrap = calls.find((c) => c.url.includes("bootstrap"));
  assert.strictEqual(bootstrap.headers["X-App"], "cli");
  assert.strictEqual(bootstrap.headers["Anthropic-Dangerous-Direct-Browser-Access"], "true");
  assert.match(bootstrap.headers["User-Agent"], /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);

  const [conn] = getConnections("claude");
  assert.strictEqual(conn.credentials.account_uuid, "acct-h");
  assert.strictEqual(conn.credentials.account_email, "h@example.com");
  assert.strictEqual(conn.credentials.organization_uuid, "org-h");
  assert.strictEqual(conn.credentials.organization_name, "Org H");
  assert.strictEqual(conn.credentials.organization_rate_limit_tier, "default");
  assert.strictEqual(conn.credentials.organization_type, undefined, "field di luar spec tidak disimpan");
});

test("codex flow - tetap memakai callback port tetapnya", async (t) => {
  t.after(reset);
  initDb(":memory:");
  mockFetch({});

  const started = await startOAuthFlow({ providerId: "codex", origin: ORIGIN });
  const auth = new URL(started.authUrl);
  assert.strictEqual(auth.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.strictEqual(started.manualOnly, false, "Codex masih rely on callback, bukan tempel manual");
});

test("claude login - callback URL dengan error provider ditampilkan apa adanya", async (t) => {
  t.after(reset);
  initDb(":memory:");
  mockFetch({});

  const started = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const res = await completeManual(
    started.flowId,
    "https://platform.claude.com/oauth/code/callback?error=access_denied&error_description=User%20declined"
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, "User declined");
  assert.strictEqual(getConnections("claude").length, 0);
});

test("manual completion - pasted callback URL or code#state, state must match", async (t) => {
  t.after(reset);
  initDb(":memory:");
  mockFetch({
    "oauth2.googleapis.com/token": json({ access_token: "ya29", refresh_token: "g-rt", expires_in: 3599 }),
    "oauth2/v1/userinfo": json({ email: "g@example.com" }),
    loadCodeAssist: json({ cloudaicompanionProject: "proj-1", allowedTiers: [{ id: "free-tier", isDefault: true }] }),
    onboardUser: json({ done: true }),
    "anthropic.com/v1/oauth/token": json({ access_token: "a", refresh_token: "r", expires_in: 60 }),
  });

  const ag = await startOAuthFlow({ providerId: "antigravity", origin: ORIGIN });
  const state = new URL(ag.authUrl).searchParams.get("state");
  const wrong = await completeManual(ag.flowId, `http://localhost:20120/callback?code=c&state=other`);
  assert.strictEqual(wrong.ok, false);
  const ok = await completeManual(ag.flowId, `http://localhost:20120/callback?code=c&state=${state}`);
  assert.strictEqual(ok.ok, true);
  const [agConn] = getConnections("antigravity");
  assert.strictEqual(agConn.credentials.project_id, "proj-1");
  assert.strictEqual(agConn.name, "g@example.com");

  const cc = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const ccState = new URL(cc.authUrl).searchParams.get("state");
  assert.strictEqual((await completeManual(cc.flowId, `code123#${ccState}`)).ok, true);
  assert.strictEqual(getConnections("claude").length, 1);
});

test("manual completion - state yang tidak cocok ditolak untuk Claude", async (t) => {
  t.after(reset);
  initDb(":memory:");
  mockFetch({ "anthropic.com/v1/oauth/token": json({ access_token: "a", refresh_token: "r", expires_in: 60 }) });

  const started = await startOAuthFlow({ providerId: "claude", origin: ORIGIN });
  const wrong = await completeManual(started.flowId, `code123#other-state`);
  assert.strictEqual(wrong.ok, false);
  assert.match(wrong.error, /State tidak cocok/);
  assert.strictEqual(getConnections("claude").length, 0);
});

test("kilocode device flow - 202 pending, approved token keeps the organization id", async (t) => {
  t.after(reset);
  initDb(":memory:");
  let polls = 0;
  mockFetch({
    "device-auth/codes/K1": () =>
      ++polls === 1 ? new Response(null, { status: 202 }) : json({ status: "approved", token: "kilo-tok", userEmail: "k@x.io" }),
    "device-auth/codes": json({ code: "K1", verificationUrl: "https://app.kilo.ai/device/K1", expiresIn: 300 }),
    "api/profile": json({ organizations: [{ id: "org-9" }] }),
  });
  const started = await startOAuthFlow({ providerId: "kilocode", origin: ORIGIN });
  assert.strictEqual(started.userCode, "K1");
  assert.strictEqual((await pollOAuthFlow(started.flowId)).status, "pending");
  // Kilo asks for a 3 second poll interval.
  await new Promise((r) => setTimeout(r, 3050));
  assert.strictEqual((await pollOAuthFlow(started.flowId)).status, "done");
  const [conn] = getConnections("kilocode");
  assert.deepStrictEqual(
    { token: conn.credentials.access_token, org: conn.credentials.org_id, name: conn.name },
    { token: "kilo-tok", org: "org-9", name: "k@x.io" }
  );
});

test("glm ZCode flow - login ends in a coding-plan API key", async (t) => {
  t.after(reset);
  initDb(":memory:");
  const listUrl = "api.z.ai/api/biz/v1/organization/o1/projects/p1/api_keys";
  mockFetch({
    "oauth/cli/init": json({ code: 0, data: { flow_id: "f1", authorize_url: "https://z.ai/auth?f=1", poll_interval_sec: 1 } }),
    "oauth/cli/poll/f1": json({ code: 0, data: { status: "ready", user: { email: "z@x.io" }, zai: { access_token: "zai-oauth" } } }),
    "auth/z/login": json({ code: 0, data: { access_token: "biz" } }),
    getCustomerInfo: json({
      code: 0,
      data: { organizations: [{ organizationId: "o1", projects: [{ projectId: "p1", projectName: "default" }] }] },
    }),
    [`${listUrl}/copy/`]: json({ code: 0, data: { secretKey: "SECRET" } }),
    [listUrl]: (url, init) =>
      init.method === "POST" ? json({ code: 0, data: { apiKey: "KEYID" } }) : json({ code: 0, data: [] }),
  });
  const started = await startOAuthFlow({ providerId: "glm", origin: ORIGIN });
  assert.strictEqual(started.verificationUri, "https://z.ai/auth?f=1");
  assert.strictEqual(started.userCode, null);
  assert.strictEqual((await pollOAuthFlow(started.flowId)).status, "done");
  const [conn] = getConnections("glm");
  assert.strictEqual(conn.credentials.access_token, "KEYID.SECRET");
  assert.strictEqual(canRefresh(conn), false, "plan API keys do not expire");
});

test("kiro Builder ID - register client, device auth, then tokens with client and profile", async (t) => {
  t.after(reset);
  initDb(":memory:");
  let polls = 0;
  mockFetch({
    "client/register": json({ clientId: "cid", clientSecret: "csec" }),
    device_authorization: json({
      deviceCode: "kd",
      userCode: "WXYZ",
      verificationUriComplete: "https://view.awsapps.com/start/#/device?user_code=WXYZ",
      interval: 1,
      expiresIn: 600,
    }),
    "oidc.us-east-1.amazonaws.com/token": () =>
      ++polls === 1
        ? json({ error: "authorization_pending" }, 400)
        : json({ accessToken: "aoa", refreshToken: "aorAAAAAGx", expiresIn: 3600 }),
    ListAvailableProfiles: json({ profiles: [{ arn: "arn:aws:codewhisperer:us-east-1:1:profile/P" }] }),
  });
  const started = await startOAuthFlow({ providerId: "kiro", origin: ORIGIN });
  assert.strictEqual(started.userCode, "WXYZ");
  assert.strictEqual((await pollOAuthFlow(started.flowId)).status, "pending");
  await new Promise((r) => setTimeout(r, 1050));
  assert.strictEqual((await pollOAuthFlow(started.flowId)).status, "done");
  const [conn] = getConnections("kiro");
  assert.strictEqual(conn.credentials.client_id, "cid");
  assert.strictEqual(conn.credentials.client_secret, "csec");
  assert.strictEqual(conn.credentials.auth_method, "builder-id");
  assert.strictEqual(conn.credentials.profile_arn, "arn:aws:codewhisperer:us-east-1:1:profile/P");
});

test("upstream errors surface as a failed flow, unsupported providers are refused", async (t) => {
  t.after(reset);
  initDb(":memory:");
  mockFetch({ "github.com/login/device/code": json({ error: "boom" }, 500) });
  await assert.rejects(startOAuthFlow({ providerId: "github", origin: ORIGIN }), /HTTP 500/);
  await assert.rejects(startOAuthFlow({ providerId: "openrouter", origin: ORIGIN }), /tidak mendukung login/);
  assert.strictEqual((await pollOAuthFlow("missing")).status, "error");
});

test("token refresh - provider-specific endpoints and bodies", async (t) => {
  t.after(reset);
  initDb(":memory:");
  const calls = mockFetch({
    "copilot_internal/v2/token": json({ token: "cop2", expires_at: 4102444800 }),
    "api.anthropic.com/v1/oauth/token": json({ access_token: "cc2", refresh_token: "cc-rt2", expires_in: 3600 }),
    "auth.desktop.kiro.dev/refreshToken": json({ accessToken: "kr2", refreshToken: "kr-rt2", expiresIn: 3600 }),
  });

  const gh = addConnection({
    provider: "github",
    name: "gh",
    auth_type: "oauth",
    credentials: { github_token: "gho_x", access_token: "", expires_at: 1 },
  });
  assert.strictEqual(needsTokenRefresh(gh), true);
  const gh2 = await refreshOAuthToken(gh);
  assert.strictEqual(gh2.credentials.access_token, "cop2");
  assert.strictEqual(gh2.credentials.github_token, "gho_x");
  assert.ok(!("refresh_token" in gh2.credentials));

  const cc = addConnection({
    provider: "claude",
    name: "cc",
    auth_type: "oauth",
    credentials: { access_token: "old", refresh_token: "cc-rt", expires_at: 1 },
  });
  const cc2 = await refreshOAuthToken(cc);
  assert.strictEqual(cc2.credentials.refresh_token, "cc-rt2");
  const ccCall = calls.find((c) => c.url.includes("anthropic.com"));
  assert.strictEqual(ccCall.headers["Content-Type"], "application/json");
  assert.deepStrictEqual(ccCall.body, {
    grant_type: "refresh_token",
    refresh_token: "cc-rt",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  });

  // Social (Kiro IDE) logins have no client registration and use Kiro's refresh endpoint.
  const kr = addConnection({
    provider: "kiro",
    name: "kr",
    auth_type: "oauth",
    credentials: { refresh_token: "kr-rt", expires_at: 1, auth_method: "social", profile_arn: "arn:p" },
  });
  const kr2 = await refreshOAuthToken(kr);
  assert.strictEqual(kr2.credentials.access_token, "kr2");
  assert.strictEqual(kr2.credentials.profile_arn, "arn:p");

  const glm = addConnection({ provider: "glm", name: "g", auth_type: "oauth", credentials: { access_token: "k.s" } });
  assert.strictEqual(canRefresh(glm), false);
});

test("local import - Freebuff CLI credentials and Kiro IDE cache", async (t) => {
  t.after(reset);
  initDb(":memory:");
  const home = mkdtempSync(join(tmpdir(), "zr-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  await assert.rejects(importLocalLogin("freebuff"), /freebuff/);

  mkdirSync(join(home, ".config", "manicode"), { recursive: true });
  writeFileSync(
    join(home, ".config", "manicode", "credentials.json"),
    JSON.stringify({ default: { email: "fb@x.io", authToken: "fb-token" } })
  );
  const fb = await importLocalLogin("freebuff");
  assert.strictEqual(fb.account, "fb@x.io");
  assert.strictEqual(getConnections("freebuff")[0].credentials.access_token, "fb-token");

  mkdirSync(join(home, ".aws", "sso", "cache"), { recursive: true });
  writeFileSync(
    join(home, ".aws", "sso", "cache", "kiro-auth-token.json"),
    JSON.stringify({ accessToken: "aoa", refreshToken: "aorAAAAAGabc", authMethod: "social", profileArn: "arn:k" })
  );
  await importLocalLogin("kiro", { name: "Kiro IDE" });
  const [kiro] = getConnections("kiro");
  assert.strictEqual(kiro.name, "Kiro IDE");
  assert.strictEqual(kiro.credentials.auth_method, "social");
  assert.strictEqual(kiro.credentials.refresh_token, "aorAAAAAGabc");
  assert.strictEqual(needsTokenRefresh(kiro), true, "unknown expiry refreshes before first use");
});

test("dashboard - login buttons for OAuth providers, API key form for the rest", async (t) => {
  t.after(reset);
  initDb(":memory:");
  const page = async (id) => (await app.request(`/dashboard/providers/${id}`)).text();

  const claude = await page("claude");
  assert.ok(claude.includes(`zrOAuthStart('claude')`));
  assert.ok(claude.includes("Login dengan Claude"));
  assert.ok(claude.includes("Tempel token manual"));
  assert.ok(claude.includes(`name="refresh_token"`));
  assert.ok(!claude.includes(`name="auth_type"`), "auth type is derived, not chosen");

  const kiro = await page("kiro");
  assert.ok(kiro.includes("Login dengan AWS Builder ID"));
  assert.ok(kiro.includes("Import dari Kiro IDE"));

  const fb = await page("freebuff");
  assert.ok(fb.includes("Import dari Freebuff CLI"));
  assert.ok(!fb.includes("zrOAuthStart("), "Freebuff has no browser login");

  const or = await page("openrouter");
  assert.ok(!or.includes("zrOAuthStart("));
  assert.ok(or.includes(`<label for="api_key">API Key</label>`));

  const oc = await page("opencode");
  assert.ok(!oc.includes("add-account-modal"), "no-auth providers have no account modal");

  // JSON endpoints answer errors as JSON, not redirects.
  const bad = await app.request("/dashboard/oauth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openrouter" }),
  });
  assert.strictEqual(bad.status, 400);
  assert.match((await bad.json()).error, /tidak mendukung/);

  const badProxy = await app.request("/dashboard/oauth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "github", proxy_url: "javascript:x" }),
  });
  assert.strictEqual(badProxy.status, 400);
});

test("cline callback - redirect without state still completes the pending login", async () => {
  initDb(":memory:");
  resetOAuthFlows();
  const started = await startOAuthFlow({ providerId: "cline", origin: "http://127.0.0.1:20120" });
  assert.ok(started.authUrl.includes("callback_url="));

  const payload = Buffer.from(
    JSON.stringify({ accessToken: "eyJhbGciOi.payload+/sig", refreshToken: "rt-1", email: "a@b.c", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }) + "pad",
  ).toString("base64");
  // Browser query parsing turns "+" into " "; the code must survive that.
  const res = await app.request(`/callback?code=${payload.replace(/\+/g, "+")}`);
  assert.strictEqual(res.status, 200);
  const conn = getConnections().find((c) => c.provider === "cline");
  assert.ok(conn, "cline connection saved");
  assert.strictEqual(conn.credentials.refresh_token, "rt-1");
});

test("cline manual paste - callback URL without state is accepted", async () => {
  initDb(":memory:");
  resetOAuthFlows();
  const { flowId } = await startOAuthFlow({ providerId: "cline", origin: "http://127.0.0.1:20120" });
  const code = Buffer.from(JSON.stringify({ accessToken: "tok", refreshToken: "rt-2", email: "x@y.z" })).toString("base64");
  const out = await completeManual(flowId, `http://localhost:20120/callback?code=${encodeURIComponent(code)}`);
  assert.strictEqual(out.ok, true);
});
