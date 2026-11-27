import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initDb } from "../src/db/index.js";
import {
  getAntigravityAcpProfiles,
  getAntigravityAcpProfileStatus,
  setAntigravityAcpEnabled,
  setAntigravityAcpProfiles,
  syncAntigravityAcpProfileHealth,
  resetAntigravityAcpRuntimeStateForTests,
} from "../src/services/antigravityAcp/profiles.js";
import {
  accountPaths,
  verifyAntigravityAcpWorkerHealth,
  setAntigravityAcpWorkerLoaderForTests,
  setAntigravityAcpAutoDiscoveryForTests,
  setAntigravityAcpProvisionRootForTests,
  resetAntigravityAcpWorkerStateForTests,
} from "../src/services/antigravityAcp/workers.js";
import { workerIdForAccount } from "../src/services/antigravityAcp/accounts.js";
import { recordAntigravityAcpAccountCatalog } from "../src/services/antigravityAcp/catalog.js";
import { executeAntigravityAcp } from "../src/executors/antigravityAcp.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  startAntigravityAcpLogin,
  cancelAntigravityAcpLogin,
  resetAntigravityAcpLoginForTests,
  setAntigravityAcpLoginDependenciesForTests,
} from "../src/services/antigravityAcp/login.js";

const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function setupIsolatedEnv(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zr-acp-parallel-"));
  const dbPath = path.join(dir, "db.sqlite");
  const provisionRoot = path.join(dir, "acp-accounts");
  const binDir = path.join(dir, "bin");
  await mkdir(provisionRoot, { recursive: true, mode: 0o700 });
  await mkdir(binDir, { recursive: true, mode: 0o755 });
  const fakeBin = path.join(binDir, "agy_acp_server");
  await writeFile(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  initDb(dbPath);
  resetAntigravityAcpRuntimeStateForTests();
  resetAntigravityAcpWorkerStateForTests();
  resetAntigravityAcpLoginForTests();
  setAntigravityAcpProvisionRootForTests(provisionRoot);
  setAntigravityAcpAutoDiscoveryForTests([fakeBin]);

  t.after(async () => {
    setAntigravityAcpWorkerLoaderForTests(null);
    setAntigravityAcpAutoDiscoveryForTests(null);
    setAntigravityAcpProvisionRootForTests(null);
    resetAntigravityAcpRuntimeStateForTests();
    resetAntigravityAcpWorkerStateForTests();
    resetAntigravityAcpLoginForTests();
    await rm(dir, { recursive: true, force: true });
  });

  return { dir, provisionRoot, fakeBin };
}

async function provisionTwoAccounts(fakeBin) {
  const accounts = [
    { id: ID_A, name: "Account A", enabled: true },
    { id: ID_B, name: "Account B", enabled: true },
  ];
  assert.equal(await setAntigravityAcpProfiles(accounts), true);
  assert.equal(setAntigravityAcpEnabled(true), true);

  for (const id of [ID_A, ID_B]) {
    const paths = accountPaths(id);
    await mkdir(paths.run, { recursive: true, mode: 0o700 });
    await mkdir(paths.appdata, { recursive: true, mode: 0o700 });
    await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(paths.tokenFile), { recursive: true, mode: 0o700 });
    await writeFile(paths.tokenFile, '{"token":"ok"}', { mode: 0o600 });
    for (const d of [paths.root, paths.home, paths.run, paths.workspace]) {
      await chmod(d, 0o700);
    }
  }

  recordAntigravityAcpAccountCatalog(ID_A, { models: { availableModels: [{ modelId: "model-a", name: "Model A" }], currentModelId: "model-a" } });
  recordAntigravityAcpAccountCatalog(ID_B, { models: { availableModels: [{ modelId: "model-b", name: "Model B" }], currentModelId: "model-b" } });
  return { workerA: workerIdForAccount(ID_A), workerB: workerIdForAccount(ID_B), fakeBin };
}

