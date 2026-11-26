import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, chmod, writeFile, rm, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { renderAgyAccountsCard } from "../src/ui/pages/agyLogin.js";
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
import { getAntigravityAcpWorker, getAntigravityAcpWorkers, workerRuntimeEnv, setAntigravityAcpWorkerLoaderForTests, setAntigravityAcpAutoDiscoveryForTests, setAntigravityAcpProvisionRootForTests } from "../src/services/antigravityAcp/workers.js";
import { createAntigravityAcpClient } from "../src/services/antigravityAcp/client.js";

test("rendered ACP login script starts a new account when clicked", async () => {
  const html = renderAgyAccountsCard({ accounts: [] });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const calls = [];
  const box = { hidden: true, innerHTML: "", children: [], appendChild(n) { this.children.push(n); } };
  const elements = { "agy-acp-login": box, "agy-acp-submit": {}, "agy-acp-cancel": {} };
  const popup = { closed: false, close() {} };
  const window = { open: () => popup };
  runInNewContext(script, {
    window,
    document: { getElementById: (id) => elements[id], createElement: () => ({}) },
    setInterval: () => 0, clearInterval() {}, location: { assign() {}, pathname: "/" },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ attemptId: "attempt", authorizationUrl: "https://accounts.google.com/o/oauth2/auth?state=test" }) };
    },
    URL, URLSearchParams,
    alert: () => { throw new Error("unexpected login error"); },
  });
  window.zrAgyAcpLogin("", { dataset: { placeholder: "code", submit: "submit" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{ url: "/dashboard/providers/antigravity-acp/login/start", body: {} }]);
  assert.equal(box.hidden, false);
  assert.equal(popup.location, "https://accounts.google.com/o/oauth2/auth?state=test");
  // DOM is built with textContent/properties, never innerHTML with server data.
  assert.equal(box.children.find((n) => n.href)?.href, "https://accounts.google.com/o/oauth2/auth?state=test");
});

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
      else if (message.method === "session/new") response = { jsonrpc: "2.0", id: message.id, result: { sessionId: "fixture-session", configOptions: [{ id: "model", category: "model", type: "select", options: [{ value: "gemini-3.8-flash", name: "Flash" }] }] } };
      else if (message.method === "session/set_config_option") response = { jsonrpc: "2.0", id: message.id, result: {} };
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

function fakeClient({ initialize = async () => ({ protocolVersion: 1 }), session = async () => ({ sessionId: "session-1", configOptions: [{ id: "model", category: "model", type: "select", options: [{ value: "gemini-3.8-flash", name: "Flash" }] }] }), prompt = async () => ({ stopReason: "end_turn" }), cancel = async () => {}, update = null } = {}) {
  const calls = [];
  let updateListener = null;
  const client = {
    cwd: "/srv/zenith/workers/agy-account-1",
    initialize: async (params) => { calls.push(["initialize", params]); return initialize(params); },
    newSession: async (params) => { calls.push(["newSession", params]); return session(params); },
    setConfigOption: async (params) => { calls.push(["setConfigOption", params]); return {}; },
    setModel: async (params) => { calls.push(["setModel", params]); return {}; },
    prompt: async (params) => { calls.push(["prompt", params]); (updateListener || update)?.({ sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "answer" } } }); return prompt(params); },
    cancel: async (params) => { calls.push(["cancel", params]); return cancel(params); },
    onUpdate: (callback) => { updateListener = callback; return () => { updateListener = null; }; },
    close: async () => { calls.push(["close"]); },
  };
  return { client, calls };
}

