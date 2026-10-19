import test from "node:test";
import assert from "node:assert";
import {
  OpencodeExecutor,
  opencodePathForModel,
  resetOpencodeProtocolLanes,
  getOpencodeProtocolLane,
} from "../src/executors/opencode.js";

test("OpencodeExecutor - transparently retries on 400 ModelProtocolUnsupported and switches lane", async () => {
  resetOpencodeProtocolLanes();

  const calls = [];
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.includes("/chat/completions")) {
        return new Response(
          JSON.stringify({
            error: {
              type: "ModelProtocolUnsupported",
              message: "Model does not support this protocol, use /responses instead",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ id: "resp-1", choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const res = await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({
      model: "new-future-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, "https://opencode.ai/inference/openai/v1/chat/completions");
  assert.strictEqual(calls[1].url, "https://opencode.ai/inference/openai/v1/responses");

  // Learned lane is cached
  assert.strictEqual(getOpencodeProtocolLane("new-future-model"), "responses");
  assert.strictEqual(opencodePathForModel("new-future-model"), "/inference/v1/responses");

  // Subsequent request uses the learned responses path directly
  calls.length = 0;
  await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({
      model: "new-future-model",
      messages: [{ role: "user", content: "hello again" }],
    }),
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "https://opencode.ai/inference/openai/v1/responses");
});

test("OpencodeExecutor - non-protocol 400 error is not retried", async () => {
  resetOpencodeProtocolLanes();

  const calls = [];
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      calls.push({ url });
      return new Response(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "Missing required parameter",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const res = await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({
      model: "plain-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(getOpencodeProtocolLane("plain-model"), null);
});
