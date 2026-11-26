import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { controlPlaneGuard } from "../src/security.js";
import {
  completeAntigravityAcpLogin,
  getAntigravityAcpProfiles,
  resetAntigravityAcpRuntimeStateForTests,
  setAntigravityAcpEnabled,
  setAntigravityAcpProfiles,
} from "../src/services/antigravityAcp/profiles.js";
import { setAntigravityAcpWorkerLoaderForTests } from "../src/services/antigravityAcp/workers.js";
import { renderProviderDetailPage } from "../src/ui/pages/providers.js";
import {
  cancelAntigravityAcpLogin,
  extractAgyAuthorizationUrlForTests,
  getAntigravityAcpLoginStatus,
  resetAntigravityAcpLoginForTests,
  setAntigravityAcpLoginDependenciesForTests,
  startAntigravityAcpLogin,
  submitAntigravityAcpLogin,
  validateAgyAuthorizationUrl,
} from "../src/services/antigravityAcp/login.js";

const URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=fake";
const ID = "a".repeat(32);
const ID_OTHER = "b".repeat(32);
const ACCOUNT = { id: ID, name: "primary", enabled: true };
const WORKER = {
  workerId: `agy-worker-${ID}`,
  namespace: `agy-worker-${ID}`,
  launcher: "/opt/agy/runtime",
  loginLauncher: "/opt/agy/login",
  loginLauncherArgs: ["acp", "--login"],
  launcherArgs: ["acp", "--stdio"],
  isolatedHome: "/opt/agy/home",
  workspace: "/opt/agy/workspace",
};

function fakeChild({ onCode } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exited = false;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      onCode?.(chunk.toString().trim(), child);
      callback();
    },
  });
  child.kill = (signal = "SIGTERM") => {
    if (!child.exited) {
      child.exited = true;
      queueMicrotask(() => child.emit("exit", null, signal));
    }
    return true;
  };
  return child;
}

function reset() {
  resetAntigravityAcpLoginForTests();
  initDb(":memory:");
  resetAntigravityAcpRuntimeStateForTests();
  // The setter has no await before it writes, so the account exists when reset() returns.
  void setAntigravityAcpProfiles([ACCOUNT]);
  setAntigravityAcpWorkerLoaderForTests(async () => [WORKER]);
  setAntigravityAcpLoginDependenciesForTests({ timings: { urlWaitMs: 40, ttlMs: 200, exitWaitMs: 40, verifyWaitMs: 40 } });
}

test.afterEach(() => {
  resetAntigravityAcpLoginForTests();
  setAntigravityAcpWorkerLoaderForTests(null);
});

test("Agy URL validation accepts only official Google authorization URLs and handles fragments", () => {
  assert.equal(validateAgyAuthorizationUrl(URL), URL);
  assert.equal(validateAgyAuthorizationUrl("https://accounts.google.com.evil.test/o/oauth2/v2/auth?x=1"), null);
  assert.equal(validateAgyAuthorizationUrl("http://accounts.google.com/o/oauth2/v2/auth?x=1"), null);
  assert.equal(validateAgyAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth"), null);
  assert.equal(extractAgyAuthorizationUrlForTests(`prefix AGY_LOGIN_URL=${URL}\n`), URL);
  assert.equal(extractAgyAuthorizationUrlForTests(`prefix ${URL},`), URL);
});

test("happy path uses the trusted login launcher, verifies ACP v1, and marks the account ready", async () => {
  reset();
  let child;
  setAntigravityAcpLoginDependenciesForTests({
    spawn: (command, args, options) => {
      assert.equal(command, WORKER.loginLauncher);
      assert.deepEqual(args, WORKER.loginLauncherArgs);
      assert.deepEqual(options.env, {
        PATH: "/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: WORKER.isolatedHome,
        GEMINI_HOME: `${WORKER.isolatedHome}/.gemini`,
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        ...(process.platform === "linux" ? { DBUS_SESSION_BUS_ADDRESS: "disabled:", XDG_RUNTIME_DIR: `${WORKER.isolatedHome}/run` } : {}),
      });
      assert.equal(options.cwd, WORKER.workspace);
      child = fakeChild({ onCode: (_code, process) => queueMicrotask(() => process.emit("exit", 0, null)) });
      queueMicrotask(() => child.stdout.write(`AGY_LOGIN_URL=${URL}\n`));
      return child;
    },
    createClient: async (_workerId, options) => ({
      cwd: WORKER.workspace,
      async initialize(params) { assert.equal(options.signal.aborted, false); assert.equal(params.protocolVersion, 1); return { protocolVersion: 1 }; },
      async newSession(params) { assert.equal(params.cwd, WORKER.workspace); return { sessionId: "offline-session" }; },
      async close() {},
    }),
  });
  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal(started.ok, true);
  const submitted = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code_123" });
  assert.deepEqual(submitted, { ok: true, status: "ready", added: false });
  assert.deepEqual(getAntigravityAcpProfiles(), [ACCOUNT]);
});

test("wrong session, duplicate submission, and concurrent start fail closed", async () => {
  reset();
  let child;
  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => { child = fakeChild(); queueMicrotask(() => child.stdout.write(`${URL}\n`)); return child; },
  });
  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal((await startAntigravityAcpLogin("session-a", ID)).code, "login_busy");
  assert.equal((await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-b", code: "raw" })).code, "login_attempt_invalid");
  assert.equal((await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "https://evil.test/code" })).code, "invalid_authorization_code");
  child.kill();
});

