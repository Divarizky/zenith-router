import test from "node:test";
import assert from "node:assert";
import {
  OpencodeExecutor,
  opencodePathForModel,
  opencodeSessionId,
  opencodeRequestId,
} from "../src/executors/opencode.js";
import opencode from "../src/providers/registry/opencode.js";

test("opencode registry - chat baseUrl points at zen API, not marketing site", () => {
  assert.strictEqual(opencode.transport.baseUrl, "https://opencode.ai/zen/v1/chat/completions");
  assert.strictEqual(opencode.transport.messagesUrl, "https://opencode.ai/zen/v1/messages");
  assert.strictEqual(opencode.transport.responsesUrl, "https://opencode.ai/zen/v1/responses");
});

test("opencodePathForModel - routes muse-spark/union-alpha to their own endpoints", () => {
  assert.strictEqual(opencodePathForModel("muse-spark-1.2-contributor-free"), "/zen/v1/responses");
  assert.strictEqual(opencodePathForModel("union-alpha"), "/zen/v1/messages");
  assert.strictEqual(opencodePathForModel("jev-1.13-free"), "/zen/v1/chat/completions");
});

test("opencode ids - session/request match upstream fingerprint shape", async () => {
  assert.match(opencodeSessionId(), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.match(opencodeRequestId(), /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test("OpencodeExecutor - rewrites legacy url, sets free-tier headers, keeps client tools", async () => {
  let seen = null;
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const res = await executor.execute({
    url: "https://opencode.ai/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jev-1.13-free",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "custom_tool", description: "x", parameters: { type: "object" } } }],
    }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(seen.url, "https://opencode.ai/zen/v1/chat/completions");
  assert.strictEqual(seen.headers.get("Authorization"), "Bearer public");
  assert.strictEqual(seen.headers.get("x-opencode-client"), "desktop");
  assert.match(seen.headers.get("x-opencode-session"), /^ses_/);
  assert.match(seen.headers.get("x-opencode-request"), /^msg_/);
  const toolNames = seen.body.tools.map((t) => t.function.name);
  assert.ok(toolNames.includes("custom_tool"));
  for (const name of ["bash", "read", "grep", "glob"]) {
    assert.ok(toolNames.includes(name), `missing fingerprint tool ${name}`);
  }
});
