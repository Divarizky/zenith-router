import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/index.js";
import { initDb, addProxyPool } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { setCustomExecutor } from "../src/executors/base.js";
import {
  getOpencodeHybridEgressConfig,
  getProtonPoolReadiness,
  markProxyPoolExhausted,
  planOpencodeHybridEntries,
  planProxyRotationEntries,
  resetProtonReadinessSnapshot,
  resetProxyPoolExhausted,
  resetProxyRotation,
  setWarpReadinessSnapshot,
  setProxyRotationStrategy,
  syncProtonReadiness,
} from "../src/services/proxyPools.js";

function seed() {
  initDb(":memory:");
  resetProxyRotation();
  resetProtonReadinessSnapshot();
  resetProxyPoolExhausted();
  setSetting("opencode_egress_mode", "off");
  setSetting("opencode_egress_registry", "{}");
  setSetting("opencode_proxy_pool_ids", "[]");
}

function configure(mode, entries, scope = Object.keys(entries).map(Number)) {
  setSetting("opencode_egress_mode", mode);
  setSetting("opencode_egress_registry", JSON.stringify(entries));
  setSetting("opencode_proxy_pool_ids", JSON.stringify(scope));
  setSetting("opencode_proton_probe_url", "https://probe.test/ip");
}

function chat() {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "opencode/big-pickle", messages: [{ role: "user", content: "hi" }] }),
  });
}

function transportFailure() {
  return new Response(JSON.stringify({ error: { type: "transport_error", message: "fixture transport failure" } }), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
}

function ok() {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("shadow mengecualikan Proton dari planner lama selama 12 request round-robin", () => {
  seed();
  const pools = [];
  for (let i = 1; i <= 12; i++) {
    pools.push(addProxyPool({ name: `pool-${i}`, url: `http://pool-${i}.local:3128` }));
  }
  const warp = pools[1];
  const proton = pools[11];
  const scope = pools.slice(1).map((pool) => pool.id);
  configure("shadow", {
    [warp.id]: { adapter: "warp", lane: 1 },
    [proton.id]: { adapter: "proton", lane: "proton" },
  }, scope);

  for (let request = 0; request < 12; request++) {
    const plan = planProxyRotationEntries("opencode", "round_robin", scope);
    assert.ok(plan.every((entry) => entry.id !== proton.id), `Proton tidak boleh muncul pada request ke-${request + 1}`);
  }
});

test("shadow valid dengan scope WARP-only dan tetap memprobe Proton di luar scope", async () => {
  seed();
  const warp = addProxyPool({ name: "warp", url: "http://warp.local:3128" });
  const proton = addProxyPool({ name: "proton", url: "http://proton.local:3129" });
  configure("shadow", {
    [warp.id]: { adapter: "warp", lane: 1 },
    [proton.id]: { adapter: "proton", lane: "proton" },
  }, [warp.id]);

  const config = getOpencodeHybridEgressConfig();
  assert.equal(config.valid, true);
  assert.deepEqual(config.entries.map((entry) => entry.poolId), [warp.id]);

  const probed = [];
  await syncProtonReadiness({
    now: 1000,
    probeFn: async (pool) => {
      probed.push(pool.id);
      return new Response("198.51.100.20");
    },
  });
  assert.deepEqual(probed, [proton.id]);
  assert.equal(getProtonPoolReadiness(proton.id, 1000).ready, true);
});

test("hybrid enforce tetap invalid bila Proton registry berada di luar scope WARP-only", () => {
  seed();
  const warp = addProxyPool({ name: "warp", url: "http://warp.local:3128" });
  const proton = addProxyPool({ name: "proton", url: "http://proton.local:3129" });
  configure("enforce", {
    [warp.id]: { adapter: "warp", lane: 1 },
    [proton.id]: { adapter: "proton", lane: "proton" },
  }, [warp.id]);

  const config = getOpencodeHybridEgressConfig();
  assert.equal(config.valid, false);
  assert.match(config.errors.join(" "), /berada di luar scope OpenCode/);
});

test("hybrid enforce memvalidasi scope dan tidak fallback direct saat invalid", async () => {
  seed();
  const pool = addProxyPool({ name: "arbitrary-name", url: "http://warp.local:3128" });
  configure("enforce", { [pool.id]: { adapter: "warp", lane: 1 } }, [pool.id, 999]);
  assert.equal(getOpencodeHybridEgressConfig().valid, false);

  let dispatches = 0;
  setCustomExecutor({ async execute() { dispatches++; return ok(); } });
  try {
    const response = await chat();
    assert.equal(response.status, 503);
  } finally {
    setCustomExecutor(null);
  }
  assert.equal(dispatches, 0);
});

test("hybrid memakai mapping lane eksplisit dan Proton stale tidak eligible", async () => {
  seed();
  const warp = addProxyPool({ name: "not-a-warp-name", url: "http://warp.local:3128" });
  const proton = addProxyPool({ name: "not-a-proton-name", url: "http://proton.local:3129" });
  configure("enforce", {
    [warp.id]: { adapter: "warp", lane: 2 },
    [proton.id]: { adapter: "proton", lane: "proton" },
  });
  setWarpReadinessSnapshot({ fresh: true, nodes: [{ node: 2, ready: true, state: "ready" }] }, 1000);
  await syncProtonReadiness({ now: 1000, probeFn: async () => new Response("198.51.100.7") });
  assert.deepEqual(planOpencodeHybridEntries("round_robin", 1000).map((entry) => entry.id), [warp.id, proton.id]);
  setWarpReadinessSnapshot({ fresh: true, nodes: [{ node: 2, ready: true, state: "ready" }] }, 181000);
  assert.equal(getProtonPoolReadiness(proton.id, 181001).stale, true);
  assert.deepEqual(planOpencodeHybridEntries("round_robin", 181001).map((entry) => entry.id), [warp.id]);
});

test("hybrid mencoba dua WARP lalu Proton setelah transport failure", async () => {
  seed();
  const w1 = addProxyPool({ name: "one", url: "http://w1.local:3128" });
  const w2 = addProxyPool({ name: "two", url: "http://w2.local:3128" });
  const proton = addProxyPool({ name: "three", url: "http://p.local:3128" });
  configure("enforce", {
    [w1.id]: { adapter: "warp", lane: 1 },
    [w2.id]: { adapter: "warp", lane: 2 },
    [proton.id]: { adapter: "proton", lane: "proton" },
  });
  setProxyRotationStrategy("opencode", "round_robin");
  setWarpReadinessSnapshot({ fresh: true, nodes: [{ node: 1, ready: true, state: "ready" }, { node: 2, ready: true, state: "ready" }] });
  await syncProtonReadiness({ probeFn: async () => new Response("203.0.113.8") });

  const calls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calls.push(proxyUrl);
      return calls.length < 3 ? transportFailure() : ok();
    },
  });
  try {
    const response = await chat();
    assert.equal(response.status, 200);
  } finally {
    setCustomExecutor(null);
  }
  assert.deepEqual(calls, [w1.url, w2.url, proton.url]);
});