test("process timeout cleans up the child and does not mark the account ready", async () => {
  reset();
  let child;
  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => { child = fakeChild(); queueMicrotask(() => child.stdout.write(`${URL}\n`)); return child; },
    timings: { exitWaitMs: 10 },
  });
  const started = await startAntigravityAcpLogin("session-a", ID);
  const submitted = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code" });
  assert.equal(submitted.code, "login_process_timeout");
  assert.equal(child.exited, true);
  assert.deepEqual(getAntigravityAcpProfiles(), [ACCOUNT]);
});

test("ACP verification failure is not treated as login success", async () => {
  reset();
  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      const child = fakeChild({ onCode: (_code, process) => queueMicrotask(() => process.emit("exit", 0, null)) });
      queueMicrotask(() => child.stdout.write(`${URL}\n`));
      return child;
    },
    createClient: async () => ({
      cwd: WORKER.workspace,
      async initialize() { return { protocolVersion: 2 }; },
      async newSession() { return { sessionId: "must-not-register" }; },
      async close() {},
    }),
  });
  const started = await startAntigravityAcpLogin("session-a", ID);
  const result = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code" });
  assert.equal(result.code, "login_verification_failed");
  assert.deepEqual(getAntigravityAcpProfiles(), [ACCOUNT]);
});

test("login works for a third account and rejects unknown or malformed account ids", async () => {
  reset();
  const ID_THIRD = "c".repeat(32);
  const other = (id, name) => ({ id, name, enabled: true });
  await setAntigravityAcpProfiles([ACCOUNT, other(ID_OTHER, "secondary"), other(ID_THIRD, "tertiary")]);
  const worker = { ...WORKER, workerId: `agy-worker-${ID_THIRD}`, namespace: `agy-worker-${ID_THIRD}` };
  setAntigravityAcpWorkerLoaderForTests(async () => [WORKER, worker]);
  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      const child = fakeChild({ onCode: (_code, process) => queueMicrotask(() => process.emit("exit", 0, null)) });
      queueMicrotask(() => child.stdout.write(`${URL}\n`));
      return child;
    },
    createClient: async () => ({ cwd: WORKER.workspace, async initialize() { return { protocolVersion: 1 }; }, async newSession() { return { sessionId: "s" }; }, async close() {} }),
  });
  const started = await startAntigravityAcpLogin("session-a", ID_THIRD);
  assert.equal(started.ok, true);
  assert.deepEqual(await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code" }), { ok: true, status: "ready", added: false });

  assert.equal((await startAntigravityAcpLogin("session-a", "d".repeat(32))).code, "login_unavailable");
  assert.equal((await startAntigravityAcpLogin("session-a", "../etc")).code, "login_unavailable");
  assert.equal((await startAntigravityAcpLogin("session-a", undefined)).code, "login_unavailable");
});

test("dashboard renders a per-account login control on the ACP provider and no Google OAuth login", async () => {
  reset();
  assert.equal(setAntigravityAcpEnabled(true), true);
  const html = renderProviderDetailPage(20120, "antigravity-acp");
  assert.match(html, /agy-acp-login/);
  assert.match(html, /antigravity-acp\/login\/start/);
  assert.match(html, /zrAgyAcpLogin/);
  assert.match(html, new RegExp(ID));
  assert.doesNotMatch(html, /Login dengan Google/);
  assert.doesNotMatch(html, /zrAgyLoginStart/);
  assert.equal(renderProviderDetailPage(20120, "antigravity"), null);
});

