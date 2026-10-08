import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { initDb, addConnection } from "../src/db/index.js";

test("cline non-stream forces upstream stream and unwraps success envelope", async () => {
  initDb(":memory:");
  addConnection({ provider: "cline", name: "Cline test", credentials: { access_token: "token" } });

  let seenBody;
  setCustomExecutor({
    async execute({ body }) {
      seenBody = JSON.parse(body);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            id: "chatcmpl-cline",
            object: "chat.completion",
            created: 1,
            model: "z-ai/glm-5.2",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cline/z-ai/glm-5.2",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(seenBody.stream, true);
    const json = await res.json();
    assert.strictEqual(json.choices[0].message.content, "ok");
  } finally {
    setCustomExecutor(null);
  }
});

test("cline success:false maps to an OpenAI-shaped error", async () => {
  initDb(":memory:");
  addConnection({ provider: "cline", name: "Cline test", credentials: { access_token: "token" } });

  setCustomExecutor({
    async execute() {
      return new Response(
        JSON.stringify({
          success: false,
          error: { message: "cline rejected", type: "invalid_request_error", code: "bad_request" },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
  });

  try {
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "cline/z-ai/glm-5.2",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.error.message, "cline rejected");
  } finally {
    setCustomExecutor(null);
  }
});
