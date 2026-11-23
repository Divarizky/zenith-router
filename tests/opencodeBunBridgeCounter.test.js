import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { noProxyBypassesHost } from "../src/bridge/opencode-bridge.js";

function findBun() {
  const candidates = [process.env.BUN_BIN, join(homedir(), ".bun", "bin", "bun"), "bun"].filter(Boolean);
  for (const bin of candidates) {
    if (bin !== "bun" && !existsSync(bin)) continue;
    if (spawnSync(bin, ["--version"], { encoding: "utf8" }).status === 0) return bin;
  }
  return null;
}

const bun = findBun();
const skip = bun ? false : "bun tidak tersedia";

function runFixture(extraEnv) {
  const stdout = execFileSync(bun, ["tests/fixtures/bunBridgeCounter.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "", NO_PROXY: "", no_proxy: "", ...extraEnv },
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

test("Bun bridge: require-proxy delivers via proxy only, never direct", { skip }, () => {
  const out = runFixture({});

  assert.equal(out.success.status, 200);
  assert.equal(out.success.target, 1, "target menerima tepat satu pengiriman");
  assert.equal(out.success.proxy, 1, "pengiriman lewat proxy lokal");
  assert.equal(out.success.direct, 0, "tidak ada pengiriman direct");

  assert.equal(out.proxyDown.status, 502);
  assert.equal(out.proxyDown.proxyDelta, 1, "proxy dicoba");
  assert.equal(out.proxyDown.targetDelta, 0, "target tidak tersentuh saat proxy gagal");
  assert.equal(out.proxyDown.directDelta, 0, "tidak ada fallback direct");

  assert.equal(out.missingProxy.status, 503);
  assert.equal(out.missingProxy.proxyDelta, 0);
  assert.equal(out.missingProxy.targetDelta, 0, "tanpa proxy: nol panggilan ke target");
});

test("Bun bridge: NO_PROXY tidak boleh membuat require-proxy bocor direct", { skip }, () => {
  for (const noProxy of ["*", "127.0.0.1"]) {
    const out = runFixture({ NO_PROXY: noProxy });
    for (const phase of ["success", "proxyDown"]) {
      assert.equal(out[phase].status, 503, `NO_PROXY=${noProxy} ${phase}: ditolak lokal`);
    }
    assert.equal(out.success.target, 0, `NO_PROXY=${noProxy}: nol pengiriman ke target`);
    assert.equal(out.success.direct, 0, `NO_PROXY=${noProxy}: nol pengiriman direct`);
    assert.equal(out.proxyDown.targetDelta, 0);
    assert.equal(out.proxyDown.directDelta, 0);
  }
});

test("noProxyBypassesHost mencocokkan wildcard, host persis, dan subdomain", () => {
  assert.equal(noProxyBypassesHost("opencode.ai", { NO_PROXY: "" }), false);
  assert.equal(noProxyBypassesHost("opencode.ai", {}), false);
  assert.equal(noProxyBypassesHost("opencode.ai", { NO_PROXY: "*" }), true);
  assert.equal(noProxyBypassesHost("opencode.ai", { NO_PROXY: "opencode.ai" }), true);
  assert.equal(noProxyBypassesHost("api.opencode.ai", { NO_PROXY: ".opencode.ai" }), true);
  assert.equal(noProxyBypassesHost("opencode.ai", { no_proxy: "localhost, example.com" }), false);
  assert.equal(noProxyBypassesHost("notopencode.ai", { NO_PROXY: "opencode.ai" }), false);
});
