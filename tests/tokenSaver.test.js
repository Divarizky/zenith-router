import test from "node:test";
import assert from "node:assert";
import { applyTokenSaver, tokenSaverOptions } from "../src/services/tokenSaver.js";
import { setSetting } from "../src/services/settings.js";
import { app } from "../src/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { initDb, addConnection } from "../src/db/index.js";

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

  const optimized = applyTokenSaver(body, "openai", { caveman: true });
  // RTK applied: duplicate lines suppressed
  assert.ok(optimized.messages[1].content.includes("duplicate lines suppressed"));
  // Caveman applied: system message injected
  assert.strictEqual(optimized.messages[0].role, "system");
  assert.ok(optimized.messages[0].content.includes("minimal filler"));
});

test("tokenSaver pipeline - Caveman is off unless explicitly enabled", () => {
  const body = { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] };
  const optimized = applyTokenSaver(body, "openai");
  assert.strictEqual(optimized.messages.length, 1);
  assert.strictEqual(optimized.messages[0].role, "user");
});

test("tokenSaver pipeline - RTK leaves tool results and assistant turns untouched", () => {
  const fileContents = "function a() {\n\n\n\n}\n// x\n// x\n// x\n// x";
  const body = {
    model: "gpt-4o",
    messages: [
      { role: "assistant", content: fileContents },
      { role: "tool", tool_call_id: "1", content: fileContents },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "1", content: fileContents },
          { type: "text", text: fileContents },
        ],
      },
    ],
  };

  const optimized = applyTokenSaver(body, "openai");
  assert.strictEqual(optimized.messages[0].content, fileContents);
  assert.strictEqual(optimized.messages[1].content, fileContents);
  assert.strictEqual(optimized.messages[2].content[0].content, fileContents);
  assert.notStrictEqual(optimized.messages[2].content[1].text, fileContents, "User-typed text is still condensed");
});

test("tokenSaver pipeline - options follow settings and the bypass header", () => {
  assert.deepStrictEqual(tokenSaverOptions({ token_saver_rtk: "true", token_saver_caveman: "false" }, undefined), {
    headerDisabled: false,
    rtk: true,
    caveman: false,
  });
  assert.deepStrictEqual(tokenSaverOptions({ token_saver_rtk: "false", token_saver_caveman: "true" }, "false"), {
    headerDisabled: true,
    rtk: false,
    caveman: true,
  });
});

test("POST /v1/chat/completions - token saver follows Settings", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM test", credentials: { api_key: "test-key" } });
  const bodies = [];
  setCustomExecutor({
    async execute({ body }) {
      bodies.push(JSON.parse(body));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const send = () =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm/glm-4-flash",
        messages: [{ role: "user", content: `logs:\n${"same line\n".repeat(5)}end` }],
      }),
    });

  await send();
  assert.strictEqual(bodies[0].messages.length, 1, "Caveman is off by default");
  assert.ok(bodies[0].messages[0].content.includes("duplicate lines suppressed"), "RTK is on by default");

  setSetting("token_saver_caveman", "true");
  setSetting("token_saver_rtk", "false");
  await send();
  assert.strictEqual(bodies[1].messages[0].role, "system");
  assert.ok(!bodies[1].messages[1].content.includes("duplicate lines suppressed"));

  setCustomExecutor(null);
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
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM test", credentials: { api_key: "test-key" } });
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
