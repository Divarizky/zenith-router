import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initDb } from "../src/db/index.js";
import {
  recordAntigravityAcpAccountCatalog,
  getAntigravityAcpAccountsForModel,
  getAntigravityAcpMergedModels,
} from "../src/services/antigravityAcp/catalog.js";
import {
  setAntigravityAcpEnabled,
  setAntigravityAcpProfiles,
  setAntigravityAcpProfileStatus,
  listAntigravityAcpModels,
  resetAntigravityAcpRuntimeStateForTests,
} from "../src/services/antigravityAcp/profiles.js";
import { setAntigravityAcpProvisionRootForTests } from "../src/services/antigravityAcp/workers.js";
import { executeAntigravityAcp } from "../src/executors/antigravityAcp.js";

const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_C = "cccccccccccccccccccccccccccccccc";
const ID_D = "dddddddddddddddddddddddddddddddd";

async function setupEnv(t) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "acp-routing-"));
  const dbPath = path.join(tmpDir, "db.sqlite");
  const rootDir = path.join(tmpDir, "accounts");
  await mkdir(rootDir, { recursive: true });
  await initDb(dbPath);
  setAntigravityAcpProvisionRootForTests(rootDir);
  resetAntigravityAcpRuntimeStateForTests();
  t.after(async () => {
    resetAntigravityAcpRuntimeStateForTests();
    setAntigravityAcpProvisionRootForTests(null);
    await rm(tmpDir, { recursive: true, force: true });
  });
  return { rootDir };
}

async function markLoggedIn(rootDir, accountId) {
  const dir = path.join(rootDir, accountId, "home", ".gemini", "antigravity-acp");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "acp_token.json"), "x");
}

function makeSession(models) {
  return {
    sessionId: "sess-1",
    configOptions: [
      {
        id: "model-opt",
        category: "model",
        type: "select",
        options: models.map((id) => ({ value: id, name: id })),
      },
    ],
  };
}

test("a. per-account catalog, getAntigravityAcpAccountsForModel, and merged catalog exclude non-ready accounts", async (t) => {
  const { rootDir } = await setupEnv(t);
  await setAntigravityAcpProfiles([
    { id: ID_A, name: "acc-a", enabled: true },
    { id: ID_B, name: "acc-b", enabled: true },
    { id: ID_C, name: "acc-c", enabled: true },
    { id: ID_D, name: "acc-d", enabled: true },
  ]);
  await markLoggedIn(rootDir, ID_A);
  await markLoggedIn(rootDir, ID_B);
  await markLoggedIn(rootDir, ID_C);
  // ID_D is logged out (no login file -> needs_login)

  recordAntigravityAcpAccountCatalog(ID_A, makeSession(["model-1"]));
  recordAntigravityAcpAccountCatalog(ID_B, makeSession(["model-2"]));
  recordAntigravityAcpAccountCatalog(ID_C, makeSession(["model-1", "model-2"]));
  recordAntigravityAcpAccountCatalog(ID_D, makeSession(["model-3"]));

  assert.deepEqual(getAntigravityAcpAccountsForModel("model-1").sort(), [ID_A, ID_C].sort());
  assert.deepEqual(getAntigravityAcpAccountsForModel("model-2").sort(), [ID_B, ID_C].sort());
  assert.deepEqual(getAntigravityAcpAccountsForModel("model-unknown"), []);

  const mergedAll = getAntigravityAcpMergedModels();
  assert.deepEqual(mergedAll.map((m) => m.id), ["model-1", "model-2", "model-3"]);

  // listAntigravityAcpModels only includes ready accounts (ID_D is needs_login)
  assert.deepEqual(listAntigravityAcpModels().map((m) => m.id), ["model-1", "model-2"]);

  // Marking ID_B unavailable excludes its exclusive model-2 if ID_C is also unavailable
  setAntigravityAcpProfileStatus(ID_B, "unavailable");
  setAntigravityAcpProfileStatus(ID_C, "unavailable");
  assert.deepEqual(listAntigravityAcpModels().map((m) => m.id), ["model-1"]);
});

