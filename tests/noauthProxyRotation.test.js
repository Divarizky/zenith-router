import test from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/index.js";
import { initDb, addProxyPool, addConnection, updateConnection } from "../src/db/index.js";
import {
  setProxyRotationStrategy,
  planProxyRotationEntries,
  resetProxyRotation,
  markProxyPoolExhausted,
  resetProxyPoolExhausted,
  listProxyPools,
} from "../src/services/proxyPools.js";
import { resetOpencodeGate, clearOpencodeGateCooldown } from "../src/services/opencodeGate.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { renderProxiesPage } from "../src/ui/pages/proxies.js";
import { renderProviderDetailPage } from "../src/ui/pages/providers.js";

function okResponse() {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok from test" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fail429Response() {
  return new Response(JSON.stringify({ type: "FreeUsageLimitError", message: "Free usage limit reached." }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

test("noAuth provider rotasi tetap berjalan meski ada akun dummy terdaftar di database", async () => {
  initDb(":memory:");
  resetProxyRotation();
  resetProxyPoolExhausted();
  resetOpencodeGate();

  const p1 = addProxyPool({ name: "lane-1", url: "http://lane1.local:3128" });
  const p2 = addProxyPool({ name: "lane-2", url: "http://lane2.local:3128" });
  setProxyRotationStrategy("opencode", "round_robin");

  // Tambahkan akun dummy untuk opencode yang terikat ke lane-1
  addConnection({
    provider: "opencode",
    name: "OpenCode Dummy",
    auth_type: "none",
    proxy_pool_id: p1.id,
    is_active: 1,
  });

  const calledProxies = [];
  setCustomExecutor({
    async execute({ proxyUrl }) {
      calledProxies.push(proxyUrl);
      if (proxyUrl === p1.url) {
        return fail429Response();
      }
      return okResponse();
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }] }),
    });

    assert.equal(res.status, 200, "Request harus berhasil failover ke proxy berikutnya");
    assert.deepEqual(calledProxies, [p1.url, p2.url], "Harus mencoba lane-1 lalu failover ke lane-2");
  } finally {
    setCustomExecutor(null);
  }
});

test("planProxyRotationEntries memprioritaskan proxy sehat yang tidak sedang cooling down / exhausted", () => {
  initDb(":memory:");
  resetProxyRotation();
  resetProxyPoolExhausted();
  resetOpencodeGate();

  const p1 = addProxyPool({ name: "lane-1", url: "http://lane1.local:3128" });
  const p2 = addProxyPool({ name: "lane-2", url: "http://lane2.local:3128" });
  const p3 = addProxyPool({ name: "lane-3", url: "http://lane3.local:3128" });

  setProxyRotationStrategy("opencode", "round_robin");

  // Tandai lane-1 exhausted
  markProxyPoolExhausted(p1.id, Date.now() + 60000);

  const plan = planProxyRotationEntries("opencode", "round_robin");
  assert.equal(plan.length, 3);
  // Lane-2 dan Lane-3 harus berada di depan karena lane-1 sedang exhausted
  assert.equal(plan[0].id, p2.id);
  assert.equal(plan[1].id, p3.id);
  assert.equal(plan[2].id, p1.id);
});

test("halaman proxies dan provider detail menampilkan badge informasi noAuth terhubung", () => {
  initDb(":memory:");
  resetProxyRotation();

  const p1 = addProxyPool({ name: "lane-1", url: "http://lane1.local:3128" });
  setProxyRotationStrategy("opencode", "round_robin");

  // Tambahkan akun dummy terikat
  addConnection({
    provider: "opencode",
    name: "OpenCode Bound",
    auth_type: "none",
    proxy_pool_id: p1.id,
    is_active: 1,
  });

  const proxiesHtml = renderProxiesPage(3128, "id");
  assert.match(proxiesHtml, /noAuth:\s*OpenCode Free\s*\(Bergiliran\)/, "Summary proxies harus menampilkan badge rotasi noAuth");
  assert.match(proxiesHtml, /noAuth rotasi/, "Baris proxy aktif harus menampilkan badge noAuth rotasi");
  assert.match(proxiesHtml, /noAuth bound/, "Baris proxy dengan akun noAuth terikat harus menampilkan badge noAuth bound");

  const providerDetailHtml = renderProviderDetailPage(3128, "opencode", {}, "id");
  assert.match(providerDetailHtml, /Proxy Pool:\s*Bergiliran/, "Provider detail harus menampilkan badge Proxy Pool Bergiliran");
});
