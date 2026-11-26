import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { initDb } from "../src/db/index.js";
import { resetAntigravityAcpRuntimeStateForTests, setAntigravityAcpProfiles } from "../src/services/antigravityAcp/profiles.js";
import { setAntigravityAcpWorkerLoaderForTests } from "../src/services/antigravityAcp/workers.js";
import {
  parseLoopbackRedirect, validatePastedCallback, resetAntigravityAcpLoginForTests,
  setAntigravityAcpLoginDependenciesForTests, startAntigravityAcpLogin, submitAntigravityAcpLogin,
  getAntigravityAcpLoginStatus,
} from "../src/services/antigravityAcp/login.js";

const ID = "c".repeat(32);
const WORKER = {
  workerId: `agy-worker-${ID}`, namespace: `agy-worker-${ID}`, launcher: "/x/agy", loginLauncher: "/x/agy", loginLauncherArgs: [],
  loginMode: "acp-authenticate", authMethodId: "oauth-personal", isolatedHome: "/tmp/zr-agy-home", workspace: "/tmp",
};

const open = [];
/** Real loopback listener standing in for the agent's callback server (offline). */
async function listener(onHit) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push({ method: req.method, url: req.url, host: req.headers.host }); onHit?.(req); res.statusCode = 200; res.end("ok"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const handle = { server, hits, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
  open.push(handle);
  return handle;
}

function authUrl(port) {
  return `https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=st4te&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/oauth2callback`)}`;
}

/** Fake agy: URL on stderr after authenticate, response only when the callback arrives (via `complete`). */
function fakeAgy({ url, sent, env }) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exited = false;
  const out = (m) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  child.complete = () => out({ id: 2, result: {} });
  child.stdin = new Writable({ write(chunk, _e, cb) {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const m = JSON.parse(line); sent.push(m);
      if (m.method === "initialize") out({ id: m.id, result: { protocolVersion: 1 } });
      else if (m.method === "authenticate") queueMicrotask(() => child.stderr.write(`Please visit: ${url}\n`));
    }
    cb();
  } });
  child.kill = (s = "SIGTERM") => { if (!child.exited) { child.exited = true; queueMicrotask(() => child.emit("exit", null, s)); } return true; };
  return child;
}

const okClient = async () => ({ cwd: "/tmp", async initialize() { return { protocolVersion: 1 }; }, async newSession() { return { sessionId: "s" }; }, async close() {} });

async function setup() {
  resetAntigravityAcpLoginForTests();
  initDb(":memory:");
  resetAntigravityAcpRuntimeStateForTests();
  await setAntigravityAcpProfiles([{ id: ID, name: "p", enabled: true }]);
  setAntigravityAcpWorkerLoaderForTests(async () => [WORKER]);
}
test.afterEach(async () => {
  resetAntigravityAcpLoginForTests(); setAntigravityAcpWorkerLoaderForTests(null);
  // Always release loopback servers, even when an assertion failed before the explicit close().
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

test("redirect_uri validation is strict", () => {
  assert.deepEqual(parseLoopbackRedirect("http://127.0.0.1:43111/cb"), { host: "127.0.0.1", port: 43111, path: "/cb", ip: "127.0.0.1" });
  assert.equal(parseLoopbackRedirect("http://localhost:43111/cb").host, "localhost");
  assert.equal(parseLoopbackRedirect("http://[::1]:43111/cb").ip, "::1");
  for (const bad of ["https://127.0.0.1:43111/cb", "http://127.0.0.1/cb", "http://127.0.0.1:80/cb", "http://10.0.0.1:43111/cb",
    "http://evil.localhost:43111/cb", "http://127.0.0.1.evil.test:43111/cb", "http://u:p@127.0.0.1:43111/cb", "http://127.0.0.1:43111/cb?x=1",
    "http://127.0.0.1:43111/../x", "http://0.0.0.0:43111/cb", "http://127.1:43111/cb", "ftp://127.0.0.1:43111/", "", null]) {
    assert.equal(parseLoopbackRedirect(bad), null, String(bad));
  }
});

test("pasted callback must match registered host, port, path and state", () => {
  const cb = { ...parseLoopbackRedirect("http://127.0.0.1:43111/oauth2callback"), state: "st4te" };
  const good = validatePastedCallback("http://127.0.0.1:43111/oauth2callback?code=abc&state=st4te", cb);
  assert.equal(good.ip, "127.0.0.1"); assert.equal(good.port, 43111); assert.equal(good.target, "/oauth2callback?code=abc&state=st4te");
  for (const bad of [
    "http://127.0.0.1:43112/oauth2callback?code=abc&state=st4te", "http://localhost:43111/oauth2callback?code=abc&state=st4te",
    "http://127.0.0.1:43111/other?code=abc&state=st4te", "http://127.0.0.1:43111/oauth2callback?code=abc&state=zzz",
    "http://127.0.0.1:43111/oauth2callback?code=abc", "http://127.0.0.1:43111/oauth2callback?state=st4te",
    "http://127.0.0.1:43111/oauth2callback?error=access_denied&code=a&state=st4te", "https://127.0.0.1:43111/oauth2callback?code=a&state=st4te",
    "http://169.254.169.254/latest?code=a&state=st4te", "raw-code", "",
  ]) assert.equal(validatePastedCallback(bad, cb), null, bad);
});

test("contract before/after auth: shim env, URL from stderr, no secret in status, auto completion on local callback", async () => {
  await setup();
  const l = await listener();
  const sent = []; let agy; let env;
  setAntigravityAcpLoginDependenciesForTests({
    spawn: (_c, _a, o) => { env = o.env; agy = fakeAgy({ url: authUrl(l.port), sent, env }); return agy; },
    createClient: okClient,
  });
  const started = await startAntigravityAcpLogin("b", ID);
  assert.equal(started.ok, true);
  assert.deepEqual(started.callback, { host: "127.0.0.1", port: l.port });
  // Before auth completes: ACP order, shim shadows openers and nothing from the server host opens a browser.
  assert.deepEqual(sent.map((m) => m.method), ["initialize", "authenticate"]);
  assert.equal(sent[1].params.methodId, "oauth-personal");
  assert.match(env.PATH.split(":")[0], /zenith-agy-shim-/);
  assert.equal(env.BROWSER, `${env.PATH.split(":")[0]}/xdg-open`);
  const script = await readFile(env.BROWSER, "utf8");
  assert.ok(!script.includes("exec "), "shim never falls through to a real opener");
  assert.deepEqual(getAntigravityAcpLoginStatus({ attemptId: started.attemptId, binding: "b" }), { ok: true, status: "awaiting_code", error: undefined });
  // Local browser: the agent's own listener gets the redirect and the agent answers authenticate.
  agy.complete();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(getAntigravityAcpLoginStatus({ attemptId: started.attemptId, binding: "b" }).status, "ready");
  await l.close();
});

test("shim-captured URL is accepted and invalid shim URLs are ignored", async () => {
  await setup();
  const l = await listener();
  const sent = [];
  setAntigravityAcpLoginDependenciesForTests({
    spawn: (_c, _a, o) => {
      const child = fakeAgy({ url: "ignored", sent });
      child.stderr.write = () => true;
      queueMicrotask(async () => {
        const { appendFile } = await import("node:fs/promises");
        await appendFile(`${o.env.PATH.split(":")[0]}/urls`, "https://evil.test/o/oauth2/v2/auth?x=1\n" + authUrl(l.port) + "\n");
      });
      return child;
    },
    createClient: okClient,
  });
  const started = await startAntigravityAcpLogin("b", ID);
  assert.equal(started.ok, true);
  assert.equal(started.authorizationUrl, authUrl(l.port));
  await l.close();
});

test("remote browser: pasted full callback is replayed once to the literal loopback listener, then login completes", async () => {
  await setup();
  let agy;
  const l = await listener(() => queueMicrotask(() => agy.complete()));
  const sent = [];
  setAntigravityAcpLoginDependenciesForTests({ spawn: () => (agy = fakeAgy({ url: authUrl(l.port), sent })), createClient: okClient });
  const started = await startAntigravityAcpLogin("b", ID);
  const pasted = `http://127.0.0.1:${l.port}/oauth2callback?code=secret-code&state=st4te`;
  const result = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "b", code: pasted });
  assert.deepEqual(result, { ok: true, status: "ready", added: false });
  assert.equal(l.hits.length, 1);
  assert.equal(l.hits[0].method, "GET");
  assert.equal(l.hits[0].url, "/oauth2callback?code=secret-code&state=st4te");
  await l.close();
});

