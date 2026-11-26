import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, writeFile, rm, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import pkg from "../package.json" with { type: "json" };
import { initDb } from "../src/db/index.js";
import { getProvider, getProviderModels, getAvailableModels, resolveModel } from "../src/providers/index.js";
import {
  getAntigravityAcpProfiles,
  getAntigravityAcpProfileStatus,
  isAntigravityAcpEnabled,
  listAntigravityAcpProfiles,
  setAntigravityAcpEnabled,
  setAntigravityAcpProfileStatus,
  setAntigravityAcpProfiles,
  addAntigravityAcpAccount,
  removeAntigravityAcpAccount,
  acquireAntigravityAcpAccountUse,
  markAntigravityAcpAccountLimited,
  resetAntigravityAcpRuntimeStateForTests,
  setAntigravityAcpClockForTests,
} from "../src/services/antigravityAcp/profiles.js";
import { executeAntigravityAcp, setAntigravityAcpTransportFactory } from "../src/executors/antigravityAcp.js";
import { AntigravityAcpTransport } from "../src/services/antigravityAcp/transport.js";
import { handleChat } from "../src/gateway/chat.js";
import { renderProviderDetailPage, handleSaveAntigravityAcp } from "../src/ui/pages/providers.js";
import { getAntigravityAcpWorker, getAntigravityAcpWorkers, setAntigravityAcpWorkerConfigPathForTests, setAntigravityAcpWorkerLoaderForTests, setAntigravityAcpAutoDiscoveryForTests, setAntigravityAcpProvisionRootForTests } from "../src/services/antigravityAcp/workers.js";
import { createAntigravityAcpClient } from "../src/services/antigravityAcp/client.js";

async function reset(profiles = []) {
  initDb(":memory:");
  setAntigravityAcpWorkerLoaderForTests(async () => [
    { workerId: W1, namespace: W1, launcher: "/test/agy-1", workspace: "/test/worker-1" },
    { workerId: W2, namespace: W2, launcher: "/test/agy-2", workspace: "/test/worker-2" },
    { workerId: W3, namespace: W3, launcher: "/test/agy-3", workspace: "/test/worker-3" },
  ]);
  resetAntigravityAcpRuntimeStateForTests();
  setAntigravityAcpClockForTests(null);
  if (profiles.length) {
    await setAntigravityAcpProfiles(profiles);
    setAntigravityAcpEnabled(true);
  }
}

const ID1 = "a".repeat(32);
const ID2 = "b".repeat(32);
const W1 = `agy-worker-${ID1}`;
const W2 = `agy-worker-${ID2}`;
const ID3 = "c".repeat(32);
const W3 = `agy-worker-${ID3}`;
const TWO_PROFILES = [
  { id: ID1, name: "primary", enabled: true },
  { id: ID2, name: "secondary", enabled: true },
];
const BODY = { model: "agy-acp/gemini-3.8-flash", messages: [{ role: "user", content: "hello" }] };

