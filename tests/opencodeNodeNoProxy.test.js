import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const cleanEnv = { HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "", no_proxy: "", NODE_USE_ENV_PROXY: "" };

function run(extraEnv) {
  const stdout = execFileSync(process.execPath, ["tests/fixtures/nodeBridgeNoProxyCounter.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, ...cleanEnv, ...extraEnv },
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

const variants = [
  ["tanpa env proxy", {}],
  ["NO_PROXY=*", { NO_PROXY: "*", no_proxy: "*" }],
  ["NO_PROXY=127.0.0.1", { NO_PROXY: "127.0.0.1" }],
  ["NODE_USE_ENV_PROXY=1 + NO_PROXY=*", { NODE_USE_ENV_PROXY: "1", NO_PROXY: "*" }],
  // Node 22 mengarahkan http.request ke env proxy saat NODE_USE_ENV_PROXY=1, termasuk hop menuju
  // proxy terpilih. Hasilnya gagal tertutup (target tidak tersentuh), bukan bocor direct.
  ["HTTP_PROXY menunjuk proxy lain", { HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: "1" }, { failClosed: true }],
];

for (const [label, env, opts = {}] of variants) {
  test(`Node bridge require-proxy: nol pengiriman direct (${label})`, () => {
    const out = run(env);
    if (opts.failClosed) {
      assert.equal(out.success.status, 502, "ditolak, tidak dikirim");
      assert.equal(out.success.target, 0, "target tidak tersentuh");
      assert.equal(out.success.direct, 0, "tidak ada pengiriman direct");
      assert.equal(out.proxyDown.status, 502);
      assert.equal(out.proxyDown.targetDelta, 0);
      assert.equal(out.proxyDown.directDelta, 0);
      return;
    }
    assert.equal(out.success.status, 200);
    assert.equal(out.success.target, 1);
    assert.equal(out.success.proxy, 1, "lewat proxy eksplisit, bukan env");
    assert.equal(out.success.direct, 0, "tidak ada pengiriman direct");
    assert.equal(out.proxyDown.status, 502);
    assert.equal(out.proxyDown.proxyDelta, 1);
    assert.equal(out.proxyDown.targetDelta, 0);
    assert.equal(out.proxyDown.directDelta, 0);
  });
}
