import test from "node:test";
import assert from "node:assert";
import { FreebuffExecutor } from "../src/executors/freebuff.js";

test("FreebuffExecutor - returns 401 if no Authorization header", async () => {
  const executor = new FreebuffExecutor();
  const res = await executor.execute({
    url: "https://www.codebuff.com/api/v1/chat/completions",
    method: "POST",
    headers: {},
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }] }),
  });
  assert.strictEqual(res.status, 401);
  const data = await res.json();
  assert.strictEqual(data.error.type, "authentication_error");
});

test("FreebuffExecutor - completes session, agent-run, buffy prompt, and completion flow", async () => {
  const calls = [];
  const mockFetch = async (url, init = {}) => {
    const bodyStr = typeof init.body === "string" ? init.body : "";
    let bodyJson = null;
    try {
      bodyJson = JSON.parse(bodyStr);
    } catch {}
    calls.push({ url, method: init.method || "GET", headers: init.headers, body: bodyJson });

    if (url.endsWith("/freebuff/session")) {
      return new Response(JSON.stringify({ instanceId: "inst_test_123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/agent-runs")) {
      if (bodyJson?.action === "START") {
        return new Response(JSON.stringify({ runId: "run_test_456" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.endsWith("/chat/completions")) {
      return new Response(
        JSON.stringify({
          id: "chatcmpl_test",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello from Freebuff!" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const executor = new FreebuffExecutor({ fetchFn: mockFetch });
  const res = await executor.execute({
    url: "https://www.codebuff.com/api/v1/chat/completions",
    method: "POST",
    headers: { Authorization: "Bearer test-codebuff-token" },
    body: JSON.stringify({
      model: "fb/deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "Help me write code" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "Hello from Freebuff!");

  // Verify call sequence
  assert.ok(calls.some((c) => c.url.endsWith("/freebuff/session")));
  const sessionCall = calls.find((c) => c.url.endsWith("/freebuff/session"));
  assert.strictEqual(sessionCall.headers["x-freebuff-model"], "deepseek/deepseek-v4-flash");

  assert.ok(calls.some((c) => c.url.endsWith("/agent-runs") && c.body?.action === "START"));
  const startCall = calls.find((c) => c.url.endsWith("/agent-runs") && c.body?.action === "START");
  assert.strictEqual(startCall.body.agentId, "base2-free-deepseek-flash");

  assert.ok(calls.some((c) => c.url.endsWith("/chat/completions")));
  const compCall = calls.find((c) => c.url.endsWith("/chat/completions"));
  assert.strictEqual(compCall.body.model, "deepseek/deepseek-v4-flash");
  assert.strictEqual(compCall.body.messages[0].role, "system");
  assert.ok(compCall.body.messages[0].content.startsWith("You are Buffy"));
  assert.strictEqual(compCall.body.codebuff_metadata.freebuff_instance_id, "inst_test_123");
  assert.strictEqual(compCall.body.codebuff_metadata.run_id, "run_test_456");
});