test("b. model-targeted routing only selects accounts that support the requested model", async (t) => {
  const { rootDir } = await setupEnv(t);
  await setAntigravityAcpProfiles([
    { id: ID_A, name: "acc-a", enabled: true },
    { id: ID_B, name: "acc-b", enabled: true },
    { id: ID_C, name: "acc-c", enabled: true },
  ]);
  setAntigravityAcpEnabled(true);
  await markLoggedIn(rootDir, ID_A);
  await markLoggedIn(rootDir, ID_B);
  await markLoggedIn(rootDir, ID_C);

  recordAntigravityAcpAccountCatalog(ID_A, makeSession(["model-1"]));
  recordAntigravityAcpAccountCatalog(ID_B, makeSession(["model-2"]));
  recordAntigravityAcpAccountCatalog(ID_C, makeSession(["model-1", "model-2"]));

  const triedWorkers = [];
  const res = await executeAntigravityAcp({
    body: { model: "antigravity-acp/model-2", messages: [{ role: "user", content: "hi" }] },
    createClient: async (workerId) => {
      triedWorkers.push(workerId);
      const handlers = new Set();
      return {
        cwd: "/tmp",
        initialize: async () => ({ protocolVersion: 1 }),
        newSession: async () => makeSession(["model-2"]),
        setConfigOption: async () => ({ configOptions: [{ id: "model-opt", currentValue: "model-2" }] }),
        onUpdate: (fn) => { handlers.add(fn); return () => handlers.delete(fn); },
        prompt: async () => {
          for (const fn of handlers) fn({ sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok-from-b" } } });
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
      };
    },
  });

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.choices[0].message.content, "ok-from-b");
  assert.equal(triedWorkers.length, 1);
  assert.ok(triedWorkers[0].includes(ID_B), `expected ID_B worker, got ${triedWorkers[0]}`);
  assert.ok(!triedWorkers.some((w) => w.includes(ID_A)), "must never try account A for model-2");
});

test("c. pre-prompt failover advances to next valid account on pre-prompt failure", async (t) => {
  const { rootDir } = await setupEnv(t);
  await setAntigravityAcpProfiles([
    { id: ID_A, name: "acc-a", enabled: true },
    { id: ID_B, name: "acc-b", enabled: true },
    { id: ID_C, name: "acc-c", enabled: true },
  ]);
  setAntigravityAcpEnabled(true);
  await markLoggedIn(rootDir, ID_A);
  await markLoggedIn(rootDir, ID_B);
  await markLoggedIn(rootDir, ID_C);

  recordAntigravityAcpAccountCatalog(ID_A, makeSession(["model-1"]));
  recordAntigravityAcpAccountCatalog(ID_B, makeSession(["model-2"]));
  recordAntigravityAcpAccountCatalog(ID_C, makeSession(["model-1", "model-2"]));

  const triedWorkers = [];
  const res = await executeAntigravityAcp({
    body: { model: "antigravity-acp/model-2", messages: [{ role: "user", content: "hello" }] },
    createClient: async (workerId) => {
      triedWorkers.push(workerId);
      if (workerId.includes(ID_B)) {
        return {
          cwd: "/tmp",
          initialize: async () => ({ protocolVersion: 1 }),
          newSession: async () => {
            throw Object.assign(new Error("auth required"), { code: -32000 });
          },
          prompt: async () => { throw new Error("must not prompt"); },
          cancel: async () => {},
          close: async () => {},
        };
      }
      const handlers = new Set();
      return {
        cwd: "/tmp",
        initialize: async () => ({ protocolVersion: 1 }),
        newSession: async () => makeSession(["model-1", "model-2"]),
        setConfigOption: async () => ({ configOptions: [{ id: "model-opt", currentValue: "model-2" }] }),
        onUpdate: (fn) => { handlers.add(fn); return () => handlers.delete(fn); },
        prompt: async () => {
          for (const fn of handlers) fn({ sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok-from-c" } } });
          return { stopReason: "end_turn" };
        },
        cancel: async () => {},
        close: async () => {},
      };
    },
  });

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.choices[0].message.content, "ok-from-c");
  assert.equal(triedWorkers.length, 2);
  assert.ok(triedWorkers[0].includes(ID_B));
  assert.ok(triedWorkers[1].includes(ID_C));
});

test("d. post-prompt strict anti-replay never calls newSession or prompt on a second account", async (t) => {
  const { rootDir } = await setupEnv(t);
  await setAntigravityAcpProfiles([
    { id: ID_B, name: "acc-b", enabled: true },
    { id: ID_C, name: "acc-c", enabled: true },
  ]);
  setAntigravityAcpEnabled(true);
  await markLoggedIn(rootDir, ID_B);
  await markLoggedIn(rootDir, ID_C);

  recordAntigravityAcpAccountCatalog(ID_B, makeSession(["model-2"]));
  recordAntigravityAcpAccountCatalog(ID_C, makeSession(["model-2"]));

  const triedWorkers = [];
  let cNewSessionCalls = 0;
  let cPromptCalls = 0;

  const res = await executeAntigravityAcp({
    body: { model: "antigravity-acp/model-2", messages: [{ role: "user", content: "hello" }] },
    createClient: async (workerId) => {
      triedWorkers.push(workerId);
      if (workerId.includes(ID_B)) {
        return {
          cwd: "/tmp",
          initialize: async () => ({ protocolVersion: 1 }),
          newSession: async () => makeSession(["model-2"]),
          setConfigOption: async () => ({ configOptions: [{ id: "model-opt", currentValue: "model-2" }] }),
          onUpdate: () => () => {},
          prompt: async () => {
            throw Object.assign(new Error("stream dropped mid-turn"), { code: -32000 });
          },
          cancel: async () => {},
          close: async () => {},
        };
      }
      return {
        cwd: "/tmp",
        initialize: async () => ({ protocolVersion: 1 }),
        newSession: async () => { cNewSessionCalls += 1; return makeSession(["model-2"]); },
        prompt: async () => { cPromptCalls += 1; return { stopReason: "end_turn" }; },
        cancel: async () => {},
        close: async () => {},
      };
    },
  });

  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.error.code, "acp_outcome_unknown");
  assert.equal(triedWorkers.length, 1);
  assert.equal(cNewSessionCalls, 0);
  assert.equal(cPromptCalls, 0);
});