test("one isolated worker is derived per account and unsafe binaries are rejected", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zenith-acp-autodiscovery-"));
  const binary = path.join(dir, "agy_acp_server");
  setAntigravityAcpWorkerLoaderForTests(null);
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
    assert.deepEqual(worker.launcherArgs, []);
    assert.deepEqual(worker.loginLauncherArgs, []); assert.equal(worker.loginMode, "acp-authenticate"); assert.equal(worker.authMethodId, "oauth-personal");
    assert.equal(worker.isolatedHome, path.join(provisionRoot, added.account.id, "home"));
    for (const dirPath of [worker.workspace, worker.isolatedHome]) {
      const info = await import("node:fs/promises").then(({ stat }) => stat(dirPath));
      assert.equal(info.mode & 0o777, 0o700);
    }
    assert.equal(worker.appData, path.join(provisionRoot, added.account.id, "appdata"));
    // Other-writable is never trusted.
    await chmod(binary, 0o707);
    assert.deepEqual(await getAntigravityAcpWorkers(), []);
    await chmod(binary, 0o702);
    assert.deepEqual(await getAntigravityAcpWorkers(), []);
    // Group-writable by this user's own primary group is the Linux default (umask 002) and is accepted.
    await chmod(binary, 0o775);
    assert.equal((await getAntigravityAcpWorkers()).length, 1, "own-group writable binary is accepted");
    await chmod(binary, 0o700);
    assert.equal((await realpath(binary)), binary);
  } finally {
    setAntigravityAcpAutoDiscoveryForTests(null);
    setAntigravityAcpProvisionRootForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a group-writable agy binary owned by a foreign group is rejected", async () => {
  const { stat, chown } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(os.tmpdir(), "zenith-acp-foreigngroup-"));
  const binary = path.join(dir, "agy_acp_server");
  setAntigravityAcpWorkerLoaderForTests(null);
  try {
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o770 });
    await chmod(binary, 0o770);
    // A supplementary group of the current user that is not its primary group, when one exists.
    const primary = process.getgid();
    const foreign = (process.getgroups?.() || []).find((g) => g !== primary);
    if (foreign === undefined) return; // no second group available on this host; nothing to prove
    await chown(binary, process.getuid(), foreign);
    assert.equal((await stat(binary)).gid, foreign);
    setAntigravityAcpProvisionRootForTests(path.join(dir, "root"));
    setAntigravityAcpAutoDiscoveryForTests([binary]);
    initDb(":memory:");
    await setAntigravityAcpProfiles([{ id: ID1, name: "one", enabled: true }]);
    assert.deepEqual(await getAntigravityAcpWorkers(), [], "foreign-group writable binary must fail closed");
  } finally {
    setAntigravityAcpAutoDiscoveryForTests(null);
    setAntigravityAcpProvisionRootForTests(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("auto-provisioning rejects symlinked provision roots without modifying their targets", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "zenith-acp-symlink-"));
  const binary = path.join(dir, "agy_acp_server");
  const victim = path.join(dir, "victim");
  const provisionRoot = path.join(dir, "provision-root");
  setAntigravityAcpWorkerLoaderForTests(null);
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
    command: "/test/agy-1", args: ["acp", "--stdio"], cwd: "/test/worker-1", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/test/isolated-home", GEMINI_HOME: "/test/isolated-home/.gemini", AGY_ACP_FORCE_FILE_STORAGE: "1", ...(process.platform === "linux" ? { DBUS_SESSION_BUS_ADDRESS: "disabled:", XDG_RUNTIME_DIR: "/test/isolated-home/run" } : {}) },
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
  assert.match(html, /accounts\/rename/);
  assert.match(html, /zrAgyAcpLogin\('', this\)/);
  assert.doesNotMatch(html, /accounts\/add|name="name" maxlength="40" required autocomplete="off" placeholder/);
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
  assert.equal(getProviderModels(getProvider("antigravity-acp")).length, 0); // no model is listed before discovery
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
  const binary = path.join(dir, "agy_acp_server");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(binary, 0o700);
  initDb(":memory:");
  resetAntigravityAcpRuntimeStateForTests();
  setAntigravityAcpClockForTests(null);
  setAntigravityAcpWorkerLoaderForTests(null);
  setAntigravityAcpAutoDiscoveryForTests([binary]);
  const root = path.join(dir, "acp");
  setAntigravityAcpProvisionRootForTests(root);
  try { await fn({ dir, root }); } finally {
    setAntigravityAcpAutoDiscoveryForTests(null);
    setAntigravityAcpProvisionRootForTests(null);
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
  assert.deepEqual(calls.slice(0, 4), [
    ["initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "zenith-router", version: pkg.version } }],
    ["newSession", { cwd: "/srv/zenith/workers/agy-account-1", mcpServers: [] }],
    ["setConfigOption", { sessionId: "session-1", configId: "model", value: "gemini-3.8-flash" }],
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

test("model catalog: configOptions has priority, legacy is fallback, nothing invented", async () => {
  const { parseSessionModelCatalog } = await import("../src/services/antigravityAcp/catalog.js");
  const both = parseSessionModelCatalog({
    configOptions: [{ id: "m", category: "model", type: "select", options: [{ value: "a", name: "A" }, { group: "g", options: [{ value: "b", name: "B" }] }] }],
    models: { availableModels: [{ modelId: "legacy" }] },
  });
  assert.equal(both.method, "config_option");
  assert.deepEqual(both.models.map((m) => m.id), ["a", "b"]);
  const legacy = parseSessionModelCatalog({ models: { availableModels: [{ modelId: "x", name: "X" }, { modelId: "x" }] } });
  assert.deepEqual(legacy, { method: "legacy", configId: null, models: [{ id: "x", name: "X" }] });
  assert.equal(parseSessionModelCatalog({ configOptions: [{ category: "mode", type: "select", id: "q", options: [] }] }), null);
  assert.equal(parseSessionModelCatalog({}), null);
});

test("requested model is selected via set_config_option before prompt; legacy uses set_model", async () => {
  await reset(TWO_PROFILES);
  const { client, calls } = fakeClient();
  const res = await executeAntigravityAcp({ body: BODY, createClient: async () => client });
  assert.equal(res.status, 200);
  const names = calls.map((c) => c[0]);
  assert.ok(names.indexOf("setConfigOption") > names.indexOf("newSession") && names.indexOf("setConfigOption") < names.indexOf("prompt"));
  assert.deepEqual(calls.find((c) => c[0] === "setConfigOption")[1], { sessionId: "session-1", configId: "model", value: "gemini-3.8-flash" });

  await reset(TWO_PROFILES);
  const legacy = fakeClient({ session: async () => ({ sessionId: "session-1", models: { availableModels: [{ modelId: "gemini-3.8-flash" }] } }) });
  assert.equal((await executeAntigravityAcp({ body: BODY, createClient: async () => legacy.client })).status, 200);
  const l = legacy.calls.map((c) => c[0]);
  assert.ok(l.includes("setModel") && l.indexOf("setModel") < l.indexOf("prompt"));
});

test("unsupported model or missing catalog never prompts; model is routed to the account that has it", async () => {
  await reset(TWO_PROFILES);
  const none = fakeClient();
  const res = await executeAntigravityAcp({ body: { ...BODY, model: "agy-acp/unknown" }, createClient: async () => none.client });
  assert.equal(res.status, 404);
  assert.ok(!none.calls.some((c) => c[0] === "prompt"));

  await reset(TWO_PROFILES);
  const bare = fakeClient({ session: async () => ({ sessionId: "session-1" }) });
  const r2 = await executeAntigravityAcp({ body: BODY, createClient: async () => bare.client });
  assert.equal(r2.status, 502);
  assert.ok(!bare.calls.some((c) => c[0] === "prompt" || c[0] === "setModel" || c[0] === "setConfigOption"));

  await reset(TWO_PROFILES);
  const first = fakeClient({ session: async () => ({ sessionId: "session-1", models: { availableModels: [{ modelId: "other" }] } }) });
  const second = fakeClient();
  const clients = { [W1]: first.client, [W2]: second.client };
  const r3 = await executeAntigravityAcp({ body: BODY, createClient: async (workerId) => clients[workerId] });
  assert.equal(r3.status, 200);
  assert.ok(!first.calls.some((c) => c[0] === "prompt"));
  assert.ok(second.calls.some((c) => c[0] === "prompt"));
});

test("catalog is merged into models, ignores logged-out accounts, and is invalidated on removal", async () => {
  const { recordAntigravityAcpAccountCatalog, getAntigravityAcpAccountCatalog, resetAntigravityAcpCatalogForTests } = await import("../src/services/antigravityAcp/catalog.js");
  const { listAntigravityAcpModels } = await import("../src/services/antigravityAcp/profiles.js");
  const { getProvider, getProviderModels } = await import("../src/providers/index.js");
  await reset(TWO_PROFILES);
  resetAntigravityAcpCatalogForTests();
  recordAntigravityAcpAccountCatalog(ID1, { models: { availableModels: [{ modelId: "m1" }, { modelId: "shared" }] } });
  recordAntigravityAcpAccountCatalog(ID2, { models: { availableModels: [{ modelId: "shared" }, { modelId: "m2" }] } });
  const root = await mkdtemp(path.join(os.tmpdir(), "zenith-acp-cat-"));
  setAntigravityAcpProvisionRootForTests(root);
  setAntigravityAcpWorkerLoaderForTests(null); // derived mode, no token files: logged out
  assert.deepEqual(listAntigravityAcpModels(), []);
  setAntigravityAcpProvisionRootForTests(null);
  await rm(root, { recursive: true, force: true });
  resetAntigravityAcpCatalogForTests(); // restart: reloaded from the store
  assert.ok(getAntigravityAcpAccountCatalog(ID1));
  setAntigravityAcpWorkerLoaderForTests(async () => []);
  assert.deepEqual(listAntigravityAcpModels().map((m) => m.id), ["m1", "shared", "m2"]);
  assert.deepEqual(getProviderModels(getProvider("antigravity-acp")).map((m) => m.id), ["m1", "shared", "m2"]);
  await setAntigravityAcpProfiles([TWO_PROFILES[1]]);
  assert.equal(getAntigravityAcpAccountCatalog(ID1), null);
  assert.deepEqual(listAntigravityAcpModels().map((m) => m.id), ["shared", "m2"]);
});

test("ACP stays in the oauth dashboard group without becoming OAuth or leaving noAuth/free", async () => {
  const { getProvider } = await import("../src/providers/index.js");
  const p = getProvider("antigravity-acp");
  assert.equal(p.noAuth, true);
  assert.equal(p.category, "free");
  await reset();
  const { renderProvidersPage } = await import("../src/ui/pages/providers.js");
  const html = renderProvidersPage(20120, {});
  const oauthAt = html.indexOf("OAuth Providers");
  const freeAt = html.indexOf("Free Tier Providers");
  const acpAt = html.indexOf("antigravity-acp");
  assert.ok(oauthAt >= 0 && acpAt > oauthAt && (freeAt < 0 || acpAt < freeAt || freeAt < oauthAt));
  const { getOAuthFlow } = await import("../src/services/oauth/providers.js");
  assert.equal(getOAuthFlow("antigravity-acp"), null);
});

test("catalog: empty model select is authoritative and clears stale catalog", async () => {
  const { parseSessionModelCatalog, recordAntigravityAcpAccountCatalog, getAntigravityAcpAccountCatalog, resetAntigravityAcpCatalogForTests } = await import("../src/services/antigravityAcp/catalog.js");
  await reset(TWO_PROFILES);
  resetAntigravityAcpCatalogForTests();
  const empty = parseSessionModelCatalog({ configOptions: [{ id: "m", category: "model", type: "select", options: [] }], models: { availableModels: [{ modelId: "legacy" }] } });
  assert.deepEqual(empty, { method: "config_option", configId: "m", models: [] });
  recordAntigravityAcpAccountCatalog(ID1, { models: { availableModels: [{ modelId: "old" }] } });
  assert.ok(getAntigravityAcpAccountCatalog(ID1));
  recordAntigravityAcpAccountCatalog(ID1, {}); // unrecognised: stale must go
  assert.equal(getAntigravityAcpAccountCatalog(ID1), null);
  recordAntigravityAcpAccountCatalog(ID1, { models: { availableModels: [{ modelId: "old" }] } });
  recordAntigravityAcpAccountCatalog(ID1, { configOptions: [{ id: "m", category: "model", type: "select", options: [] }] });
  assert.deepEqual(getAntigravityAcpAccountCatalog(ID1)?.models, []);
});

test("catalog cache follows underlying store changes", async () => {
  const { recordAntigravityAcpAccountCatalog, getAntigravityAcpAccountCatalog } = await import("../src/services/antigravityAcp/catalog.js");
  await reset(TWO_PROFILES);
  recordAntigravityAcpAccountCatalog(ID1, { models: { availableModels: [{ modelId: "m1" }] } });
  const { setSetting } = await import("../src/services/settings.js");
  setSetting("antigravity_acp_model_catalog", "{}");
  assert.equal(getAntigravityAcpAccountCatalog(ID1), null);
});

const sel = (values, id = "model") => ({ sessionId: "session-1", configOptions: [{ id, category: "model", type: "select", options: values.map((value) => ({ value, name: value })) }] });
const promptsOf = (c) => c.calls.filter((x) => x[0] === "prompt");

test("selection isolation: stale/unknown catalogs per account never prompt the wrong account", async () => {
  await reset(TWO_PROFILES);
  // Account 1 has only other-model (stale for our request), account 2 has the model but under another configId.
  const a = fakeClient({ session: async () => sel(["other-model"], "cfg-a") });
  const b = fakeClient({ session: async () => sel(["gemini-3.8-flash"], "cfg-b") });
  const clients = { [W1]: a.client, [W2]: b.client };
  const res = await executeAntigravityAcp({ body: BODY, createClient: async (id) => clients[id] });
  assert.equal(res.status, 200);
  assert.equal(promptsOf(a).length, 0);
  assert.ok(!a.calls.some((c) => c[0] === "setConfigOption"));
  assert.deepEqual(b.calls.find((c) => c[0] === "setConfigOption")[1], { sessionId: "session-1", configId: "cfg-b", value: "gemini-3.8-flash" });
  assert.equal(promptsOf(b).length, 1);

  // Account 1 now has a known (other) catalog, so it is skipped before any worker is started; unknown account 2 is still tried.
  const started = [];
  const b2 = fakeClient({ session: async () => sel(["gemini-3.8-flash"], "cfg-b") });
  const res2 = await executeAntigravityAcp({ body: BODY, createClient: async (id) => { started.push(id); return id === W2 ? b2.client : null; } });
  assert.equal(res2.status, 200);
  assert.deepEqual(started, [W2]);
});

test("selection isolation: empty model select is 404 with no select or prompt on any account", async () => {
  await reset(TWO_PROFILES);
  const a = fakeClient({ session: async () => sel([]) });
  const b = fakeClient({ session: async () => sel([]) });
  const clients = { [W1]: a.client, [W2]: b.client };
  const res = await executeAntigravityAcp({ body: BODY, createClient: async (id) => clients[id] });
  assert.equal(res.status, 404);
  for (const c of [a, b]) assert.ok(!c.calls.some((x) => ["prompt", "setConfigOption", "setModel"].includes(x[0])));
});

test("selection isolation: rejected or mismatched set_config_option never prompts and is not replayed", async () => {
  const cases = {
    rejected: async () => { throw Object.assign(new Error("nope"), { code: -32602 }); },
    mismatch: async () => ({ configOptions: [{ id: "model", currentValue: "other-model" }] }),
  };
  for (const [name, set] of Object.entries(cases)) {
    await reset(TWO_PROFILES);
    const a = fakeClient({ session: async () => sel(["gemini-3.8-flash"]) });
    a.client.setConfigOption = async (p) => { a.calls.push(["setConfigOption", p]); return set(); };
    const b = fakeClient({ session: async () => sel(["gemini-3.8-flash"]) });
    const clients = { [W1]: a.client, [W2]: b.client };
    const res = await executeAntigravityAcp({ body: BODY, createClient: async (id) => clients[id] });
    assert.equal(promptsOf(a).length, 0, name);
    assert.ok(promptsOf(b).length <= 1, name);
    if (res.status !== 200) assert.equal(promptsOf(b).length, 0, name);
    assert.ok(a.calls.some((x) => x[0] === "close"), name);
    assert.equal(promptsOf(a).length + promptsOf(b).length, res.status === 200 ? 1 : 0, name);
  }
});

test("workerRuntimeEnv isolates D-Bus session bus on Linux", () => {
  const env = workerRuntimeEnv({ isolatedHome: "/tmp/agy-test-home" });
  assert.equal(env.HOME, "/tmp/agy-test-home");
  assert.equal(env.GEMINI_HOME, path.join("/tmp/agy-test-home", ".gemini"));
  assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
  if (process.platform === "linux") {
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "disabled:");
    assert.equal(env.XDG_RUNTIME_DIR, path.join("/tmp/agy-test-home", "run"));
  }
});