test("hybrid memakai Proton saat semua lane WARP exhausted", async () => {
  seed();
  const warpOne = addProxyPool({ name: "warp-one", url: "http://w1.local:3128" });
  const warpTwo = addProxyPool({ name: "warp-two", url: "http://w2.local:3128" });
  const proton = addProxyPool({ name: "proton-only", url: "http://p.local:3128" });
  configure("enforce", {
    [warpOne.id]: { adapter: "warp", lane: 1 },
    [warpTwo.id]: { adapter: "warp", lane: 2 },
    [proton.id]: { adapter: "proton", lane: "proton" },
  });
  setProxyRotationStrategy("opencode", "round_robin");
  setWarpReadinessSnapshot({ fresh: true, nodes: [
    { node: 1, ready: true, state: "ready" },
    { node: 2, ready: true, state: "ready" },
  ]});
  await syncProtonReadiness({ probeFn: async () => new Response("203.0.113.10") });
  const until = Date.now() + 60000;
  markProxyPoolExhausted(warpOne.id, until);
  markProxyPoolExhausted(warpTwo.id, until);
  assert.deepEqual(planOpencodeHybridEntries("round_robin").map((entry) => entry.id), [proton.id]);

  const calls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calls.push(proxyUrl);
      return ok();
    },
  });
  try {
    const response = await chat();
    assert.equal(response.status, 200);
  } finally {
    setCustomExecutor(null);
  }
  assert.deepEqual(calls, [proton.url]);
});

test("hybrid tidak melompati upstream 429 ke Proton", async () => {
  seed();
  const warp = addProxyPool({ name: "warp", url: "http://w.local:3128" });
  const proton = addProxyPool({ name: "proton", url: "http://p.local:3128" });
  configure("enforce", {
    [warp.id]: { adapter: "warp", lane: 1 },
    [proton.id]: { adapter: "proton", lane: "proton" },
  });
  setProxyRotationStrategy("opencode", "round_robin");
  setWarpReadinessSnapshot({ fresh: true, nodes: [{ node: 1, ready: true, state: "ready" }] });
  await syncProtonReadiness({ probeFn: async () => new Response("203.0.113.9") });
  const calls = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calls.push(proxyUrl);
      return new Response(JSON.stringify({ error: { message: "retry later" } }), { status: 429 });
    },
  });
  try {
    const response = await chat();
    assert.equal(response.status, 429);
  } finally {
    setCustomExecutor(null);
  }
  assert.deepEqual(calls, [warp.url]);
});
