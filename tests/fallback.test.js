import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, getDb, addConnection, getConnections, getModelLockUntil, setConnectionCooldown } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { getProviderTraffic, resetTrafficGuardState } from "../src/services/trafficGuard.js";

test("Failover - retries on next account, and parks the failing one only after two requests", async () => {
  initDb(":memory:");
  const c1 = addConnection({ provider: "glm", name: "GLM Acc 1", credentials: { api_key: "key-1" } });
  const c2 = addConnection({ provider: "glm", name: "GLM Acc 2", credentials: { api_key: "key-2" } });

  const attempts = [];
  const chat = () =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
    });
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.authorization;
      attempts.push(auth);
      if (auth === "Bearer key-1") {
        return new Response(JSON.stringify({ error: { message: "Rate limit on acc 1" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from acc 2" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm/glm-4-flash",
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "from acc 2");
  assert.strictEqual(attempts.length, 2);
  assert.strictEqual(attempts[0], "Bearer key-1");
  assert.strictEqual(attempts[1], "Bearer key-2");

  // One failure is not enough to park the account: the client should see the
  // real upstream error and get another chance on the next manual attempt.
  const acc1 = () => getConnections("glm").find((c) => c.id === c1.id);
  assert.ok(!(getModelLockUntil(acc1().id, "glm-4-flash") > Date.now()), "belum dikunci setelah satu kegagalan");
  assert.ok(!(acc1().cooldown_until > Date.now()), "akun belum di-cooling setelah satu kegagalan");

  attempts.length = 0;
  assert.strictEqual((await chat()).status, 200);
  assert.deepStrictEqual(attempts, ["Bearer key-1", "Bearer key-2"], "percobaan manual kedua tetap mencoba acc 1");
  assert.ok(
    getModelLockUntil(acc1().id, "glm-4-flash") > Date.now(),
    "kegagalan kedua pada request terpisah mengunci model untuk acc 1"
  );

  setCustomExecutor(null);
});

test("Failover - transparently retries on 502/5xx server errors", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Bad", credentials: { api_key: "key-bad" } });
  addConnection({ provider: "glm", name: "GLM Good", credentials: { api_key: "key-good" } });

  let callCount = 0;
  setCustomExecutor({
    async execute() {
      callCount++;
      if (callCount === 1) {
        return new Response("Bad Gateway", { status: 502 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "recovered" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm/glm-4-flash",
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "recovered");
  assert.strictEqual(callCount, 2);

  setCustomExecutor(null);
});

test("Failover - client 400 error does not fail over to other accounts", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM 1", credentials: { api_key: "k1" } });
  addConnection({ provider: "glm", name: "GLM 2", credentials: { api_key: "k2" } });

  let callCount = 0;
  setCustomExecutor({
    async execute() {
      callCount++;
      return new Response(JSON.stringify({ error: { message: "Bad parameter" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm/glm-4-flash",
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(callCount, 1, "Should not fail over for 400 client error");

  setCustomExecutor(null);
});

test("Account Priority - order follows priority, not last use or a leftover rotation setting", async () => {
  const { listAvailableConnections } = await import("../src/services/fallback.js");
  const { setSetting } = await import("../src/services/settings.js");

  const db = initDb(":memory:");
  const c1 = addConnection({ provider: "glm", name: "GLM Acc 1", credentials: { api_key: "k1" } });
  const c2 = addConnection({ provider: "glm", name: "GLM Acc 2", credentials: { api_key: "k2" } });
  const c3 = addConnection({ provider: "glm", name: "GLM Acc 3", credentials: { api_key: "k3" } });

  // Under LRU c3 would come first and under sticky c1; priority ignores both.
  db.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").run(3000, c1.id);
  db.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").run(2000, c2.id);
  db.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").run(1000, c3.id);
  for (const leftover of ["lru", "sticky"]) {
    setSetting("account_rotation", leftover);
    assert.deepStrictEqual(
      listAvailableConnections("glm").map((c) => c.id),
      [c1.id, c2.id, c3.id],
      `account_rotation=${leftover} lama tidak boleh mengubah urutan`
    );
  }

  // A user-chosen order wins over creation order.
  db.prepare("UPDATE connections SET priority = ? WHERE id = ?").run(1, c3.id);
  db.prepare("UPDATE connections SET priority = ? WHERE id = ?").run(2, c1.id);
  db.prepare("UPDATE connections SET priority = ? WHERE id = ?").run(3, c2.id);
  assert.deepStrictEqual(listAvailableConnections("glm").map((c) => c.id), [c3.id, c1.id, c2.id]);
});

test("Account Priority - a locked #1 is skipped and used again once its lock ends", async () => {
  const { listAvailableConnections } = await import("../src/services/fallback.js");

  const db = initDb(":memory:");
  const c1 = addConnection({ provider: "glm", name: "GLM Acc 1", credentials: { api_key: "k1" } });
  const c2 = addConnection({ provider: "glm", name: "GLM Acc 2", credentials: { api_key: "k2" } });
  const c3 = addConnection({ provider: "glm", name: "GLM Acc 3", credentials: { api_key: "k3" } });

  setConnectionCooldown(c1.id, Date.now() + 60_000, "glm-4-flash");
  assert.deepStrictEqual(
    listAvailableConnections("glm", { model: "glm-4-flash" }).map((c) => c.id),
    [c2.id, c3.id],
    "#2 mengambil alih selama #1 terkunci"
  );
  assert.strictEqual(
    listAvailableConnections("glm", { model: "glm-5" })[0].id,
    c1.id,
    "kunci per model tidak memindahkan model lain dari #1"
  );

  db.prepare("UPDATE connection_model_locks SET locked_until = ? WHERE connection_id = ?").run(Date.now() - 1, c1.id);
  assert.strictEqual(listAvailableConnections("glm", { model: "glm-4-flash" })[0].id, c1.id, "kembali ke #1");

  db.prepare("UPDATE connections SET is_active = 0 WHERE id = ?").run(c2.id);
  setConnectionCooldown(c1.id, Date.now() + 60_000);
  assert.deepStrictEqual(
    listAvailableConnections("glm", { model: "glm-4-flash" }).map((c) => c.id),
    [c3.id],
    "#2 nonaktif dilewati, #3 dipakai"
  );
});

test("Account Priority - gateway answers from #2 on a 429 and returns to #1 after the lock", async () => {
  const db = initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Utama", credentials: { api_key: "key-1" } });
  addConnection({ provider: "glm", name: "GLM Cadangan", credentials: { api_key: "key-2" } });

  let limited = true;
  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.authorization;
      attempts.push(auth);
      if (auth === "Bearer key-1" && limited) {
        return new Response(JSON.stringify({ error: { message: "Rate limit" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const chat = () =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
    });

  try {
    assert.strictEqual((await chat()).status, 200);
    assert.deepStrictEqual(attempts, ["Bearer key-1", "Bearer key-2"], "429 di #1 dilanjutkan ke #2");

    attempts.length = 0;
    assert.strictEqual((await chat()).status, 200);
    assert.deepStrictEqual(attempts, ["Bearer key-1", "Bearer key-2"], "kegagalan kedua barulah mengunci #1");

    attempts.length = 0;
    assert.strictEqual((await chat()).status, 200);
    assert.deepStrictEqual(attempts, ["Bearer key-2"], "selama #1 terkunci, request langsung ke #2");

    limited = false;
    db.prepare("UPDATE connection_model_locks SET locked_until = ?").run(Date.now() - 1);
    attempts.length = 0;
    assert.strictEqual((await chat()).status, 200);
    assert.deepStrictEqual(attempts, ["Bearer key-1"], "setelah kunci berakhir, kembali ke #1");
  } finally {
    setCustomExecutor(null);
  }
});

function togetherChat(model, extra = {}) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
  });
}

const okCompletion = () =>
  new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("Failover - model with a 0/minute limit fails alone without cooling down the account", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "together", name: "Together", credentials: { api_key: "tk" } });

  setCustomExecutor({
    async execute({ body }) {
      if (JSON.parse(body).model === "meta-llama/Llama-3.3-70B-Instruct-Turbo") {
        return new Response(JSON.stringify({ object: "error", message: "Rate limit exceeded", type: "rate_limited", code: "1300" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "x-ratelimit-limit-req-minute": "0" },
        });
      }
      return okCompletion();
    },
  });

  const denied = await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo");
  assert.strictEqual(denied.status, 403, "a limit that never clears is not reported as retryable 429");
  const err = await denied.json();
  assert.strictEqual(err.error.code, "model_not_available");
  assert.ok(err.error.message.includes("meta-llama/Llama-3.3-70B-Instruct-Turbo"));

  const acc = getConnections("together").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "account is not cooled down");

  const other = await togetherChat("tg/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo");
  assert.strictEqual(other.status, 200, "other models on the same account keep working");

  setCustomExecutor(null);
});

test("Failover - 403 tier_not_allowed does not lock the account for 10 minutes", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "together", name: "Together", credentials: { api_key: "tk" } });

  setCustomExecutor({
    async execute() {
      return new Response(
        JSON.stringify({ object: "error", message: "This model is not available in your subscription tier", type: "tier_not_allowed", code: "1910" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const res = await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo");
  assert.strictEqual(res.status, 403);
  const acc = getConnections("together").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "account is not cooled down");

  setCustomExecutor(null);
});

test("Failover - 503 while every account cools down reports Retry-After", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "together", name: "Together", credentials: { api_key: "tk" } });
  setConnectionCooldown(conn.id, Date.now() + 42_000);

  const res = await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo");
  assert.strictEqual(res.status, 503);
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 42, `Retry-After is the remaining cooldown, got ${retryAfter}`);
  const err = await res.json();
  assert.strictEqual(err.error.code, "no_available_connection");
  assert.ok(err.error.message.includes(`retry in ${retryAfter}s`));
});

const upstream429 = (headers) =>
  new Response(JSON.stringify({ object: "error", message: "Rate limit exceeded", type: "rate_limited", code: "1300" }), {
    status: 429,
    headers: { "Content-Type": "application/json", ...headers },
  });

test("Failover - request larger than the tokens/minute limit fails as 413 without cooling down the account", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "together", name: "Together", credentials: { api_key: "tk" } });

  setCustomExecutor({
    async execute({ body }) {
      if (JSON.parse(body).model === "meta-llama/Llama-3.3-70B-Instruct-Turbo") {
        return upstream429({ "x-ratelimit-limit-tokens-minute": "20000", "x-ratelimit-remaining-tokens-minute": "20000" });
      }
      return okCompletion();
    },
  });

  const res = await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo");
  assert.strictEqual(res.status, 413);
  const err = await res.json();
  assert.strictEqual(err.error.code, "request_too_large");
  assert.ok(err.error.message.includes("20000 tokens/minute"));

  const acc = getConnections("together").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "account is not cooled down");
  assert.strictEqual((await togetherChat("tg/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo")).status, 200, "other models keep working");

  setCustomExecutor(null);
});

test("Failover - 429 with a partly used token budget is still a normal rate limit", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "together", name: "Together", credentials: { api_key: "tk" } });

  setCustomExecutor({
    async execute() {
      return upstream429({ "x-ratelimit-limit-tokens-minute": "20000", "x-ratelimit-remaining-tokens-minute": "1200" });
    },
  });

  const first = await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo");
  assert.strictEqual(first.status, 429);
  const acc = () => getConnections("together").find((c) => c.id === conn.id);
  assert.ok(
    !(getModelLockUntil(acc().id, "meta-llama/Llama-3.3-70B-Instruct-Turbo") > Date.now()),
    "satu 429 belum mengunci model"
  );

  const second = await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo");
  assert.strictEqual(second.status, 429);
  assert.ok(
    getModelLockUntil(acc().id, "meta-llama/Llama-3.3-70B-Instruct-Turbo") > Date.now(),
    "a real rate limit still locks the account for that model after two attempts"
  );

  setCustomExecutor(null);
});

