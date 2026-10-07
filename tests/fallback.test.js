import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getConnections } from "../src/db/index.js";
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