test("login endpoints inherit dashboard auth and CSRF protection", async () => {
  reset();
  const guarded = new Hono();
  guarded.use("*", controlPlaneGuard);
  guarded.post("/dashboard/providers/antigravity-acp/login/start", (c) => c.json({ ok: true }));
  setSetting("require_login", "true");
  assert.equal((await guarded.request("http://localhost/dashboard/providers/antigravity-acp/login/start", { method: "POST" })).status, 401);
  setSetting("require_login", "false");
  assert.equal((await guarded.request("http://localhost/dashboard/providers/antigravity-acp/login/start", { method: "POST", headers: { Origin: "http://evil.test" } })).status, 403);
});

test("status does not disclose process output", async () => {
  reset();
  setAntigravityAcpLoginDependenciesForTests({ spawn: () => { const child = fakeChild(); queueMicrotask(() => child.stdout.write(`secret@example.test ${URL}\n`)); return child; } });
  const started = await startAntigravityAcpLogin("session-a", ID);
  const status = getAntigravityAcpLoginStatus({ attemptId: started.attemptId, binding: "session-a" });
  assert.deepEqual(status, { ok: true, status: "awaiting_code", error: undefined });
});

test("cancel during verification aborts account completion and cleans up", async () => {
  reset();
  let verifyResolve;
  const verifyEntered = new Promise((resolve) => { verifyResolve = resolve; });
  let releaseVerify;
  const verifyBlock = new Promise((resolve) => { releaseVerify = resolve; });

  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      const child = fakeChild({ onCode: (_code, process) => queueMicrotask(() => process.emit("exit", 0, null)) });
      queueMicrotask(() => child.stdout.write(`AGY_LOGIN_URL=${URL}\n`));
      return child;
    },
    createClient: async () => {
      verifyResolve();
      await verifyBlock;
      return {
        cwd: WORKER.workspace,
        async initialize() { return { protocolVersion: 1 }; },
        async newSession() { return { sessionId: "s" }; },
        async close() {},
      };
    },
  });

  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal(started.ok, true);

  const submitPromise = submitAntigravityAcpLogin({
    attemptId: started.attemptId,
    binding: "session-a",
    code: "raw-code",
  });

  await verifyEntered;

  const cancelResult = cancelAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a" });
  assert.deepEqual(cancelResult, { ok: true, status: "cancelled" });

  releaseVerify();

  const submitResult = await submitPromise;
  assert.equal(submitResult.ok, false);
  assert.equal(submitResult.code, "login_cancelled");
  assert.deepEqual(getAntigravityAcpProfiles(), [ACCOUNT]);
  assert.equal(getAntigravityAcpLoginStatus({ attemptId: started.attemptId, binding: "session-a" }).status, "cancelled");
});

test("authorization URL is not truncated when received in fragmented chunks", async () => {
  reset();
  let child;
  const chunk1 = "AGY_LOGIN_URL=https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&";
  const chunk2 = "state=fake_complete_state\n";
  const fullUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=fake_complete_state";

  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      child = fakeChild();
      queueMicrotask(() => {
        child.stdout.write(chunk1);
        queueMicrotask(() => {
          child.stdout.write(chunk2);
        });
      });
      return child;
    },
  });

  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal(started.ok, true);
  assert.equal(started.authorizationUrl, fullUrl);
  child.kill();
});

test("authorization URL without trailing newline resolves when child stream ends", async () => {
  reset();
  let child;
  const chunk1 = "AGY_LOGIN_URL=https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&";
  const chunk2 = "state=fragment_without_newline";
  const fullUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=fragment_without_newline";

  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      child = fakeChild();
      queueMicrotask(() => {
        child.stdout.write(chunk1);
        queueMicrotask(() => {
          child.stdout.write(chunk2);
          child.stdout.end();
        });
      });
      return child;
    },
  });

  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal(started.ok, true);
  assert.equal(started.authorizationUrl, fullUrl);
  child.kill();
});

