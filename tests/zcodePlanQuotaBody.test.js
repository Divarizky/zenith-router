import test from "node:test";
import assert from "node:assert";
import { ZcodePlanExecutor } from "../src/executors/zcodePlan.js";

const PLAN_TOKEN = "plan-test-token-value";

function planConnection() {
  return { id: "conn-1", provider: "glm", credentials: { access_token: "[REDACTED:credential_assignment]", plan_token: PLAN_TOKEN } };
}

const streamBody = JSON.stringify({
  model: "glm-5.3",
  stream: true,
  messages: [{ role: "user", content: "halo" }],
});

test("quota error 1005 returned with HTTP 200 maps to HTTP 429 for account failover", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ code: 1005, msg: "exceed quota limit" }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  const executor = new ZcodePlanExecutor({ fetchFn });

  const res = await executor.execute({ body: streamBody, connection: planConnection(), targetModel: "glm-5.3" });

  assert.strictEqual(res.status, 429);
  const data = await res.json();
  assert.strictEqual(data.error.code, 1005);
  assert.strictEqual(data.error.type, "rate_limit_error");
});

test("JSON body on a 200 stream request is never returned as an SSE stream", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({ code: 9999, msg: "unexpected" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const executor = new ZcodePlanExecutor({ fetchFn });

  const res = await executor.execute({ body: streamBody, connection: planConnection(), targetModel: "glm-5.3" });

  assert.notStrictEqual(res.headers.get("Content-Type"), "text/event-stream");
  const data = await res.json();
  assert.strictEqual(data.error.message, "unexpected");
});

test("non-stream success JSON with HTTP 200 is still converted, not treated as an error", async () => {
  const fetchFn = async () =>
    new Response(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "glm-5.3",
      content: [{ type: "text", text: "hai" }], stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  const executor = new ZcodePlanExecutor({ fetchFn });
  const nonStream = JSON.stringify({ model: "glm-5.3", stream: false, messages: [{ role: "user", content: "halo" }] });

  const res = await executor.execute({ body: nonStream, connection: planConnection(), targetModel: "glm-5.3" });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices[0].message.content, "hai");
});
