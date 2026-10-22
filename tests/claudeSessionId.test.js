import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

function captureClaudeRequest(body) {
  initDb(":memory:");
  addConnection({
    provider: "claude",
    name: "Claude OAuth",
    auth_type: "oauth",
    credentials: { access_token: "sk-ant-oat01-test", refresh_token: "rt" },
  });

  let captured = null;
  setCustomExecutor({
    async execute({ headers, body: sentBody }) {
      captured = { headers: { ...headers }, body: typeof sentBody === "string" ? JSON.parse(sentBody) : sentBody };
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  return app
    .request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    .then((res) => ({ res, captured }));
}

test("claude request - metadata.user_id diteruskan dan jadi session id header", async () => {
  const { res, captured } = await captureClaudeRequest({
    model: "claude/claude-opus-5",
    max_tokens: 64,
    stream: false,
    metadata: { user_id: '{"session_id":"sess-abc"}' },
    messages: [{ role: "user", content: "hi" }],
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(captured.body.metadata.user_id, '{"session_id":"sess-abc"}');
  assert.strictEqual(captured.headers["x-claude-code-session-id"], "sess-abc");
  assert.strictEqual(captured.headers["x-zenith-claude-session"], undefined);
  setCustomExecutor(null);
});

test("claude request - tanpa metadata tidak ada session id header", async () => {
  const { res, captured } = await captureClaudeRequest({
    model: "claude/claude-opus-5",
    max_tokens: 64,
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(captured.body.metadata, undefined);
  assert.strictEqual(captured.headers["x-claude-code-session-id"], undefined);
  setCustomExecutor(null);
});

test("claude request - metadata tidak bocor ke provider non-Claude", async () => {
  initDb(":memory:");
  addConnection({
    provider: "openrouter",
    name: "OR",
    auth_type: "apikey",
    credentials: { api_key: "sk-or-test" },
  });
  let captured = null;
  setCustomExecutor({
    async execute({ body }) {
      captured = typeof body === "string" ? JSON.parse(body) : body;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openrouter/openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: '{"session_id":"sess-zzz"}' },
    }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(captured.metadata?.user_id, undefined, "user_id tidak bocor ke provider lain");
  setCustomExecutor(null);
});

test("claude request - metadata milik klien lain tetap diteruskan ke provider non-Claude", async () => {
  initDb(":memory:");
  addConnection({
    provider: "openrouter",
    name: "OR",
    auth_type: "apikey",
    credentials: { api_key: "sk-or-test" },
  });
  let captured = null;
  setCustomExecutor({
    async execute({ body }) {
      captured = typeof body === "string" ? JSON.parse(body) : body;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openrouter/openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: '{"session_id":"sess-zzz"}', batch: "batch-42" },
    }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(captured.metadata.user_id, undefined, "user_id tidak bocor ke provider lain");
  assert.strictEqual(captured.metadata.batch, "batch-42", "metadata lain milik klien tetap utuh");
  setCustomExecutor(null);
});

test("claude request - metadata diteruskan pada jalur pivot OpenAI ke Claude", async () => {
  initDb(":memory:");
  addConnection({
    provider: "claude",
    name: "Claude OAuth",
    auth_type: "oauth",
    credentials: { access_token: "sk-ant-oat01-test", refresh_token: "rt" },
  });
  let captured = null;
  setCustomExecutor({
    async execute({ headers, body }) {
      captured = {
        headers: { ...headers },
        body: typeof body === "string" ? JSON.parse(body) : body,
      };
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });
  const res = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude/claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: '{"session_id":"sess-pivot"}' },
    }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(captured.body.metadata.user_id, '{"session_id":"sess-pivot"}');
  assert.strictEqual(captured.headers["x-claude-code-session-id"], "sess-pivot");
  setCustomExecutor(null);
});
