import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { controlPlaneGuard } from "../src/security.js";
import {
  getAntigravityAcpConfigGeneration,
  getAntigravityAcpProfiles,
  registerAntigravityAcpWorker,
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
const WORKER = {
  workerId: "agy-login-worker",
  namespace: "agy-login-worker",
  launcher: "/opt/agy/runtime",
  loginLauncher: "/opt/agy/login",
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

test("happy path uses the trusted login launcher, verifies ACP v1, and registers the worker", async () => {
  reset();
  let child;
  setAntigravityAcpLoginDependenciesForTests({
    spawn: (command, args, options) => {
      assert.equal(command, WORKER.loginLauncher);
      assert.deepEqual(args, []);
      assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
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
  const started = await startAntigravityAcpLogin("session-a");
  assert.equal(started.ok, true);
  const submitted = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code_123" });
  assert.deepEqual(submitted, { ok: true, status: "ready", added: true });
  assert.deepEqual(getAntigravityAcpProfiles(), [{ id: "worker-1", workerId: WORKER.workerId, priority: 0, enabled: true }]);
});

test("wrong session, duplicate submission, and concurrent start fail closed", async () => {
  reset();
  let child;
  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => { child = fakeChild(); queueMicrotask(() => child.stdout.write(`${URL}\n`)); return child; },
  });
  const started = await startAntigravityAcpLogin("session-a");
  assert.equal((await startAntigravityAcpLogin("session-a")).code, "login_busy");
  assert.equal((await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-b", code: "raw" })).code, "login_attempt_invalid");
  assert.equal((await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "https://evil.test/code" })).code, "invalid_authorization_code");
  child.kill();
});

test("process timeout cleans up the child and never registers a profile", async () => {
  reset();
  let child;
  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => { child = fakeChild(); queueMicrotask(() => child.stdout.write(`${URL}\n`)); return child; },
    timings: { exitWaitMs: 10 },
  });
  const started = await startAntigravityAcpLogin("session-a");
  const submitted = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code" });
  assert.equal(submitted.code, "login_process_timeout");
  assert.equal(child.exited, true);
  assert.deepEqual(getAntigravityAcpProfiles(), []);
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
  const started = await startAntigravityAcpLogin("session-a");
  const result = await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code" });
  assert.equal(result.code, "login_verification_failed");
  assert.deepEqual(getAntigravityAcpProfiles(), []);
});

test("registration preserves an unrelated existing profile and refuses a full list", async () => {
  reset();
  setAntigravityAcpWorkerLoaderForTests(async () => [WORKER, {
    workerId: "other-worker", namespace: "other-worker", launcher: "/opt/other/runtime", workspace: "/opt/other/workspace",
  }]);
  await setAntigravityAcpProfiles([{ id: "existing", workerId: "other-worker", priority: 1, enabled: false }]);
  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      const child = fakeChild({ onCode: (_code, process) => queueMicrotask(() => process.emit("exit", 0, null)) });
      queueMicrotask(() => child.stdout.write(`${URL}\n`));
      return child;
    },
    createClient: async () => ({ cwd: WORKER.workspace, async initialize() { return { protocolVersion: 1 }; }, async newSession() { return { sessionId: "s" }; }, async close() {} }),
  });
  const started = await startAntigravityAcpLogin("session-a");
  assert.equal((await submitAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a", code: "raw-code" })).ok, true);
  assert.deepEqual(getAntigravityAcpProfiles(), [
    { id: "existing", workerId: "other-worker", priority: 1, enabled: false },
    { id: "worker-1", workerId: WORKER.workerId, priority: 0, enabled: true },
  ]);

  reset();
  setAntigravityAcpWorkerLoaderForTests(async () => [WORKER, { ...WORKER, workerId: "other-worker", namespace: "other-worker", launcher: "/opt/other/runtime", workspace: "/opt/other/workspace", loginLauncher: undefined }]);
  await setAntigravityAcpProfiles([
    { id: "one", workerId: WORKER.workerId, priority: 0, enabled: true },
    { id: "two", workerId: "other-worker", priority: 1, enabled: true },
  ]);
  assert.equal((await startAntigravityAcpLogin("session-a")).code, "profile_slots_full");
});