function protocolFixture({ authAt = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const message = JSON.parse(line);
      let response;
      if (message.method === authAt) response = { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "private fixture detail" } };
      else if (message.method === "initialize") response = { jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1 } };
      else if (message.method === "session/new") response = { jsonrpc: "2.0", id: message.id, result: { sessionId: "fixture-session" } };
      else if (message.method === "session/prompt") {
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "fixture-message", content: { type: "text", text: "fixture answer" } } } })}\n`);
        response = authAt === "prompt-error" ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "private fixture detail" } } : { jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } };
      }
      if (response) setImmediate(() => child.stdout.write(`${JSON.stringify(response)}\n`));
    }
    callback();
  } });
  child.kill = signal => { setImmediate(() => { child.emit("exit", null, signal); child.emit("close", null, signal); }); return true; };
  return child;
}

function fakeClient({ initialize = async () => ({ protocolVersion: 1 }), session = async () => ({ sessionId: "session-1" }), prompt = async () => ({ stopReason: "end_turn" }), cancel = async () => {}, update = null } = {}) {
  const calls = [];
  let updateListener = null;
  const client = {
    cwd: "/srv/zenith/workers/agy-account-1",
    initialize: async (params) => { calls.push(["initialize", params]); return initialize(params); },
    newSession: async (params) => { calls.push(["newSession", params]); return session(params); },
    prompt: async (params) => { calls.push(["prompt", params]); (updateListener || update)?.({ sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "answer" } } }); return prompt(params); },
    cancel: async (params) => { calls.push(["cancel", params]); return cancel(params); },
    onUpdate: (callback) => { updateListener = callback; return () => { updateListener = null; }; },
    close: async () => { calls.push(["close"]); },
  };
  return { client, calls };
}

test("deployment worker map accepts only canonical isolated launchers and rejects duplicates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zenith-acp-workers-"));
  const configPath = path.join(dir, "workers.json");
  setAntigravityAcpWorkerLoaderForTests(null);
  const launcher = path.join(dir, "launch-a");
  const workspace = path.join(dir, "workspace-a");
  await writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await mkdir(workspace);
  await chmod(workspace, 0o700);
  await chmod(launcher, 0o700);
  const valid = [{ workerId: "agy-worker-a", namespace: "agy-worker-a", launcher, workspace }];
  try {
    setAntigravityAcpWorkerConfigPathForTests(configPath);
    await writeFile(configPath, JSON.stringify(valid), { mode: 0o600 });
    assert.equal((await getAntigravityAcpWorkers()).length, 1);
    assert.equal((await getAntigravityAcpWorker("agy-worker-a")).workspace, await realpath(workspace));
    assert.equal(await getAntigravityAcpWorker("unknown"), null);

    for (const [target, mode] of [[launcher, 0o770], [launcher, 0o707], [workspace, 0o770], [workspace, 0o707]]) {
      const original = 0o700;
      await chmod(target, mode);
      assert.deepEqual(await getAntigravityAcpWorkers(), [], `${target === launcher ? "launcher" : "workspace"} mode ${mode.toString(8)} must fail closed`);
      await chmod(target, original);
    }
    assert.equal((await getAntigravityAcpWorkers()).length, 1);

    setAntigravityAcpWorkerConfigPathForTests(configPath);
    await writeFile(configPath, JSON.stringify([
      ...valid,
      { workerId: "agy-worker-b", namespace: "agy-worker-b", launcher: path.join(dir, "alias", "..", "launch-a"), workspace: path.join(dir, "workspace-b") },
    ]), { mode: 0o600 });
    await mkdir(path.join(dir, "workspace-b"));
    assert.deepEqual(await getAntigravityAcpWorkers(), []);
  } finally {
    setAntigravityAcpWorkerConfigPathForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing worker map derives one isolated worker per account and rejects unsafe binaries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zenith-acp-autodiscovery-"));
  const configPath = path.join(dir, "missing.json");
  const binary = path.join(dir, "agy");
  setAntigravityAcpWorkerLoaderForTests(null);
  setAntigravityAcpWorkerConfigPathForTests(configPath);
  try {
    await writeFile(binary, "#!/bin/sh\\nexit 0\\n", { mode: 0o700 });
    await chmod(binary, 0o700);
    const provisionRoot = path.join(dir, "provision-root");
    setAntigravityAcpProvisionRootForTests(provisionRoot);
    setAntigravityAcpAutoDiscoveryForTests([binary]);
    initDb(":memory:");
    const added = await addAntigravityAcpAccount("one");
    assert.equal(added.ok, true);
    const [worker] = await getAntigravityAcpWorkers();
    assert.equal(worker.workerId, `agy-worker-${added.account.id}`);
    assert.equal(worker.launcher, await realpath(binary));
    assert.deepEqual(worker.launcherArgs, ["acp", "--stdio"]);
    assert.deepEqual(worker.loginLauncherArgs, ["acp", "--login"]);
    assert.equal(worker.isolatedHome, path.join(provisionRoot, added.account.id, "home"));
    for (const dirPath of [worker.workspace, worker.isolatedHome]) {
      const info = await import("node:fs/promises").then(({ stat }) => stat(dirPath));
      assert.equal(info.mode & 0o777, 0o700);
    }
    assert.equal(worker.appData, path.join(provisionRoot, added.account.id, "appdata"));
    await chmod(binary, 0o775);
    assert.deepEqual(await getAntigravityAcpWorkers(), []);
    await chmod(binary, 0o700);
    setAntigravityAcpAutoDiscoveryForTests([binary]);
    await writeFile(configPath, "{ invalid", { mode: 0o600 });
    assert.deepEqual(await getAntigravityAcpWorkers(), []);
    await writeFile(configPath, JSON.stringify([{
      workerId: "agy-explicit-test", namespace: "agy-explicit-test", launcher: binary, workspace: worker.workspace,
    }]), { mode: 0o600 });
    assert.equal((await getAntigravityAcpWorkers()).length, 1, "valid worker config must load when mode is 0600");
    await chmod(configPath, 0o666);
    assert.deepEqual(await getAntigravityAcpWorkers(), [], "valid worker config must fail closed when group/other writable");
    assert.equal((await realpath(binary)), binary);
  } finally {
    setAntigravityAcpAutoDiscoveryForTests(null);
    setAntigravityAcpProvisionRootForTests(null);
    setAntigravityAcpWorkerConfigPathForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto-provisioning rejects symlinked provision roots without modifying their targets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zenith-acp-symlink-"));
  const configPath = path.join(dir, "missing.json");
  const binary = path.join(dir, "agy");
  const victim = path.join(dir, "victim");
  const provisionRoot = path.join(dir, "provision-root");
  setAntigravityAcpWorkerLoaderForTests(null);
  setAntigravityAcpWorkerConfigPathForTests(configPath);
  try {
    await writeFile(binary, "#!/bin/sh\\nexit 0\\n", { mode: 0o700 });
    await chmod(binary, 0o700);
    await mkdir(victim);
    initDb(":memory:");
    await setAntigravityAcpProfiles([{ id: ID1, name: "one", enabled: true }]);
    setAntigravityAcpAutoDiscoveryForTests([binary]);
    setAntigravityAcpProvisionRootForTests(provisionRoot);
    await import("node:fs/promises").then(({ symlink }) => symlink(victim, provisionRoot, "dir"));
    const victimModeBefore = (await import("node:fs/promises").then(({ stat }) => stat(victim))).mode & 0o777;
    assert.deepEqual(await getAntigravityAcpWorkers(), []);
    assert.equal((await import("node:fs/promises").then(({ stat }) => stat(victim))).mode & 0o777, victimModeBefore);
    assert.deepEqual(await import("node:fs/promises").then(({ readdir }) => readdir(victim)), []);
  } finally {
    setAntigravityAcpAutoDiscoveryForTests(null);
    setAntigravityAcpProvisionRootForTests(null);
    setAntigravityAcpWorkerConfigPathForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACP worker client uses only allowlisted launch data and ACP v1 methods", async () => {
  await reset();
  setAntigravityAcpWorkerLoaderForTests(async () => [{ workerId: W1, namespace: W1, launcher: "/test/agy-1", launcherArgs: ["acp", "--stdio"], isolatedHome: "/test/isolated-home", workspace: "/test/worker-1" }]);
  const calls = [];
  const listeners = new Map();
  const transport = {
    initialize: async (params) => { calls.push(["initialize", params]); return { protocolVersion: 1 }; },
    request: async (method, params) => { calls.push(["request", method, params]); return method === "session/new" ? { sessionId: "s1" } : { stopReason: "end_turn" }; },
    cancel: async (sessionId) => calls.push(["cancel", sessionId]),
    on: (name, callback) => listeners.set(name, callback),
    off: (name) => listeners.delete(name),
    close: () => calls.push(["close"]),
  };
  const client = await createAntigravityAcpClient(W1, (options) => {
    calls.push(["spawn", options]);
    return transport;
  });
  assert.deepEqual(calls[0], ["spawn", {
    command: "/test/agy-1", args: ["acp", "--stdio"], cwd: "/test/worker-1", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/test/isolated-home", GEMINI_HOME: "/test/isolated-home/.gemini", AGY_ACP_FORCE_FILE_STORAGE: "1" },
  }]);
  assert.equal(calls[0][1].env.HOME, "/test/isolated-home");
  assert.equal("token" in calls[0][1].env, false);
  assert.deepEqual(await client.initialize({ protocolVersion: 1 }), { protocolVersion: 1 });
  assert.deepEqual(await client.newSession({ cwd: client.cwd, mcpServers: [] }), { sessionId: "s1" });
  await client.prompt({ sessionId: "s1", prompt: [{ type: "text", text: "hello" }] });
  await client.cancel({ sessionId: "s1" });
  assert.deepEqual(calls.filter(([kind]) => kind === "request"), [
    ["request", "session/new", { cwd: "/test/worker-1", mcpServers: [] }],
    ["request", "session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "hello" }] }],
  ]);
  assert.deepEqual(calls.find(([kind]) => kind === "cancel"), ["cancel", "s1"]);
  await client.close();
  await assert.rejects(() => createAntigravityAcpClient("unknown", () => transport), { code: "ACP_LOCAL_UNAVAILABLE" });
});

test("client abort during bootstrap closes worker transport before any prompt", async () => {
  await reset();
  const controller = new AbortController();
  let closed = false;
  const transport = {
    initialize: async () => ({ protocolVersion: 1 }),
    request: async () => ({}),
    cancel: async () => {},
    on() {},
    close() { closed = true; },
  };
  const client = await createAntigravityAcpClient(W1, () => transport, { signal: controller.signal });
  controller.abort();
  assert.equal(closed, true);
  await client.close();
});

test("ACP dashboard handler only toggles enablement and renders the account list", async () => {
  await reset([TWO_PROFILES[0]]);
  let redirectTarget = "";
  const context = {
    req: { parseBody: async () => ({ enabled: "false", launcher: "/tmp/evil", cwd: "/tmp/evil" }) },
    redirect(url) { redirectTarget = url; return url; },
  };
  await handleSaveAntigravityAcp(context);
  assert.match(redirectTarget, /notice=acp_saved/);
  assert.equal(isAntigravityAcpEnabled(), false);
  assert.deepEqual(getAntigravityAcpProfiles(), [TWO_PROFILES[0]]);
  const html = renderProviderDetailPage(3000, "antigravity-acp");
  assert.match(html, /primary/);
  assert.match(html, /accounts\/add/);
  assert.doesNotMatch(html, /name="launcher"|name="cwd"|name="env"/);
});

test("ACP is off by default and its model cannot be resolved", () => {
  initDb(":memory:");
  const provider = getProvider("antigravity-acp");
  assert.equal(isAntigravityAcpEnabled(), false);
  assert.equal(setAntigravityAcpEnabled(true), false);
  assert.deepEqual(getProviderModels(provider), []);
  assert.equal(resolveModel("agy-acp/gemini-3.8-flash"), null);
  assert.equal(getAvailableModels().some(({ id }) => id === "agy-acp/gemini-3.8-flash"), false);
});

test("two configured ACP profiles have separate safe statuses", async () => {
  await reset(TWO_PROFILES);
  assert.equal(isAntigravityAcpEnabled(), true);
  assert.equal(getAntigravityAcpProfiles().length, 2);
  assert.equal(getProviderModels(getProvider("antigravity-acp")).length, 1);
  assert.equal(resolveModel("antigravity-acp/gemini-3.8-flash")?.provider.id, "antigravity-acp");
  assert.equal(setAntigravityAcpProfileStatus(ID1, "ready"), true);
  assert.equal(setAntigravityAcpProfileStatus(ID2, "needs_login"), true);
  assert.deepEqual(listAntigravityAcpProfiles().map(({ status }) => status), ["ready", "needs_login"]);
  assert.equal(getAntigravityAcpProfileStatus("missing"), "unavailable");
});

test("ACP account list rejects duplicate IDs/names, non-hex IDs, unknown fields and bad names", async () => {
  await reset();
  const ok = { id: ID1, name: "one", enabled: true };
  assert.equal(await setAntigravityAcpProfiles([ok, { ...ok }]), false);
  assert.equal(await setAntigravityAcpProfiles([ok, { id: ID2, name: "ONE", enabled: true }]), false, "names are case-insensitive");
  assert.equal(await setAntigravityAcpProfiles([{ ...ok, id: "../../etc" }]), false);
  assert.equal(await setAntigravityAcpProfiles([{ ...ok, id: "A".repeat(32) }]), false);
  assert.equal(await setAntigravityAcpProfiles([{ ...ok, command: "sh" }]), false);
  assert.equal(await setAntigravityAcpProfiles([{ ...ok, name: "x".repeat(41) }]), false);
  assert.equal(await setAntigravityAcpProfiles([{ ...ok, priority: 0 }]), false);
  assert.deepEqual(getAntigravityAcpProfiles(), []);
  assert.equal(await setAntigravityAcpProfiles([ok, { id: ID2, name: "two", enabled: true }, { id: ID3, name: "three", enabled: false }]), true);
  assert.equal(getAntigravityAcpProfiles().length, 3);
});

async function derivedEnv(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zenith-acp-accounts-"));
  const binary = path.join(dir, "agy");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(binary, 0o700);
  initDb(":memory:");
  resetAntigravityAcpRuntimeStateForTests();
  setAntigravityAcpClockForTests(null);
  setAntigravityAcpWorkerLoaderForTests(null);
  setAntigravityAcpWorkerConfigPathForTests(path.join(dir, "missing.json"));
  setAntigravityAcpAutoDiscoveryForTests([binary]);
  const root = path.join(dir, "acp");
  setAntigravityAcpProvisionRootForTests(root);
  try { await fn({ dir, root }); } finally {
    setAntigravityAcpAutoDiscoveryForTests(null);
    setAntigravityAcpProvisionRootForTests(null);
    setAntigravityAcpWorkerConfigPathForTests(null);
    setAntigravityAcpClockForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
}

async function markLoggedIn(root, id) {
  const dir = path.join(root, id, "home", ".gemini", "antigravity-acp");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "acp_token.json"), "x");
}

test("more than two accounts can be added; each gets home/appdata/workspace and starts as needs_login", async () => {
  await derivedEnv(async ({ root }) => {
    const accounts = [];
    for (const name of ["a", "b", "c", "d"]) {
      const result = await addAntigravityAcpAccount(name);
      assert.equal(result.ok, true);
      assert.match(result.account.id, /^[0-9a-f]{32}$/);
      accounts.push(result.account);
    }
    assert.equal(getAntigravityAcpProfiles().length, 4);
    assert.deepEqual(getAntigravityAcpProfiles().map(({ name }) => name), ["a", "b", "c", "d"]);
    for (const dirName of ["home", "appdata", "workspace"]) {
      assert.equal((await stat(path.join(root, accounts[3].id, dirName))).isDirectory(), true);
    }
    assert.deepEqual(listAntigravityAcpProfiles().map(({ status }) => status), ["needs_login", "needs_login", "needs_login", "needs_login"]);
    const worker = await getAntigravityAcpWorker(`agy-worker-${accounts[2].id}`);
    assert.equal(worker.isolatedHome, path.join(root, accounts[2].id, "home"));
    assert.equal(await getAntigravityAcpWorker("agy-worker-default"), null);
    assert.equal(await getAntigravityAcpWorker(`agy-worker-${"f".repeat(32)}`), null, "unknown account has no worker");
  });
});

test("duplicate (case-insensitive) and invalid names are rejected when adding accounts", async () => {
  await derivedEnv(async () => {
    assert.equal((await addAntigravityAcpAccount("Work")).ok, true);
    assert.equal((await addAntigravityAcpAccount("work")).reason, "duplicate_name");
    assert.equal((await addAntigravityAcpAccount("")).reason, "invalid_name");
    assert.equal((await addAntigravityAcpAccount("y".repeat(41))).reason, "invalid_name");
    assert.equal(getAntigravityAcpProfiles().length, 1);
  });
});

test("needs_login accounts are not selected; a logged-in account is", async () => {
  await derivedEnv(async ({ root }) => {
    const first = (await addAntigravityAcpAccount("first")).account;
    const second = (await addAntigravityAcpAccount("second")).account;
    setAntigravityAcpEnabled(true);
    await markLoggedIn(root, second.id);
    const seen = [];
    const response = await executeAntigravityAcp({ body: BODY, createClient: async (workerId) => { seen.push(workerId); return fakeClient().client; } });
    assert.equal(response.status, 200);
    assert.deepEqual(seen, [`agy-worker-${second.id}`]);
    assert.equal(getAntigravityAcpProfileStatus(first.id), "needs_login");
    assert.equal(getAntigravityAcpProfileStatus(second.id), "ready");
  });
});

test("limited account is skipped for new requests and chosen again after reset", async () => {
  await derivedEnv(async ({ root }) => {
    const first = (await addAntigravityAcpAccount("first")).account;
    const second = (await addAntigravityAcpAccount("second")).account;
    setAntigravityAcpEnabled(true);
    await markLoggedIn(root, first.id);
    await markLoggedIn(root, second.id);
    let now = 1_000_000;
    setAntigravityAcpClockForTests(() => now);
    const resetAt = now + 60_000;
    assert.equal(markAntigravityAcpAccountLimited(first.id, resetAt), true);
    assert.equal(getAntigravityAcpProfileStatus(first.id), "limited");
    const run = async () => {
      const seen = [];
      const response = await executeAntigravityAcp({ body: BODY, createClient: async (workerId) => { seen.push(workerId); return fakeClient().client; } });
      assert.equal(response.status, 200);
      return seen;
    };
    assert.deepEqual(await run(), [`agy-worker-${second.id}`]);
    now = resetAt + 1;
    assert.equal(getAntigravityAcpProfileStatus(first.id), "ready");
    assert.deepEqual(await run(), [`agy-worker-${first.id}`]);
  });
});

test("limit without a reset time lasts five hours", async () => {
  await derivedEnv(async ({ root }) => {
    const account = (await addAntigravityAcpAccount("only")).account;
    await markLoggedIn(root, account.id);
    let now = 5_000;
    setAntigravityAcpClockForTests(() => now);
    markAntigravityAcpAccountLimited(account.id, null);
    now += 5 * 3_600_000 - 1;
    assert.equal(getAntigravityAcpProfileStatus(account.id), "limited");
    now += 2;
    assert.equal(getAntigravityAcpProfileStatus(account.id), "ready");
  });
});

test("usage-limit agent text marks the account limited and is never replayed on another account", async () => {
  await derivedEnv(async ({ root }) => {
    const first = (await addAntigravityAcpAccount("first")).account;
    const second = (await addAntigravityAcpAccount("second")).account;
    setAntigravityAcpEnabled(true);
    await markLoggedIn(root, first.id);
    await markLoggedIn(root, second.id);
    const seen = [];
    const limitText = "Usage Limit Reached\n\nYou have reached your current quota for this period. Your quota will reset in 2 hours, 30 minutes.";
    const response = await executeAntigravityAcp({ body: BODY, createClient: async (workerId) => {
      seen.push(workerId);
      const { client } = fakeClient();
      let listener;
      client.onUpdate = (cb) => { listener = cb; return () => {}; };
      client.prompt = async ({ sessionId }) => {
        listener({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: limitText } } });
        return { stopReason: "end_turn" };
      };
      return client;
    } });
    assert.equal(response.status, 429);
    assert.deepEqual(seen, [`agy-worker-${first.id}`]);
    assert.equal(getAntigravityAcpProfileStatus(first.id), "limited");
    assert.equal(getAntigravityAcpProfileStatus(second.id), "ready");
  });
});

test("deleting an account removes token files and its folder; busy accounts are refused", async () => {
  await derivedEnv(async ({ root }) => {
    const keep = (await addAntigravityAcpAccount("keep")).account;
    const gone = (await addAntigravityAcpAccount("gone")).account;
    await markLoggedIn(root, gone.id);
    await writeFile(path.join(root, gone.id, "home", ".gemini", "antigravity-acp", "acp_business_token.json"), "y");
    assert.equal((await removeAntigravityAcpAccount("../" + keep.id)).reason, "invalid_id");
    assert.equal((await removeAntigravityAcpAccount("d".repeat(32))).reason, "not_found");
    const release = acquireAntigravityAcpAccountUse(gone.id);
    assert.equal((await removeAntigravityAcpAccount(gone.id)).reason, "account_busy");
    assert.equal((await stat(path.join(root, gone.id))).isDirectory(), true);
    release();
    assert.deepEqual(await removeAntigravityAcpAccount(gone.id), { ok: true });
    await assert.rejects(() => stat(path.join(root, gone.id)));
    assert.deepEqual(getAntigravityAcpProfiles().map(({ id }) => id), [keep.id]);
    assert.equal((await stat(path.join(root, keep.id))).isDirectory(), true);
  });
});

test("ACP requests negotiate exactly v1 and return assistant output from session updates", async () => {
  await reset([TWO_PROFILES[0]]);
  const { client, calls } = fakeClient();
  const response = await executeAntigravityAcp({ body: BODY, createClient: async () => client });
  const raw = await response.text();
  const data = JSON.parse(raw);
  assert.equal(response.status, 200, raw);
  assert.equal(data.choices[0].message.content, "answer");
  assert.match(data.id, /^chatcmpl-acp-[\da-f-]{36}$/);
  assert.doesNotMatch(data.id, /session-1/);
  assert.deepEqual(calls.slice(0, 3), [
    ["initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "zenith-router", version: pkg.version } }],
    ["newSession", { cwd: "/srv/zenith/workers/agy-account-1", mcpServers: [] }],
    ["prompt", { sessionId: "session-1", prompt: [{ type: "text", text: "user: hello" }] }],
  ]);
});

test("ACP stream detects usage-limit messages split across chunks", async () => {
  await reset([TWO_PROFILES[0]]);
  const accountId = TWO_PROFILES[0].id;
  const limitText = "Usage Limit Reached\\n\\nYou have reached your current quota for this period. Your quota will reset in 2 hours, 30 minutes.";
  const { client } = fakeClient({
    prompt: async ({ sessionId }) => {
      const splitAt = 9;
      for (const text of [limitText.slice(0, splitAt), limitText.slice(splitAt)]) {
        clientListener({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
      }
      return { stopReason: "end_turn" };
    },
  });
  let clientListener;
  client.onUpdate = (cb) => { clientListener = cb; return () => {}; };
  const response = await executeAntigravityAcp({ body: { ...BODY, stream: true }, createClient: async () => client });
  const raw = await response.text();
  assert.equal(response.status, 200);
  assert.match(raw, /acp_usage_limit/);
  assert.doesNotMatch(raw, /You have reached your current quota/);
  assert.equal(getAntigravityAcpProfileStatus(accountId), "limited");
});

test("ACP stream emits text deltas before session/prompt resolves", async () => {
  await reset([TWO_PROFILES[0]]);
  let finishPrompt;
  let promptResolved = false;
  const { client } = fakeClient({ prompt: () => new Promise(resolve => { finishPrompt = result => { promptResolved = true; resolve(result); }; }) });
  const response = await executeAntigravityAcp({ body: { ...BODY, stream: true }, createClient: async () => client });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const roleChunk = decoder.decode((await reader.read()).value);
  assert.match(roleChunk, /"delta":\{"role":"assistant"\}/);
  const contentChunk = decoder.decode((await reader.read()).value);
  assert.match(contentChunk, /"content":"answer"/);
  assert.equal(promptResolved, false, "the chunk is delivered while the ACP prompt is still pending");
  finishPrompt({ stopReason: "end_turn" });
  const finalChunk = decoder.decode((await reader.read()).value);
  assert.match(finalChunk, /"finish_reason":"stop"/);
  assert.match(finalChunk, /data: \[DONE\]/);
  assert.equal((await reader.read()).done, true);
});

test("abort during initialize or session setup never dispatches a prompt", async () => {
  for (const stage of ["initialize", "session"]) {
    await reset([TWO_PROFILES[0]]);
    const controller = new AbortController();
    let release;
    const { client, calls } = fakeClient({
      initialize: stage === "initialize" ? () => new Promise(resolve => { release = resolve; }) : undefined,
      session: stage === "session" ? () => new Promise(resolve => { release = resolve; }) : undefined,
    });
    const pending = executeAntigravityAcp({ body: { ...BODY, stream: true }, signal: controller.signal, createClient: async () => client });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    release(stage === "initialize" ? { protocolVersion: 1 } : { sessionId: "session-1" });
    const response = await pending;
    assert.equal(response.status, 499, `${stage} abort is returned before an SSE prompt starts`);
    assert.equal(calls.some(([name]) => name === "prompt"), false);
    assert.equal(calls.some(([name]) => name === "close"), true);
  }
});

test("abort after stream starts cancels session and closes worker transport", async () => {
  await reset([TWO_PROFILES[0]]);
  const controller = new AbortController();
  let releasePrompt;
  const { client, calls } = fakeClient({
    prompt: () => new Promise(resolve => { releasePrompt = resolve; }),
    cancel: async () => releasePrompt({ stopReason: "cancelled" }),
  });
  const response = await executeAntigravityAcp({ body: { ...BODY, stream: true }, signal: controller.signal, createClient: async () => client });
  const reader = response.body.getReader();
  await reader.read(); // assistant role
  await reader.read(); // first text delta
  controller.abort();
  const terminal = new TextDecoder().decode((await reader.read()).value);
  assert.match(terminal, /acp_turn_cancelled/);
  assert.match(terminal, /\[DONE\]/);
  assert.equal((await reader.read()).done, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.find(([name]) => name === "cancel"), ["cancel", { sessionId: "session-1" }]);
  assert.equal(calls.some(([name]) => name === "close"), true);
});

test("stream errors terminate with an OpenAI error frame and never replay", async () => {
  await reset(TWO_PROFILES);
  const seen = [];
  const { client } = fakeClient({ prompt: async () => { throw Object.assign(new Error("secret account detail"), { code: -32000 }); } });
  const response = await executeAntigravityAcp({ body: { ...BODY, stream: true }, createClient: async workerId => { seen.push(workerId); return client; } });
  const reader = response.body.getReader();
  await reader.read();
  await reader.read();
  const terminal = new TextDecoder().decode((await reader.read()).value);
  assert.match(terminal, /acp_outcome_unknown/);
  assert.match(terminal, /\[DONE\]/);
  assert.doesNotMatch(terminal, /secret account detail/);
  assert.deepEqual(seen, [W1]);
});

test("unsupported tools and generation options fail before any worker starts", async () => {
  await reset([TWO_PROFILES[0]]);
  let started = false;
  const createClient = async () => { started = true; return fakeClient().client; };
  for (const body of [{ ...BODY, tools: [{ type: "function", function: { name: "x" } }] }, { ...BODY, temperature: 0.2 }]) {
    const response = await executeAntigravityAcp({ body, createClient });
    assert.equal(response.status, 400);
  }
  assert.equal(started, false);
});

test("unsupported ACP protocol version fails closed without advancing workers", async () => {
  await reset(TWO_PROFILES);
  const seen = [];
  const response = await executeAntigravityAcp({ body: BODY, createClient: async (namespace) => {
    seen.push(namespace);
    return fakeClient({ initialize: async () => ({ protocolVersion: 2 }) }).client;
  } });
  assert.equal(response.status, 502);
  assert.deepEqual(seen, [W1]);
  assert.match(await response.text(), /acp_protocol_version/);
});

test("chat gateway intercepts ACP before generic route fallback", async () => {
  await reset([TWO_PROFILES[0]]);
  const { client } = fakeClient();
  let started = false;
  setAntigravityAcpTransportFactory(async () => { started = true; return client; });
  const context = {
    header() {},
    get() { return null; },
    req: { json: async () => ({ ...BODY, stream: true }), header() { return undefined; }, raw: { signal: undefined } },
  };
  try {
    const response = await handleChat(context);
    assert.equal(response.status, 200);
    assert.equal(started, true);
    assert.match(response.headers.get("Content-Type"), /^text\/event-stream/);
    const streamed = await response.text();
    assert.match(streamed, /"content":"answer"/);
    assert.match(streamed, /data: \[DONE\]/);
  } finally {
    setAntigravityAcpTransportFactory(null);
  }
});

test("unknown session bootstrap error fails closed without using message text for failover", async () => {
  await reset(TWO_PROFILES);
  const seen = [];
  const client = fakeClient({ session: async () => { throw Object.assign(new Error("auth required"), { code: -31999 }); } }).client;
  const response = await executeAntigravityAcp({ body: BODY, createClient: async (workerId) => { seen.push(workerId); return client; } });
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.deepEqual(seen, [W1]);
  assert.match(text, /acp_session_failed/);
  assert.doesNotMatch(text, /auth required/);
  assert.equal(getAntigravityAcpProfileStatus(ID1), "unavailable");
});

test("only coded pre-prompt authentication failure advances to another worker", async () => {
  await reset(TWO_PROFILES);
  const seen = [];
  const response = await executeAntigravityAcp({ body: BODY, createClient: async (namespace) => {
    seen.push(namespace);
    if (namespace === W1) {
      const { client } = fakeClient({ initialize: async () => { throw Object.assign(new Error("secret detail"), { code: -32000 }); } });
      return client;
    }
    return fakeClient().client;
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [W1, W2]);
  assert.equal(getAntigravityAcpProfileStatus(ID1), "needs_login");
});

test("real transport error mapping retries only pre-prompt auth and never retries prompt auth", async () => {
  await reset(TWO_PROFILES);
  const started = [];
  const clientFactory = (workerId, options) => createAntigravityAcpClient(workerId, transportOptions => new AntigravityAcpTransport({
    ...transportOptions,
    timeoutMs: 500,
    spawnFn: () => {
      started.push(workerId);
      return protocolFixture({ authAt: workerId === W1 ? "initialize" : null });
    },
  }), options);
  const response = await executeAntigravityAcp({ body: BODY, createClient: clientFactory });
  assert.equal(response.status, 200);
  assert.deepEqual(started, [W1, W2]);
  assert.equal((await response.json()).choices[0].message.content, "fixture answer");
  assert.equal(getAntigravityAcpProfileStatus(ID1), "needs_login");

  await reset(TWO_PROFILES);
  started.length = 0;
  const promptErrorFactory = (workerId, options) => createAntigravityAcpClient(workerId, transportOptions => new AntigravityAcpTransport({
    ...transportOptions,
    timeoutMs: 500,
    spawnFn: () => {
      started.push(workerId);
      return protocolFixture({ authAt: "prompt-error" });
    },
  }), options);
  const promptError = await executeAntigravityAcp({ body: BODY, createClient: promptErrorFactory });
  const errorText = await promptError.text();
  assert.equal(promptError.status, 502);
  assert.deepEqual(started, [W1]);
  assert.match(errorText, /acp_outcome_unknown/);
  assert.doesNotMatch(errorText, /private fixture detail/);
});

test("client abort sends ACP v1 session/cancel and does not select another worker", async () => {
  await reset(TWO_PROFILES);
  const controller = new AbortController();
  let finishPrompt;
  const { client, calls } = fakeClient({
    prompt: () => new Promise((resolve) => { finishPrompt = resolve; }),
    cancel: async ({ sessionId }) => finishPrompt?.({ stopReason: "cancelled", sessionId }),
  });
  const seen = [];
  const pending = executeAntigravityAcp({ body: BODY, signal: controller.signal, createClient: async (namespace) => { seen.push(namespace); return client; } });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.deepEqual(seen, [W1]);
  assert.deepEqual(calls.find(([name]) => name === "cancel"), ["cancel", { sessionId: "session-1" }]);
});

test("prompt failure is ambiguous and never replays to another worker", async () => {
  await reset(TWO_PROFILES);
  const seen = [];
  const { client, calls } = fakeClient({ prompt: async () => { throw Object.assign(new Error("private account message"), { code: -32000 }); } });
  const response = await executeAntigravityAcp({ body: BODY, createClient: async (namespace) => { seen.push(namespace); return client; } });
  const text = await response.text();
  assert.equal(response.status, 502);
  assert.deepEqual(seen, [W1]);
  assert.match(text, /acp_outcome_unknown/);
  assert.doesNotMatch(text, /private account message/);
  assert.equal(calls.some(([name]) => name === "cancel"), false);
});