async function readSseText(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test("verifyAntigravityAcpWorkerHealth and syncAntigravityAcpProfileHealth detect healthy and unhealthy workers", async (t) => {
  const { fakeBin } = await setupIsolatedEnv(t);
  const { workerA } = await provisionTwoAccounts(fakeBin);

  const healthy = await verifyAntigravityAcpWorkerHealth(workerA);
  assert.equal(healthy.ok, true);
  assert.equal(healthy.worker.workerId, workerA);

  const syncOk = await syncAntigravityAcpProfileHealth(ID_A);
  assert.equal(syncOk.ok, true);
  assert.equal(syncOk.status, "ready");

  // Make isolated workspace group-readable (0750 instead of 0700) -> unhealthy
  await chmod(accountPaths(ID_A).workspace, 0o750);
  const badDir = await verifyAntigravityAcpWorkerHealth(workerA);
  assert.equal(badDir.ok, false);
  assert.equal(badDir.reason, "invalid_isolated_dir");

  const syncBad = await syncAntigravityAcpProfileHealth(ID_A);
  assert.equal(syncBad.ok, false);
  assert.equal(syncBad.status, "unavailable");
  assert.equal(getAntigravityAcpProfileStatus(ID_A), "unavailable");
});

test("a. concurrent requests on two accounts run on separate workers/sessions with zero cross-talk", async (t) => {
  const { fakeBin } = await setupIsolatedEnv(t);
  const { workerA, workerB } = await provisionTwoAccounts(fakeBin);

  const seen = new Map();
  const createClient = async (workerId) => {
    const isA = workerId === workerA;
    const sessionId = isA ? "sess-A" : "sess-B";
    const chunks = isA ? ["alpha-1 ", "alpha-2"] : ["beta-1 ", "beta-2"];
    seen.set(workerId, { sessionId });
    let updateHandler = null;

    return {
      cwd: accountPaths(isA ? ID_A : ID_B).workspace,
      onUpdate(cb) { updateHandler = cb; return () => { updateHandler = null; }; },
      async initialize() {
        return { protocolVersion: 1 };
      },
      async newSession() {
        return {
          sessionId,
          models: {
            availableModels: [{ modelId: isA ? "model-a" : "model-b", name: isA ? "Model A" : "Model B" }],
            currentModelId: isA ? "model-a" : "model-b",
          },
        };
      },
      async setModel() {
        return {};
      },
      async prompt({ sessionId: sid }) {
        assert.equal(sid, sessionId);
        for (const text of chunks) {
          await new Promise((r) => setTimeout(r, isA ? 10 : 15));
          updateHandler?.({ sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
        }
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async close() {
        return { ok: true };
      },
    };
  };

  const [resA, resB] = await Promise.all([
    executeAntigravityAcp({
      body: { model: "model-a", stream: true, messages: [{ role: "user", content: "hi A" }] },
      createClient,
    }),
    executeAntigravityAcp({
      body: { model: "model-b", stream: true, messages: [{ role: "user", content: "hi B" }] },
      createClient,
    }),
  ]);

  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  const [textA, textB] = await Promise.all([readSseText(resA), readSseText(resB)]);

  assert.equal(seen.get(workerA)?.sessionId, "sess-A");
  assert.equal(seen.get(workerB)?.sessionId, "sess-B");
  assert.match(textA, /alpha-1 /);
  assert.match(textA, /alpha-2/);
  assert.doesNotMatch(textA, /beta-/);
  assert.match(textB, /beta-1 /);
  assert.match(textB, /beta-2/);
  assert.doesNotMatch(textB, /alpha-/);
});

test("b. crash isolation: worker A transport failure does not affect worker B streaming to [DONE]", async (t) => {
  const { fakeBin } = await setupIsolatedEnv(t);
  const { workerA } = await provisionTwoAccounts(fakeBin);

  const createClient = async (workerId) => {
    const isA = workerId === workerA;
    const sessionId = isA ? "sess-crash-A" : "sess-ok-B";
    let updateHandler = null;
    return {
      cwd: accountPaths(isA ? ID_A : ID_B).workspace,
      onUpdate(cb) { updateHandler = cb; return () => { updateHandler = null; }; },
      async initialize() {
        return { protocolVersion: 1 };
      },
      async newSession() {
        return {
          sessionId,
          models: {
            availableModels: [{ modelId: isA ? "model-a" : "model-b", name: isA ? "Model A" : "Model B" }],
            currentModelId: isA ? "model-a" : "model-b",
          },
        };
      },
      async setModel() {
        return {};
      },
      async prompt({ sessionId: sid }) {
        if (isA) {
          updateHandler?.({ sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial-A" } } });
          await new Promise((r) => setTimeout(r, 15));
          throw new Error("worker A transport crashed");
        }
        await new Promise((r) => setTimeout(r, 30));
        updateHandler?.({ sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "complete-B" } } });
        return { stopReason: "end_turn" };
      },
      async cancel() {},
      async close() {
        return { ok: true };
      },
    };
  };

  const [resA, resB] = await Promise.all([
    executeAntigravityAcp({
      body: { model: "model-a", stream: true, messages: [{ role: "user", content: "crash A" }] },
      createClient,
    }),
    executeAntigravityAcp({
      body: { model: "model-b", stream: true, messages: [{ role: "user", content: "ok B" }] },
      createClient,
    }),
  ]);

  const [textA, textB] = await Promise.all([readSseText(resA), readSseText(resB)]);
  assert.match(textA, /error/);
  assert.match(textB, /complete-B/);
  assert.match(textB, /data: \[DONE\]/);
});

test("c. abort isolation: aborting request A cancels only session A while request B finishes normally", async (t) => {
  const { fakeBin } = await setupIsolatedEnv(t);
  const { workerA } = await provisionTwoAccounts(fakeBin);

  const cancelledSessions = [];
  const closedWorkers = [];
  const controllerA = new AbortController();

  const createClient = async (workerId) => {
    const isA = workerId === workerA;
    const sessionId = isA ? "sess-abort-A" : "sess-keep-B";
    let updateHandler = null;
    return {
      cwd: accountPaths(isA ? ID_A : ID_B).workspace,
      onUpdate(cb) { updateHandler = cb; return () => { updateHandler = null; }; },
      async initialize() {
        return { protocolVersion: 1 };
      },
      async newSession() {
        return {
          sessionId,
          models: {
            availableModels: [{ modelId: isA ? "model-a" : "model-b", name: isA ? "Model A" : "Model B" }],
            currentModelId: isA ? "model-a" : "model-b",
          },
        };
      },
      async setModel() {
        return {};
      },
      async prompt({ sessionId: sid }) {
        if (isA) {
          updateHandler?.({ sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "start-A" } } });
          await new Promise((r) => setTimeout(r, 100));
          return { stopReason: "cancelled" };
        }
        await new Promise((r) => setTimeout(r, 40));
        updateHandler?.({ sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "finished-B" } } });
        return { stopReason: "end_turn" };
      },
      async cancel(sid) {
        cancelledSessions.push(sid);
      },
      async close() {
        closedWorkers.push(workerId);
        return { ok: true };
      },
    };
  };

  const [resA, resB] = await Promise.all([
    executeAntigravityAcp({
      body: { model: "model-a", stream: true, messages: [{ role: "user", content: "abort A" }] },
      signal: controllerA.signal,
      createClient,
    }),
    executeAntigravityAcp({
      body: { model: "model-b", stream: true, messages: [{ role: "user", content: "keep B" }] },
      createClient,
    }),
  ]);

  setTimeout(() => controllerA.abort(), 15);
  const [, textB] = await Promise.all([readSseText(resA), readSseText(resB)]);

  assert.deepEqual(cancelledSessions, [{ sessionId: "sess-abort-A" }]);
  assert.ok(closedWorkers.includes(workerA));
  assert.match(textB, /finished-B/);
  assert.match(textB, /data: \[DONE\]/);
});