test("account removed during verification fails the login as a configuration change", async () => {
  reset();
  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      const child = fakeChild({ onCode: (_code, process) => queueMicrotask(() => process.emit("exit", 0, null)) });
      queueMicrotask(() => child.stdout.write(`AGY_LOGIN_URL=${URL}\n`));
      return child;
    },
    createClient: async () => ({
      cwd: WORKER.workspace,
      async initialize() {
        // An admin replaces the list while the login is verifying.
        await setAntigravityAcpProfiles([{ id: ID_OTHER, name: "other", enabled: true }]);
        return { protocolVersion: 1 };
      },
      async newSession() { return { sessionId: "s" }; },
      async close() {},
    }),
  });
  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal(started.ok, true);
  const submitted = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code" });
  assert.equal(submitted.ok, false);
  assert.equal(submitted.code, "login_configuration_changed");
  assert.deepEqual(getAntigravityAcpProfiles(), [{ id: ID_OTHER, name: "other", enabled: true }]);
});

test("completeAntigravityAcpLogin fails closed for an unknown account or a changed worker mapping", async () => {
  reset();
  assert.deepEqual(await completeAntigravityAcpLogin(ID_OTHER), { ok: false, reason: "stale" });
  assert.deepEqual(await completeAntigravityAcpLogin(ID, { expectedWorker: { ...WORKER, launcher: "/opt/other/runtime" } }), { ok: false, reason: "stale" });
  assert.deepEqual(await completeAntigravityAcpLogin(ID, { expectedWorker: WORKER, shouldCommit: () => false }), { ok: false, reason: "cancelled" });
  assert.deepEqual(await completeAntigravityAcpLogin(ID, { expectedWorker: WORKER }), { ok: true, account: ACCOUNT });
});

test("cancel during worker resolution in registerAntigravityAcpWorker aborts registration and keeps profiles clean", async () => {
  reset();
  let workerEnteredResolve;
  const workerEntered = new Promise((resolve) => { workerEnteredResolve = resolve; });
  let releaseWorker;
  const workerBlock = new Promise((resolve) => { releaseWorker = resolve; });

  let holdActive = false;
  setAntigravityAcpWorkerLoaderForTests(async () => {
    if (holdActive) {
      workerEnteredResolve();
      await workerBlock;
    }
    return [WORKER];
  });

  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      const child = fakeChild({ onCode: (_code, process) => queueMicrotask(() => process.emit("exit", 0, null)) });
      queueMicrotask(() => child.stdout.write(`AGY_LOGIN_URL=${URL}\n`));
      return child;
    },
    createClient: async () => ({
      cwd: WORKER.workspace,
      async initialize() {
        holdActive = true;
        return { protocolVersion: 1 };
      },
      async newSession() { return { sessionId: "s" }; },
      async close() {},
    }),
  });

  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal(started.ok, true);

  const submitPromise = submitAntigravityAcpLogin({
    attemptId: started.attemptId,
    binding: "session-a",
    code: "raw-code",
  });

  await workerEntered;

  const cancelResult = cancelAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a" });
  assert.deepEqual(cancelResult, { ok: true, status: "cancelled" });

  releaseWorker();

  const submitResult = await submitPromise;
  assert.equal(submitResult.ok, false);
  assert.equal(submitResult.code, "login_cancelled");
  assert.deepEqual(getAntigravityAcpProfiles(), [ACCOUNT]);
  assert.equal(getAntigravityAcpLoginStatus({ attemptId: started.attemptId, binding: "session-a" }).status, "cancelled");
});

test("authorization URL without trailing newline settles and resolves while child waits for stdin", async () => {
  reset();
  let child;
  setAntigravityAcpLoginDependenciesForTests({
    timings: { urlWaitMs: 3000, urlSettleMs: 25 },
    spawn: () => {
      child = fakeChild();
      queueMicrotask(() => child.stdout.write(`AGY_LOGIN_URL=${URL}`));
      return child;
    },
  });

  const startMs = Date.now();
  const started = await startAntigravityAcpLogin("session-a", ID);
  const elapsed = Date.now() - startMs;
  assert.equal(started.ok, true);
  assert.equal(started.authorizationUrl, URL);
  assert.ok(elapsed < 2000, `Expected fast settle resolution, took ${elapsed}ms`);
  child.kill();
});

