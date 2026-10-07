import test from "node:test";
import assert from "node:assert";
import { applyTokenSaver } from "../src/services/tokenSaver.js";
import { app } from "../src/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

test("tokenSaver pipeline - applies both RTK and Caveman", () => {
  const body = {
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: `Here are the logs:\n${"repeated log line\n".repeat(6)}Done`,
      },
    ],
  };

  const optimized = applyTokenSaver(body, "openai");
  // RTK applied: duplicate lines suppressed
  assert.ok(optimized.messages[1].content.includes("duplicate lines suppressed"));
  // Caveman applied: system message injected
  assert.strictEqual(optimized.messages[0].role, "system");
  assert.ok(optimized.messages[0].content.includes("minimal filler"));
});

test("tokenSaver pipeline - respects headerDisabled bypass", () => {
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
  };

  const bypassed = applyTokenSaver(body, "openai", { headerDisabled: true });
  // Should remain completely unchanged
  assert.strictEqual(bypassed.messages.length, 1);
  assert.strictEqual(bypassed.messages[0].role, "user");
});

test("tokenSaver pipeline - guarantees fail-open on internal error", () => {
  // Pass an object with corrupted messages array that throws in processing
  const corrupted = {
    model: "gpt-4o",
    messages: null,
  };

  // Must not throw, must return original object
  const result = applyTokenSaver(corrupted, "openai");
  assert.deepStrictEqual(result, corrupted);
});

test("POST /v1/chat/completions - bypasses token saver when header x-zenroute-token-saver is false", async () => {
  let capturedBody = null;

  const mockExecutor = {
    async execute({ body }) {
      capturedBody = JSON.parse(body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  };
  setCustomExecutor(mockExecutor);

  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-zenroute-token-saver": "false",
    },
    body: JSON.stringify({
      model: "glm/glm-4-flash",
      messages: [{ role: "user", content: "hello test" }],
    }),
  });

  assert.strictEqual(res.status, 200);
  assert.ok(capturedBody);
  // Verify Caveman was NOT injected because of bypass header
  assert.strictEqual(capturedBody.messages.length, 1);
  assert.strictEqual(capturedBody.messages[0].role, "user");

  setCustomExecutor(null);
});
