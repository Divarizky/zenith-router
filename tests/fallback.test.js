import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getConnections, setConnectionCooldown } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

test("Failover - transparently retries on next account when first account returns 429", async () => {
  initDb(":memory:");
  const c1 = addConnection({ provider: "glm", name: "GLM Acc 1", credentials: { api_key: "key-1" } });
  const c2 = addConnection({ provider: "glm", name: "GLM Acc 2", credentials: { api_key: "key-2" } });

  const attempts = [];
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

  // Verify that Acc 1 is in cooldown
  const updatedConns = getConnections("glm");
  const acc1 = updatedConns.find((c) => c.id === c1.id);
  assert.ok(acc1.cooldown_until > Date.now());

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

test("Account Rotation - respects sticky vs LRU strategy", async () => {
  const { listAvailableConnections } = await import("../src/services/fallback.js");
  const { setSetting } = await import("../src/services/settings.js");

  const db = initDb(":memory:");
  const c1 = addConnection({ provider: "glm", name: "GLM Acc 1", credentials: { api_key: "k1" } });
  const c2 = addConnection({ provider: "glm", name: "GLM Acc 2", credentials: { api_key: "k2" } });

  // Update c1 last_used_at to 1000, c2 last_used_at to 2000
  db.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").run(1000, c1.id);
  db.prepare("UPDATE connections SET last_used_at = ? WHERE id = ?").run(2000, c2.id);

  // LRU strategy (default): oldest last_used_at (c1: 1000) should be first
  setSetting("account_rotation", "lru");
  const lruList = listAvailableConnections("glm");
  assert.strictEqual(lruList[0].id, c1.id);
  assert.strictEqual(lruList[1].id, c2.id);

  // Sticky strategy: newest last_used_at (c2: 2000) should be first to stay on the same account
  setSetting("account_rotation", "sticky");
  const stickyList = listAvailableConnections("glm");
  assert.strictEqual(stickyList[0].id, c2.id);
  assert.strictEqual(stickyList[1].id, c1.id);
});

function mistralChat(model, extra = {}) {
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

test("Mistral - maps or drops OpenAI-only fields Mistral rejects with 422", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });

  let sent = null;
  setCustomExecutor({
    async execute({ body }) {
      sent = JSON.parse(body);
      return okCompletion();
    },
  });

  const res = await mistralChat("mis/ministral-3b-latest", {
    store: false,
    user: "u1",
    seed: 7,
    max_completion_tokens: 64,
    verbosity: "low",
    parallel_tool_calls: true,
  });
  assert.strictEqual(res.status, 200);
  for (const key of ["store", "user", "seed", "max_completion_tokens", "verbosity"]) {
    assert.ok(!(key in sent), `${key} is not sent to Mistral`);
  }
  assert.strictEqual(sent.max_tokens, 64);
  assert.strictEqual(sent.random_seed, 7);
  assert.strictEqual(sent.parallel_tool_calls, true, "fields Mistral accepts pass through");

  setCustomExecutor(null);
});

test("Mistral - model with a 0/minute limit fails alone without cooling down the account", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });

  setCustomExecutor({
    async execute({ body }) {
      if (JSON.parse(body).model === "mistral-medium-latest") {
        return new Response(JSON.stringify({ object: "error", message: "Rate limit exceeded", type: "rate_limited", code: "1300" }), {
          status: 429,
          headers: { "Content-Type": "application/json", "x-ratelimit-limit-req-minute": "0" },
        });
      }
      return okCompletion();
    },
  });

  const denied = await mistralChat("mis/mistral-medium-latest");
  assert.strictEqual(denied.status, 403, "a limit that never clears is not reported as retryable 429");
  const err = await denied.json();
  assert.strictEqual(err.error.code, "model_not_available");
  assert.ok(err.error.message.includes("mistral-medium-latest"));

  const acc = getConnections("mistral").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "account is not cooled down");

  const other = await mistralChat("mis/ministral-3b-latest");
  assert.strictEqual(other.status, 200, "other models on the same account keep working");

  setCustomExecutor(null);
});

test("Mistral - 403 tier_not_allowed does not lock the account for 10 minutes", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });

  setCustomExecutor({
    async execute() {
      return new Response(
        JSON.stringify({ object: "error", message: "This model is not available in your subscription tier", type: "tier_not_allowed", code: "1910" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const res = await mistralChat("mis/mistral-large-latest");
  assert.strictEqual(res.status, 403);
  const acc = getConnections("mistral").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "account is not cooled down");

  setCustomExecutor(null);
});

test("Failover - 503 while every account cools down reports Retry-After", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });
  setConnectionCooldown(conn.id, Date.now() + 42_000);

  const res = await mistralChat("mis/ministral-3b-latest");
  assert.strictEqual(res.status, 503);
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 42, `Retry-After is the remaining cooldown, got ${retryAfter}`);
  const err = await res.json();
  assert.strictEqual(err.error.code, "no_available_connection");
  assert.ok(err.error.message.includes(`retry in ${retryAfter}s`));
});

const mistral429 = (headers) =>
  new Response(JSON.stringify({ object: "error", message: "Rate limit exceeded", type: "rate_limited", code: "1300" }), {
    status: 429,
    headers: { "Content-Type": "application/json", ...headers },
  });