test("bare carriage return in or around URL does not prematurely truncate fragmented chunks", async () => {
  reset();
  let child;
  const chunk1 = "\rAGY_LOGIN_URL=https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&";
  const chunk2 = "state=fake_complete_state\r\n";
  const fullUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=fake_complete_state";

  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      child = fakeChild();
      queueMicrotask(() => {
        child.stdout.write(chunk1);
        queueMicrotask(() => {
          child.stdout.write(chunk2);
        });
      });
      return child;
    },
  });

  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal(started.ok, true);
  assert.equal(started.authorizationUrl, fullUrl);
  child.kill();
});

test("URL fragmented across chunks with delay exceeding urlSettleMs is not truncated", async () => {
  reset();
  let child;
  const chunk1 = "AGY_LOGIN_URL=https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&";
  const chunk2 = "state=fake\n";
  const fullUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=fake";

  setAntigravityAcpLoginDependenciesForTests({
    timings: { urlWaitMs: 3000, urlSettleMs: 15 },
    spawn: () => {
      child = fakeChild();
      queueMicrotask(() => {
        child.stdout.write(chunk1);
        setTimeout(() => {
          child.stdout.write(chunk2);
        }, 45);
      });
      return child;
    },
  });

  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal(started.ok, true);
  assert.equal(started.authorizationUrl, fullUrl);
  child.kill();
});

test("bare carriage return followed by text does not append to URL query value", async () => {
  reset();
  let child;
  const output = "AGY_LOGIN_URL=https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=abcdef\rWaiting for code...\n";
  const expectedUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&state=abcdef";

  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      child = fakeChild();
      queueMicrotask(() => child.stdout.write(output));
      return child;
    },
  });

  const started = await startAntigravityAcpLogin("session-a", ID);
  assert.equal(started.ok, true);
  assert.equal(started.authorizationUrl, expectedUrl);
  child.kill();
});