test("d. login sandbox rollback: cancelling startAntigravityAcpLogin removes all pending directories", async (t) => {
  const { provisionRoot } = await setupIsolatedEnv(t);
  setAntigravityAcpLoginDependenciesForTests({
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
        return true;
      };
      child.stdin.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          const msg = JSON.parse(line);
          if (msg.method === "initialize") {
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: "oauth-personal" }] } }) + "\n");
          } else if (msg.method === "authenticate") {
            child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "elicitation/create", params: { message: "Login", url: "https://accounts.google.com/o/oauth2/auth?client_id=test&redirect_uri=http%3A%2F%2F127.0.0.1%3A12345%2Fcallback&state=abc&response_type=code&scope=openid" } }) + "\n");
          }
        }
      });
      return child;
    },
  });

  const started = await startAntigravityAcpLogin("session-a");
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.ok(started.attemptId);

  const beforeCancel = await readdir(provisionRoot);
  assert.equal(beforeCancel.length, 1);

  const cancelled = cancelAntigravityAcpLogin({ attemptId: started.attemptId, binding: "session-a" });
  assert.equal(cancelled.ok, true);
  await new Promise((r) => setTimeout(r, 20));

  const afterCancel = await readdir(provisionRoot);
  assert.deepEqual(afterCancel, []);
  assert.deepEqual(getAntigravityAcpProfiles(), []);
});