test("remote browser: wrong port/state/host is refused without any request", async () => {
  await setup();
  const l = await listener();
  const other = await listener();
  setAntigravityAcpLoginDependenciesForTests({ spawn: () => fakeAgy({ url: authUrl(l.port), sent: [] }), createClient: okClient });
  const started = await startAntigravityAcpLogin("b", ID);
  for (const bad of [`http://127.0.0.1:${other.port}/oauth2callback?code=c&state=st4te`, `http://127.0.0.1:${l.port}/oauth2callback?code=c&state=bad`, "http://169.254.169.254/oauth2callback?code=c&state=st4te", "just-a-code"]) {
    const r = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "b", code: bad });
    assert.deepEqual(r, { ok: false, code: "invalid_authorization_code" });
  }
  assert.equal(l.hits.length + other.hits.length, 0);
  assert.equal(getAntigravityAcpLoginStatus({ attemptId: started.attemptId, binding: "b" }).status, "awaiting_code", "attempt stays usable");
  await l.close(); await other.close();
});

test("callback replay never follows redirects and a dead listener keeps the attempt retryable", async () => {
  await setup();
  let target;
  const redirectTarget = await listener();
  const l = await listener();
  l.server.removeAllListeners("request");
  l.server.on("request", (req, res) => { l.hits.push(req.url); queueMicrotask(() => target.complete()); res.statusCode = 302; res.setHeader("Location", `http://127.0.0.1:${redirectTarget.port}/steal`); res.end(); });
  setAntigravityAcpLoginDependenciesForTests({ spawn: () => (target = fakeAgy({ url: authUrl(l.port), sent: [] })), createClient: okClient, timings: { exitWaitMs: 50 } });
  const started = await startAntigravityAcpLogin("b", ID);
  const pasted = `http://127.0.0.1:${l.port}/oauth2callback?code=c&state=st4te`;
  const r = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "b", code: pasted });
  assert.equal(r.ok, true);
  assert.equal(redirectTarget.hits.length, 0, "3xx was not followed");
  await l.close(); await redirectTarget.close();

  // Dead listener: failure code, attempt remains awaiting_code.
  resetAntigravityAcpLoginForTests();
  await setup();
  const dead = await listener(); const deadPort = dead.port; await dead.close();
  setAntigravityAcpLoginDependenciesForTests({ spawn: () => fakeAgy({ url: authUrl(deadPort), sent: [] }), createClient: okClient });
  const s2 = await startAntigravityAcpLogin("b", ID);
  const f = await submitAntigravityAcpLogin({ attemptId: s2.attemptId, binding: "b", code: `http://127.0.0.1:${deadPort}/oauth2callback?code=c&state=st4te` });
  assert.deepEqual(f, { ok: false, code: "login_callback_failed" });
  assert.equal(getAntigravityAcpLoginStatus({ attemptId: s2.attemptId, binding: "b" }).status, "awaiting_code");
});

test("an authorization URL with a non-loopback redirect_uri fails closed", async () => {
  await setup();
  const bad = "https://accounts.google.com/o/oauth2/v2/auth?client_id=f&state=s&redirect_uri=" + encodeURIComponent("http://evil.test:9999/cb");
  setAntigravityAcpLoginDependenciesForTests({ spawn: () => fakeAgy({ url: bad, sent: [] }), createClient: okClient });
  const r = await startAntigravityAcpLogin("b", ID);
  assert.deepEqual(r, { ok: false, code: "login_callback_invalid" });
});

test("windows fails closed: no process is spawned and no new account is left", async () => {
  await setup();
  let spawned = 0;
  setAntigravityAcpLoginDependenciesForTests({ platform: "win32", spawn: () => { spawned++; return fakeAgy({ url: authUrl(1), sent: [], env: {} }); }, createClient: okClient });
  const r = await startAntigravityAcpLogin("b", ID);
  assert.deepEqual(r, { ok: false, code: "login_unavailable" });
  assert.equal(spawned, 0);
  const again = await startAntigravityAcpLogin("b", ID);
  assert.notEqual(again.code, "login_busy");
});
