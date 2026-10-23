import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";
import { setSetting, getSetting } from "../src/services/settings.js";
import {
  acquireAccountSlot,
  resolveProviderConcurrency,
  resetTrafficGuardState,
} from "../src/services/trafficGuard.js";

function form(data) {
  return new URLSearchParams(data);
}

function setup(settings = {}) {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("traffic_guard_enabled", "true");
  setSetting("request_jitter_enabled", "false");
  setSetting("max_account_concurrency", "8");
  setSetting("provider_throttle_ms:deepseek-web", "0");
  for (const [key, value] of Object.entries(settings)) setSetting(key, value);
}

const account = (id, provider = "deepseek-web") => ({ id, provider, auth_type: "session" });

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("provider concurrency - a per-account cap of 3 holds the fourth request", async () => {
  setup({ "provider_concurrency:deepseek-web": "3" });
  const conn = account(301);

  const held = [];
  for (let i = 0; i < 3; i++) held.push(await acquireAccountSlot(conn));

  let fourthAcquired = false;
  const fourth = acquireAccountSlot(conn).then((release) => {
    fourthAcquired = true;
    return release;
  });
  await tick();
  assert.strictEqual(fourthAcquired, false, "the fourth request must wait at the cap of 3");

  held[0]();
  const releaseFourth = await fourth;
  assert.strictEqual(fourthAcquired, true, "releasing a slot hands it to the waiter");

  held[1]();
  held[2]();
  releaseFourth();
});

test("provider concurrency - the cap is per account, not per provider", async () => {
  setup({ "provider_concurrency:deepseek-web": "3" });

  const first = account(302);
  const second = account(303);
  const heldFirst = [];
  const heldSecond = [];
  for (let i = 0; i < 3; i++) heldFirst.push(await acquireAccountSlot(first));
  // The second account has its own three slots; none of these may queue.
  for (let i = 0; i < 3; i++) heldSecond.push(await acquireAccountSlot(second));

  let queued = false;
  const extra = acquireAccountSlot(first).then((release) => {
    queued = true;
    return release;
  });
  await tick();
  assert.strictEqual(queued, false, "the first account is still at its own cap");

  heldFirst[0]();
  const releaseExtra = await extra;
  assert.strictEqual(queued, true);

  heldFirst[1]();
  heldFirst[2]();
  heldSecond.forEach((release) => release());
  releaseExtra();
});

test("provider concurrency - a main request overtakes a queued auxiliary request", async () => {
  setup({ "provider_concurrency:test-provider": "1" });
  const conn = account(304, "test-provider");

  const held = await acquireAccountSlot(conn);

  const order = [];
  const aux = acquireAccountSlot(conn, null, { purpose: "aux" }).then((release) => {
    order.push("aux");
    return release;
  });
  await tick(5);
  const main = acquireAccountSlot(conn, null, { purpose: "main" }).then((release) => {
    order.push("main");
    return release;
  });
  await tick(5);

  held();
  const releaseMain = await main;
  assert.deepStrictEqual(order, ["main"], "main jumps ahead of the aux waiter");

  releaseMain();
  const releaseAux = await aux;
  assert.deepStrictEqual(order, ["main", "aux"]);
  releaseAux();
});

test("provider concurrency - an auxiliary request gives up after 2s instead of holding the queue", async (t) => {
  setup({ "provider_concurrency:test-provider": "1" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const conn = account(305, "test-provider");

  const held = await acquireAccountSlot(conn);
  const aux = acquireAccountSlot(conn, null, { purpose: "aux" });
  const rejected = assert.rejects(aux, /Auxiliary request gave up/);

  t.mock.timers.tick(2000);
  await rejected;
  held();
});

test("provider concurrency - an aborted auxiliary waiter leaves the queue", async () => {
  setup({ "provider_concurrency:test-provider": "1" });
  const conn = account(306, "test-provider");
  const held = await acquireAccountSlot(conn);

  const controller = new AbortController();
  const aux = acquireAccountSlot(conn, controller.signal, { purpose: "aux" });
  const rejected = assert.rejects(aux, /aborted/);
  controller.abort();
  await rejected;

  // The slot still passes to the next request, not to the removed waiter.
  const next = acquireAccountSlot(conn);
  let acquired = false;
  next.then(() => (acquired = true));
  held();
  const releaseNext = await next;
  assert.strictEqual(acquired, true);
  releaseNext();
});

test("provider concurrency - resolution order is setting, then registry, then global", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  setSetting("request_jitter_enabled", "false");
  setSetting("traffic_guard_enabled", "true");

  assert.strictEqual(resolveProviderConcurrency("unknown-provider"), null, "no setting and no registry field");

  setSetting("provider_concurrency:unknown-provider", "4");
  assert.strictEqual(resolveProviderConcurrency("unknown-provider"), 4);

  setSetting("provider_concurrency:unknown-provider", "99");
  assert.strictEqual(resolveProviderConcurrency("unknown-provider"), 10, "values above the maximum are clamped");

  setSetting("provider_concurrency:unknown-provider", "0");
  assert.strictEqual(resolveProviderConcurrency("unknown-provider"), null, "invalid values fall through");

  setSetting("provider_concurrency:unknown-provider", "abc");
  assert.strictEqual(resolveProviderConcurrency("unknown-provider"), null);
});

test("provider concurrency - a provider without its own cap keeps the global cap", async () => {
  setup({ max_account_concurrency: "1" });
  const conn = account(307, "no-cap-provider");

  const held = await acquireAccountSlot(conn);
  let secondAcquired = false;
  const second = acquireAccountSlot(conn).then((release) => {
    secondAcquired = true;
    return release;
  });
  await tick();
  assert.strictEqual(secondAcquired, false);

  held();
  const releaseSecond = await second;
  assert.strictEqual(secondAcquired, true);
  releaseSecond();
});

test("provider detail page renders the per-account concurrency form", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers/glm")).text();

  assert.ok(html.includes('action="/dashboard/providers/concurrency"'), "form posts to the concurrency route");
  assert.ok(html.includes('name="concurrency"'), "input is named concurrency");
  assert.ok(html.includes('min="1" max="10"'), "input is bounded to 1..10");
  assert.ok(html.includes("Batas Sesi Paralel"), "card has a title");
});

test("POST /dashboard/providers/concurrency - stores, validates, and clears the cap", async () => {
  initDb(":memory:");

  let res = await app.request("/dashboard/providers/concurrency", {
    method: "POST",
    body: form({ provider: "glm", concurrency: "5" }),
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/glm?notice=concurrency_updated");
  assert.strictEqual(getSetting("provider_concurrency:glm"), "5");

  res = await app.request("/dashboard/providers/concurrency", {
    method: "POST",
    body: form({ provider: "glm", concurrency: "11" }),
  });
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/glm?notice=concurrency_invalid");
  assert.strictEqual(getSetting("provider_concurrency:glm"), "5", "an invalid value keeps the old cap");

  res = await app.request("/dashboard/providers/concurrency", {
    method: "POST",
    body: form({ provider: "glm", concurrency: "0" }),
  });
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/glm?notice=concurrency_invalid");

  res = await app.request("/dashboard/providers/concurrency", {
    method: "POST",
    body: form({ provider: "glm", concurrency: "" }),
  });
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/glm?notice=concurrency_updated");
  assert.strictEqual(getSetting("provider_concurrency:glm", ""), "", "an empty value removes the setting");

  res = await app.request("/dashboard/providers/concurrency", {
    method: "POST",
    body: form({ provider: "not-a-provider", concurrency: "3" }),
  });
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers");
});