test("Failover - model without reasoning: drops reasoning_effort, retries once, and remembers it", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "together", name: "Together", credentials: { api_key: "tk" } });

  const bodies = [];
  setCustomExecutor({
    async execute({ body }) {
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      if ("reasoning_effort" in parsed) {
        return new Response(
          JSON.stringify({ object: "error", message: "reasoning_effort is not enabled for this model", type: "invalid_request_invalid_args", code: "3051" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      return okCompletion();
    },
  });

  const first = await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo", { reasoning_effort: "high" });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(bodies.length, 2, "one failed attempt, one retry");
  assert.ok(!("reasoning_effort" in bodies[1]));

  const acc = getConnections("together").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "no cooldown for a parameter error");

  bodies.length = 0;
  const second = await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo", { reasoning_effort: "high" });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(bodies.length, 1, "known model is sent without reasoning_effort up front");
  assert.ok(!("reasoning_effort" in bodies[0]));

  setCustomExecutor(null);
});

test("Failover - model rejects reasoning_effort with variant 'feature reasoning_effort for this model is not currently supported'", async () => {
  initDb(":memory:");
  addConnection({ provider: "together", name: "Together", credentials: { api_key: "tk" } });

  const bodies = [];
  setCustomExecutor({
    async execute({ body }) {
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      if ("reasoning_effort" in parsed) {
        return new Response(
          JSON.stringify({ message: "feature 'reasoning_effort for this model' is not currently supported" }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      return okCompletion();
    },
  });

  const res = await togetherChat("tg/custom-reasoning-model", { reasoning_effort: "high" });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(bodies.length, 2, "gagal pertama, retry kedua tanpa reasoning_effort");
  assert.ok(!("reasoning_effort" in bodies[1]));

  setCustomExecutor(null);
});

test("Failover - model refused for the tier by every account is disabled and hidden from /v1/models", async () => {
  initDb(":memory:");
  addConnection({ provider: "together", name: "Together", credentials: { api_key: "tk" } });

  setCustomExecutor({
    async execute() {
      return upstream429({ "x-ratelimit-limit-req-minute": "0" });
    },
  });

  assert.strictEqual((await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo")).status, 403);

  const models = await (await app.request("/v1/models")).json();
  assert.ok(!models.data.some((m) => m.id === "together/meta-llama/Llama-3.3-70B-Instruct-Turbo"), "disabled model is not listed");
  assert.ok(models.data.some((m) => m.id === "together/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"), "other models stay listed");

  const again = await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo");
  assert.notStrictEqual(again.status, 503, "a disabled model is not reported as a connection problem");

  setCustomExecutor(null);
});

test("Failover - 403 labs_not_enabled does not cool down the account", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "together", name: "Together", credentials: { api_key: "tk" } });

  setCustomExecutor({
    async execute({ body }) {
      if (JSON.parse(body).model === "meta-llama/Llama-3.3-70B-Instruct-Turbo") {
        return new Response(
          JSON.stringify({ object: "error", message: "Model is a Labs model. To use Labs models, an admin must enable them.", type: "labs_not_enabled" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      return okCompletion();
    },
  });

  assert.strictEqual((await togetherChat("tg/meta-llama/Llama-3.3-70B-Instruct-Turbo")).status, 403);
  const acc = getConnections("together").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "account is not cooled down");
  assert.strictEqual((await togetherChat("tg/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo")).status, 200, "other models keep working");

  setCustomExecutor(null);
});

test("Failover - a client abort neither cools accounts down nor burns the next one", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM A", credentials: { api_key: "key-a" } });
  addConnection({ provider: "glm", name: "GLM B", credentials: { api_key: "key-b" } });

  const controller = new AbortController();
  const calls = [];
  setCustomExecutor({
    async execute() {
      calls.push(1);
      controller.abort();
      // Inilah bentuk yang dihasilkan executor saat fetch dibatalkan klien.
      return new Response(JSON.stringify({ error: { message: "Upstream transport failed: The operation was aborted" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const res = await app.request(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm/glm-4-flash", messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    })
  );

  assert.strictEqual(res.status, 502);
  assert.strictEqual(calls.length, 1, "akun berikutnya tidak boleh dibakar untuk klien yang sudah pergi");
  assert.strictEqual(
    getDb().prepare("SELECT count(*) AS n FROM connection_model_locks").get().n,
    0,
    "abort bukan alasan menulis lock model"
  );
  assert.ok(
    getConnections("glm").every((c) => !c.cooldown_until),
    "abort bukan alasan mengunci akun"
  );
  setCustomExecutor(null);
});

test("Failover - kegagalan resolusi proxy tidak membocorkan inFlight slot", async () => {
  initDb(":memory:");
  resetTrafficGuardState();
  addConnection({
    provider: "glm",
    name: "GLM Proxy Bad",
    credentials: { api_key: "[REDACTED:credential_assignment]" },
    proxy_pool_id: 999999,
  });

  try {
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm/glm-4-flash",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  } catch {
    // Expected: resolusi proxy melempar error
  }

  const traffic = getProviderTraffic("glm");
  assert.strictEqual(traffic.inFlight, 0, "inFlight slot tidak boleh bocor saat resolusi proxy gagal");
});