test("Mistral - request larger than the tokens/minute limit fails as 413 without cooling down the account", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });

  setCustomExecutor({
    async execute({ body }) {
      if (JSON.parse(body).model === "magistral-small-latest") {
        return mistral429({ "x-ratelimit-limit-tokens-minute": "20000", "x-ratelimit-remaining-tokens-minute": "20000" });
      }
      return okCompletion();
    },
  });

  const res = await mistralChat("mis/magistral-small-latest");
  assert.strictEqual(res.status, 413);
  const err = await res.json();
  assert.strictEqual(err.error.code, "request_too_large");
  assert.ok(err.error.message.includes("20000 tokens/minute"));

  const acc = getConnections("mistral").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "account is not cooled down");
  assert.strictEqual((await mistralChat("mis/ministral-14b-latest")).status, 200, "other models keep working");

  setCustomExecutor(null);
});

test("Mistral - 429 with a partly used token budget is still a normal rate limit", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });

  setCustomExecutor({
    async execute() {
      return mistral429({ "x-ratelimit-limit-tokens-minute": "20000", "x-ratelimit-remaining-tokens-minute": "1200" });
    },
  });

  const res = await mistralChat("mis/magistral-small-latest");
  assert.strictEqual(res.status, 429);
  const acc = getConnections("mistral").find((c) => c.id === conn.id);
  assert.ok(acc.cooldown_until > Date.now(), "a real rate limit still cools the account down");

  setCustomExecutor(null);
});

test("Mistral - model without reasoning: drops reasoning_effort, retries once, and remembers it", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });

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

  const first = await mistralChat("mis/codestral-2508", { reasoning_effort: "high" });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(bodies.length, 2, "one failed attempt, one retry");
  assert.ok(!("reasoning_effort" in bodies[1]));

  const acc = getConnections("mistral").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "no cooldown for a parameter error");

  bodies.length = 0;
  const second = await mistralChat("mis/codestral-2508", { reasoning_effort: "high" });
  assert.strictEqual(second.status, 200);
  assert.strictEqual(bodies.length, 1, "known model is sent without reasoning_effort up front");
  assert.ok(!("reasoning_effort" in bodies[0]));

  setCustomExecutor(null);
});

test("Mistral - model refused for the tier by every account is disabled and hidden from /v1/models", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });

  setCustomExecutor({
    async execute() {
      return mistral429({ "x-ratelimit-limit-req-minute": "0" });
    },
  });

  assert.strictEqual((await mistralChat("mis/ministral-8b-latest")).status, 403);

  const models = await (await app.request("/v1/models")).json();
  assert.ok(!models.data.some((m) => m.id === "mis/ministral-8b-latest"), "disabled model is not listed");
  assert.ok(models.data.some((m) => m.id === "mis/ministral-3b-latest"), "other models stay listed");

  const again = await mistralChat("mis/ministral-8b-latest");
  assert.notStrictEqual(again.status, 503, "a disabled model is not reported as a connection problem");

  setCustomExecutor(null);
});

test("Mistral - tool call ids from other models are remapped to 9 alphanumeric characters", async () => {
  initDb(":memory:");
  addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });

  const bodies = [];
  setCustomExecutor({
    async execute({ body }) {
      bodies.push(JSON.parse(body));
      return okCompletion();
    },
  });

  const history = {
    messages: [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1047952", type: "function", function: { name: "ls", arguments: "{}" } },
          { id: "AbC123xyz", type: "function", function: { name: "pwd", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1047952", content: "a.txt" },
      { role: "tool", tool_call_id: "AbC123xyz", content: "/home" },
    ],
  };
  const send = () =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mis/ministral-3b-latest", ...history }),
    });

  assert.strictEqual((await send()).status, 200);
  const [, assistant, tool1, tool2] = bodies[0].messages;
  const mapped = assistant.tool_calls[0].id;
  assert.match(mapped, /^[a-zA-Z0-9]{9}$/);
  assert.strictEqual(tool1.tool_call_id, mapped, "tool result follows its call");
  assert.strictEqual(assistant.tool_calls[1].id, "AbC123xyz", "valid ids are kept");
  assert.strictEqual(tool2.tool_call_id, "AbC123xyz");

  assert.strictEqual((await send()).status, 200);
  assert.strictEqual(bodies[1].messages[1].tool_calls[0].id, mapped, "mapping is stable across requests");

  setCustomExecutor(null);
});

test("Mistral - 403 labs_not_enabled does not cool down the account", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "mistral", name: "Mistral", credentials: { api_key: "mk" } });

  setCustomExecutor({
    async execute({ body }) {
      if (JSON.parse(body).model === "labs-leanstral-1-5") {
        return new Response(
          JSON.stringify({ object: "error", message: "Model labs-leanstral-1-5 is a Labs model. To use Labs models, an admin must enable them.", type: "labs_not_enabled" }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        );
      }
      return okCompletion();
    },
  });

  assert.strictEqual((await mistralChat("mis/labs-leanstral-1-5")).status, 403);
  const acc = getConnections("mistral").find((c) => c.id === conn.id);
  assert.ok(!(acc.cooldown_until > Date.now()), "account is not cooled down");
  assert.strictEqual((await mistralChat("mis/ministral-3b-latest")).status, 200, "other models keep working");

  setCustomExecutor(null);
});