// Memakai penurunan worker yang sebenarnya (tanpa loader override) di root sementara.
async function withRealWorkers(run) {
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const workers = await import("../src/services/antigravityAcp/workers.js");
  const dir = await mkdtemp(pathMod.join(os.tmpdir(), "zenith-acp-newacct-"));
  const binary = pathMod.join(dir, "agy_acp_server");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(binary, 0o700);
  const root = pathMod.join(dir, "root");
  resetAntigravityAcpLoginForTests();
  initDb(":memory:");
  resetAntigravityAcpRuntimeStateForTests();
  workers.resetAntigravityAcpWorkerStateForTests();
  workers.setAntigravityAcpWorkerLoaderForTests(null);
  workers.setAntigravityAcpAutoDiscoveryForTests([binary]);
  workers.setAntigravityAcpProvisionRootForTests(root);
  try {
    await run({ dir, root, binary, workers });
  } finally {
    resetAntigravityAcpLoginForTests();
    workers.resetAntigravityAcpWorkerStateForTests();
    workers.setAntigravityAcpAutoDiscoveryForTests(null);
    workers.setAntigravityAcpProvisionRootForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fake official ACP server: answers initialize, then authenticate raises the Google URL and completes on elicitation accept. */
function acpChild({ initError = false, authError = false, noUrl = false, sent = [] } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exited = false;
  const out = (m) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  child.stdin = new Writable({
    write(chunk, _e, cb) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        sent.push(m);
        if (m.method === "initialize") out(initError ? { id: m.id, error: { code: -1, message: "x" } } : { id: m.id, result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal" }] } });
        else if (m.method === "authenticate") {
          if (authError) out({ id: m.id, error: { code: -1, message: "x" } });
          else if (!noUrl) out({ id: 77, method: "elicitation/create", params: { mode: "url", url: URL, message: "Sign in" } });
        } else if (m.id === 77) out({ id: 2, result: {} });
      }
      cb();
    },
  });
  child.kill = (signal = "SIGTERM") => { if (!child.exited) { child.exited = true; queueMicrotask(() => child.emit("exit", null, signal)); } return true; };
  return child;
}

function approvingChild() { return acpChild(); }

const okClient = async (workerId) => ({
  cwd: workerId ? (await (await import("../src/services/antigravityAcp/workers.js")).getAntigravityAcpWorker(workerId))?.workspace : "ignored",
  async initialize() { return { protocolVersion: 1 }; },
  async newSession() { return { sessionId: "s" }; },
  async close() {},
});

test("adding an account needs no name: it is listed only after the login verified, with a default name", async () => {
  await withRealWorkers(async ({ root }) => {
    let spawnedEnv;
    setAntigravityAcpLoginDependenciesForTests({
      spawn: (_cmd, _args, options) => { spawnedEnv = options.env; return approvingChild(); },
      createClient: async (workerId) => {
        const client = await okClient();
        const { getAntigravityAcpWorker } = await import("../src/services/antigravityAcp/workers.js");
        client.cwd = (await getAntigravityAcpWorker(workerId)).workspace;
        return client;
      },
    });
    assert.deepEqual(getAntigravityAcpProfiles(), []);
    const started = await startAntigravityAcpLogin("session-a");
    assert.equal(started.ok, true);
    // Mid-login: folders exist, but nothing is listed yet.
    assert.deepEqual(getAntigravityAcpProfiles(), []);
    assert.match(spawnedEnv.GEMINI_HOME, /\/home\/\.gemini$/);
    assert.ok(spawnedEnv.GEMINI_HOME.startsWith(root));

    const done = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code" });
    assert.deepEqual(done, { ok: true, status: "ready", added: true });
    const [account] = getAntigravityAcpProfiles();
    assert.match(account.id, /^[0-9a-f]{32}$/);
    assert.equal(account.name, "Akun 1");
    assert.equal(account.enabled, true);
  });
});

test("worker resolution ignores any deployment map: only account-derived workers exist", async () => {
  await withRealWorkers(async ({ workers }) => {
    const { workerIdForAccount } = await import("../src/services/antigravityAcp/accounts.js");
    // Before any account exists there is nothing to resolve, whatever else is on disk.
    assert.deepEqual(await workers.getAntigravityAcpWorkers(), []);
    assert.equal(await workers.getAntigravityAcpWorker("agy-worker-a"), null);
    assert.equal(await workers.getAntigravityAcpWorker(workerIdForAccount(ID)), null);

    await setAntigravityAcpProfiles([ACCOUNT]);
    const [worker] = await workers.getAntigravityAcpWorkers();
    assert.equal(worker.workerId, workerIdForAccount(ID));
    assert.equal(typeof worker.loginLauncher, "string");
    assert.equal((await workers.getAntigravityAcpWorker(workerIdForAccount(ID))).workerId, worker.workerId);

    setAntigravityAcpLoginDependenciesForTests({ spawn: () => approvingChild(), createClient: async () => okClient() });
    const started = await startAntigravityAcpLogin("session-a", ID);
    assert.equal(started.ok, true, "re-login of a listed account starts without any worker map");
    cancelAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a" });
  });
});

test("a cancelled or failed first login leaves no account and no folders behind", async () => {
  await withRealWorkers(async ({ root }) => {
    const { readdir } = await import("node:fs/promises");
    const entries = async () => readdir(root).catch(() => []);

    // Cancelled before the code is entered.
    setAntigravityAcpLoginDependenciesForTests({ spawn: () => acpChild() });
    const first = await startAntigravityAcpLogin("session-a");
    assert.equal(first.ok, true);
    assert.equal((await entries()).length, 1, "folders exist while the login runs");
    cancelAntigravityAcpLogin({ attemptId: first.attemptId, binding: "session-a" });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(getAntigravityAcpProfiles(), []);
    assert.deepEqual(await entries(), [], "cancelled login removes the new folders");

    // Verification fails after a successful agy exit.
    setAntigravityAcpLoginDependenciesForTests({
      spawn: () => approvingChild(),
      createClient: async () => ({ cwd: "x", async initialize() { return { protocolVersion: 2 }; }, async newSession() { return {}; }, async close() {} }),
    });
    const second = await startAntigravityAcpLogin("session-a");
    const result = await submitAntigravityAcpLogin({ attemptId: second.attemptId, binding: "session-a", code: "raw-code" });
    assert.equal(result.code, "login_verification_failed");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(getAntigravityAcpProfiles(), []);
    assert.deepEqual(await entries(), [], "failed verification removes the new folders");
  });
});

test("default names fill the first free slot and accounts can be renamed", async () => {
  const { renameAntigravityAcpAccount } = await import("../src/services/antigravityAcp/profiles.js");
  const { nextDefaultAccountName } = await import("../src/services/antigravityAcp/accounts.js");
  assert.equal(nextDefaultAccountName([]), "Akun 1");
  assert.equal(nextDefaultAccountName([{ name: "Akun 1" }, { name: "akun 2" }]), "Akun 3");
  assert.equal(nextDefaultAccountName([{ name: "Akun 2" }]), "Akun 1");

  reset();
  await setAntigravityAcpProfiles([ACCOUNT, { id: ID_OTHER, name: "other", enabled: true }]);
  assert.deepEqual(renameAntigravityAcpAccount(ID, "kerja"), { ok: true });
  assert.equal(getAntigravityAcpProfiles()[0].name, "kerja");
  assert.equal(renameAntigravityAcpAccount(ID, "OTHER").reason, "duplicate_name");
  assert.equal(renameAntigravityAcpAccount(ID, "").reason, "invalid_name");
  assert.equal(renameAntigravityAcpAccount("c".repeat(32), "x").reason, "not_found");
});

test("official ACP login: initialize, authenticate(oauth-personal), URL from elicitation, isolated env, no code written", async () => {
  await withRealWorkers(async ({ workers, binary }) => {
    const sent = [];
    let spawned;
    setAntigravityAcpLoginDependenciesForTests({
      spawn: (command, args, options) => { spawned = { command, args, options }; return acpChild({ sent }); },
      createClient: okClient,
    });
    const started = await startAntigravityAcpLogin("s", undefined);
    assert.equal(started.ok, true);
    assert.equal(started.authorizationUrl, URL);
    assert.match(binary, /agy_acp_server$/);
    assert.equal(spawned.command, (await import("node:fs/promises")).realpath ? await (await import("node:fs/promises")).realpath(binary) : binary);
    assert.deepEqual(spawned.args, []);
    assert.equal(spawned.options.env.AGY_ACP_FORCE_FILE_STORAGE, "1");
    assert.ok(spawned.options.env.HOME.includes("/home"));
    assert.equal(spawned.options.env.GEMINI_HOME, `${spawned.options.env.HOME}/.gemini`);
    assert.deepEqual(sent.map((m) => m.method).slice(0, 2), ["initialize", "authenticate"]);
    assert.equal(sent[1].params.methodId, "oauth-personal");
    const done = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "s", code: "secret-code-xyz" });
    assert.equal(done.ok, true);
    assert.equal(JSON.stringify(sent).includes("secret-code-xyz"), false);
    assert.equal(workers.isDerivedWorkerMode(), true);
  });
});

