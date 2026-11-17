import fs from "node:fs";
import {
  createProxyPool,
  updateProxyPoolEntry,
  testProxyPool,
  listProxyPools,
  setProxyRotationStrategy,
  maskProxyUrl,
} from "../src/services/proxyPools.js";
import { getProxyPools } from "../src/db/index.js";

function parseEnv(envPath) {
  const content = fs.readFileSync(envPath, "utf-8");
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

async function main() {
  const envPath = "/home/adila/Documents/Development/warp-proxy-pool/.env";
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }
  const env = parseEnv(envPath);
  const user = env.PROXY_USER || "warpuser";
  const pass = env.PROXY_PASS;
  if (!pass) {
    throw new Error("PROXY_PASS missing from warp-proxy-pool .env");
  }
  const poolSize = Number(env.POOL_SIZE || 10);
  const baseHttpPort = Number(env.HTTP_PORT || 3128);
  const rotateUrl = env.ENABLE_ROTATE_API === "true" ? `http://127.0.0.1:${env.ROTATE_API_PORT || 8405}/rotate` : null;
  const rotateToken = env.ROTATE_API_TOKEN || null;

  console.log(`Setting up ${poolSize} per-node lanes from base port ${baseHttpPort + 1}..${baseHttpPort + poolSize}...`);

  const existingPools = getProxyPools();
  const poolByName = new Map(existingPools.map((p) => [p.name, p]));

  // 1. Setup warp-gate (optional single LB port, disabled by default)
  const gateName = "warp-gate";
  const gateUrl = `http://${user}:${pass}@127.0.0.1:${baseHttpPort}`;
  let gateEntry = poolByName.get(gateName);
  if (gateEntry) {
    updateProxyPoolEntry({
      id: gateEntry.id,
      name: gateName,
      url: gateUrl,
      kind: "gateway",
      retry_budget: 3,
      rotate_url: rotateUrl,
      rotate_token: rotateToken,
      is_active: 0,
    });
  } else {
    gateEntry = createProxyPool({
      name: gateName,
      url: gateUrl,
      kind: "gateway",
      retry_budget: 3,
      rotate_url: rotateUrl,
      rotate_token: rotateToken,
    });
    updateProxyPoolEntry({ id: gateEntry.id, is_active: 0 });
  }
  console.log(`Registered ${gateName} (${maskProxyUrl(gateUrl)}) [is_active=0]`);

  // 2. Setup 10 per-node lanes
  const results = [];
  for (let i = 1; i <= poolSize; i++) {
    const name = `warp-node-${i}`;
    const port = baseHttpPort + i;
    const url = `http://${user}:${pass}@127.0.0.1:${port}`;
    let entry = poolByName.get(name);
    if (entry) {
      updateProxyPoolEntry({
        id: entry.id,
        name,
        url,
        kind: "single",
        retry_budget: 1,
        rotate_url: rotateUrl,
        rotate_token: rotateToken,
        is_active: 1,
      });
    } else {
      entry = createProxyPool({
        name,
        url,
        kind: "single",
        retry_budget: 1,
        rotate_url: rotateUrl,
        rotate_token: rotateToken,
      });
    }

    // Test proxy connectivity
    const testRes = await testProxyPool(entry.id);
    results.push({
      id: entry.id,
      name,
      port,
      maskedUrl: maskProxyUrl(url),
      ok: testRes.ok,
      ms: testRes.ms,
      error: testRes.error,
    });
    console.log(`Lane ${name}: port ${port} -> ${testRes.ok ? `OK (${testRes.ms}ms)` : `FAILED (${testRes.error})`}`);
  }

  // 3. Enable proxy rotation for opencode
  setProxyRotationStrategy("opencode", "round_robin");
  console.log("Configured proxy_rotation:opencode -> round_robin");

  const finalPools = listProxyPools();
  console.log(`\nAll Proxy Pools in Zenith Router (${finalPools.length} total):`);
  for (const p of finalPools) {
    console.log(`- #${p.id} ${p.name}: ${p.maskedUrl} (kind=${p.kind}, active=${p.is_active}, test_ok=${p.last_test_ok}, ms=${p.last_test_ms})`);
  }
}

main().catch((err) => {
  console.error("Error setting up warp lanes:", err.message);
  process.exit(1);
});
