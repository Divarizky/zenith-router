import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { addConnection, getConnections, initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import {
  acquireAccountSlot,
  getConnectionTraffic,
  getProviderTraffic,
  resetTrafficGuardState,
} from "../src/services/trafficGuard.js";

function setup({ provider = "glm", cap = 2, accounts = 1 } = {}) {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "true");
  setSetting("request_jitter_enabled", "false");
  setSetting("max_account_concurrency", String(cap));
  for (let index = 0; index < accounts; index += 1) {
    addConnection({ provider, name: `Akun ${index + 1}`, credentials: { api_key: `key-${index}` } });
  }
  return getConnections(provider);
}

test("traffic - an idle provider reports zeros", () => {
  setup();
  assert.deepStrictEqual(getProviderTraffic("glm"), {
    provider: "glm",
    inFlight: 0,
    queue: 0,
    cap: 2,
    perAccountCap: 2,
    accounts: [{ id: 1, name: "Akun 1", inFlight: 0, queue: 0, cap: 2 }],
  });
  assert.deepStrictEqual(getProviderTraffic("tidak-ada"), {
    provider: "tidak-ada",
    inFlight: 0,
    queue: 0,
    cap: 0,
    perAccountCap: 0,
    accounts: [],
  });
});

test("traffic - a provider's cap follows the registry, not the global default", () => {
  setup({ provider: "deepseek-web", accounts: 1 });
  const traffic = getProviderTraffic("deepseek-web");

  assert.strictEqual(traffic.perAccountCap, 2, "deepseek-web declares concurrency: 2");
  assert.strictEqual(traffic.cap, 2);
});

test("traffic - in-flight and queued requests are visible per account and per provider", async () => {
  const [account] = setup({ cap: 2 });
  const releaseA = await acquireAccountSlot(account);
  const releaseB = await acquireAccountSlot(account);

  try {
    assert.deepStrictEqual(getConnectionTraffic(account.id), { inFlight: 2, queue: 0 });
    let traffic = getProviderTraffic("glm");
    assert.strictEqual(traffic.inFlight, 2);
    assert.strictEqual(traffic.queue, 0);

    let releaseC;
    const waiting = acquireAccountSlot(account).then((release) => {
      releaseC = release;
    });
    // The queue is populated before the waiter can be woken.
    await new Promise((resolve) => setTimeout(resolve, 10));
    traffic = getProviderTraffic("glm");
    assert.strictEqual(traffic.inFlight, 2, "the queued request has not started");
    assert.strictEqual(traffic.queue, 1);
    assert.strictEqual(traffic.accounts[0].queue, 1);

    releaseA();
    await waiting;
    traffic = getProviderTraffic("glm");
    assert.strictEqual(traffic.queue, 0, "the waiter took the released slot");
    assert.strictEqual(traffic.inFlight, 2, "a handed-over slot does not change the count");

    releaseC();
    releaseB();
  } finally {
    resetTrafficGuardState();
  }
});

test("traffic - multi-account providers aggregate slots and multiply the cap", async () => {
  const accounts = setup({ cap: 2, accounts: 2 });
  const releaseA = await acquireAccountSlot(accounts[0]);
  const releaseB = await acquireAccountSlot(accounts[1]);

  try {
    const traffic = getProviderTraffic("glm");
    assert.strictEqual(traffic.cap, 4, "two accounts with cap 2 each");
    assert.strictEqual(traffic.inFlight, 2);
    assert.deepStrictEqual(traffic.accounts.map((account) => account.inFlight), [1, 1]);
  } finally {
    releaseA();
    releaseB();
    resetTrafficGuardState();
  }
});

test("traffic - an aborted waiter leaves the queue", async () => {
  const [account] = setup({ cap: 1 });
  const release = await acquireAccountSlot(account);
  const controller = new AbortController();
  const waiting = acquireAccountSlot(account, controller.signal).catch((err) => err);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.strictEqual(getProviderTraffic("glm").queue, 1);

  controller.abort();
  const error = await waiting;
  assert.match(String(error?.message), /aborted/);
  assert.strictEqual(getProviderTraffic("glm").queue, 0);

  release();
  resetTrafficGuardState();
});

test("traffic - a per-provider setting is what the dashboard reports", () => {
  setup({ cap: 2 });
  setSetting("provider_concurrency:glm", "5");

  try {
    const traffic = getProviderTraffic("glm");
    assert.strictEqual(traffic.perAccountCap, 5);
    assert.strictEqual(traffic.cap, 5);
  } finally {
    resetTrafficGuardState();
  }
});

test("dashboard - the detail page shows slots in use, the cap, and the queue", async () => {
  const [account] = setup({ cap: 2 });
  const releases = [];

  try {
    let html = await (await app.request("/dashboard/providers/glm")).text();
    assert.ok(html.includes("0/2 dipakai"), "idle provider shows 0 of its cap");
    assert.ok(html.includes(">0/2<"), "the account row carries the same numbers");

    releases.push(await acquireAccountSlot(account));
    html = await (await app.request("/dashboard/providers/glm")).text();
    assert.ok(html.includes("1/2 dipakai"));
    assert.ok(html.includes(">1/2<"));

    releases.push(await acquireAccountSlot(account));
    const waiting = acquireAccountSlot(account).then((release) => releases.push(release));
    await new Promise((resolve) => setTimeout(resolve, 10));

    html = await (await app.request("/dashboard/providers/glm")).text();
    assert.ok(html.includes("2/2 dipakai"));
    assert.ok(html.includes("1 antre"), "the queue length is visible");
    assert.ok(html.includes("+1"), "the account row marks its own waiter");

    releases.pop()();
    await waiting;
  } finally {
    for (const release of releases) release();
    resetTrafficGuardState();
  }
});