test("official ACP login failures: initialize error, authenticate error, and missing URL fail closed", async () => {
  for (const opts of [{ initError: true }, { authError: true }, { noUrl: true }]) {
    await withRealWorkers(async () => {
      setAntigravityAcpLoginDependenciesForTests({
        spawn: () => acpChild(opts), createClient: okClient,
        timings: { urlWaitMs: 60, ttlMs: 300, exitWaitMs: 60, verifyWaitMs: 60 },
      });
      const started = await startAntigravityAcpLogin("s", undefined);
      assert.equal(started.ok, false);
      assert.deepEqual(getAntigravityAcpProfiles(), []);
    });
  }
});

test("agy CLI is never discovered: only agy_acp_server qualifies", async () => {
  await withRealWorkers(async ({ dir, workers }) => {
    const { writeFile, chmod } = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const cli = pathMod.join(dir, "agy");
    await writeFile(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(cli, 0o700);
    workers.setAntigravityAcpAutoDiscoveryForTests([]);
    assert.deepEqual(await workers.getAntigravityAcpWorkers(), []);
  });
});

test(".par binary is discovered and gets --uid= on Linux only; plain binary gets no args", async () => {
  await withRealWorkers(async ({ dir, workers }) => {
    const { writeFile, chmod } = await import("node:fs/promises");
    const pathMod = await import("node:path");
    const par = pathMod.join(dir, "agy_acp_server.par");
    await writeFile(par, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(par, 0o700);
    workers.setAntigravityAcpAutoDiscoveryForTests([par]);
    await setAntigravityAcpProfiles([ACCOUNT]);
    const [worker] = await workers.getAntigravityAcpWorkers();
    assert.match(worker.launcher, /agy_acp_server\.par$/);
    const expected = process.platform === "linux" ? ["--uid="] : [];
    assert.deepEqual(worker.launcherArgs, expected);
    assert.deepEqual(worker.loginLauncherArgs, expected);
    assert.deepEqual(workers.serverArgsFor("/x/agy_acp_server"), []);
  });
});