test("dashboard exposes Agy as primary and keeps Zenith OAuth as secondary", () => {
  reset();
  const html = renderProviderDetailPage(20120, "antigravity");
  assert.match(html, /Login via Agy/);
  assert.match(html, /Login dengan Google/);
  assert.match(html, /antigravity-acp\/login\/start/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
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
  const started = await startAntigravityAcpLogin("session-a");
  const status = getAntigravityAcpLoginStatus({ attemptId: started.attemptId, binding: "session-a" });
  assert.deepEqual(status, { ok: true, status: "awaiting_code", error: undefined });
});

test("cancel during verification aborts profile registration and cleans up", async () => {
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

  const started = await startAntigravityAcpLogin("session-a");
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
  assert.deepEqual(getAntigravityAcpProfiles(), []);
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

  const started = await startAntigravityAcpLogin("session-a");
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

  const started = await startAntigravityAcpLogin("session-a");
  assert.equal(started.ok, true);
  assert.equal(started.authorizationUrl, fullUrl);
  child.kill();
});

test("concurrent admin update during profile registration fails stale registration gracefully", async () => {
  reset();
  setAntigravityAcpWorkerLoaderForTests(async () => [
    WORKER,
    { workerId: "worker-admin", namespace: "worker-admin", launcher: "/opt/agy/runtime", workspace: "/opt/agy/workspace" },
  ]);

  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      const child = fakeChild({ onCode: (_code, process) => queueMicrotask(() => process.emit("exit", 0, null)) });
      queueMicrotask(() => child.stdout.write(`AGY_LOGIN_URL=${URL}\n`));
      return child;
    },
    createClient: async () => ({
      cwd: WORKER.workspace,
      async initialize() {
        // Admin updates profiles concurrently during login / verification window
        await setAntigravityAcpProfiles([{ id: "admin-worker", workerId: "worker-admin", priority: 0, enabled: true }]);
        return { protocolVersion: 1 };
      },
      async newSession() { return { sessionId: "s" }; },
      async close() {},
    }),
  });

  const started = await startAntigravityAcpLogin("session-a");
  assert.equal(started.ok, true);

  const submitted = await submitAntigravityAcpLogin({
    attemptId: started.attemptId,
    binding: "session-a",
    code: "raw-code",
  });

  assert.equal(submitted.ok, false);
  assert.equal(submitted.code, "login_configuration_changed");
  // Ensure admin profile was NOT overwritten by stale registration
  assert.deepEqual(getAntigravityAcpProfiles(), [
    { id: "admin-worker", workerId: "worker-admin", priority: 0, enabled: true },
  ]);
});

test("registerAntigravityAcpWorker rejects registration when config generation is stale or updated concurrently", async () => {
  reset();
  setAntigravityAcpWorkerLoaderForTests(async () => [
    WORKER,
    { workerId: "worker-admin", namespace: "worker-admin", launcher: "/opt/agy/runtime", workspace: "/opt/agy/workspace" },
  ]);

  const currentGen = getAntigravityAcpConfigGeneration();
  const staleResult = await registerAntigravityAcpWorker(WORKER.workerId, {
    expectedGeneration: currentGen + 99,
  });
  assert.deepEqual(staleResult, { ok: false, reason: "stale" });

  let injectedUpdate = false;
  const adminWorker = { workerId: "worker-admin", namespace: "worker-admin", launcher: "/opt/agy/runtime", workspace: "/opt/agy/workspace" };
  setAntigravityAcpWorkerLoaderForTests(async () => {
    if (!injectedUpdate) {
      injectedUpdate = true;
      await setAntigravityAcpProfiles([{ id: "admin-worker", workerId: "worker-admin", priority: 0, enabled: true }]);
    }
    return [WORKER, adminWorker];
  });

  const raceResult = await registerAntigravityAcpWorker(WORKER.workerId, {
    expectedGeneration: currentGen,
  });
  assert.deepEqual(raceResult, { ok: false, reason: "stale" });
  assert.deepEqual(getAntigravityAcpProfiles(), [
    { id: "admin-worker", workerId: "worker-admin", priority: 0, enabled: true },
  ]);
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

  const started = await startAntigravityAcpLogin("session-a");
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
  assert.deepEqual(getAntigravityAcpProfiles(), []);
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
  const started = await startAntigravityAcpLogin("session-a");
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

  const started = await startAntigravityAcpLogin("session-a");
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

  const started = await startAntigravityAcpLogin("session-a");
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

  const started = await startAntigravityAcpLogin("session-a");
  assert.equal(started.ok, true);
  assert.equal(started.authorizationUrl, expectedUrl);
  child.kill();
});
