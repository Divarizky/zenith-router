import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getConnections } from "../src/db/index.js";
import { importLocalLogin, hasLocalImport } from "../src/services/oauth/flows.js";
import {
  translateOpenAIToCommandCode,
  parseCommandCodeError,
  CommandCodeExecutor,
} from "../src/executors/commandcode.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

test("CommandCode - local import checks and auth.json extraction", async (t) => {
  initDb(":memory:");
  assert.ok(hasLocalImport("commandcode"));

  const authDir = join(homedir(), ".commandcode");
  const authFile = join(authDir, "auth.json");
  mkdirSync(authDir, { recursive: true });

  t.after(() => {
    try {
      rmSync(authFile, { force: true });
    } catch {}
  });

  // Write mock auth.json
  writeFileSync(authFile, JSON.stringify({ apiKey: "user_test_mock_123" }), "utf8");

  const res = await importLocalLogin("commandcode", { name: "CommandCode CLI Account" });
  assert.strictEqual(res.account, "CommandCode CLI Account");

  const conns = getConnections("commandcode");
  assert.strictEqual(conns.length, 1);
  assert.strictEqual(conns[0].credentials.access_token, "user_test_mock_123");
  assert.strictEqual(conns[0].credentials.api_key, "user_test_mock_123");
});

test("CommandCode - translates OpenAI request to CommandCode alpha schema with isolation", () => {
  const openAIPayload = {
    model: "cmc/deepseek/deepseek-v4-pro",
    messages: [
      { role: "system", content: "You are a code reviewer." },
      { role: "user", content: "Check this function." },
    ],
    temperature: 0.2,
    max_tokens: 4096,
  };

  const translated = translateOpenAIToCommandCode(openAIPayload, "deepseek/deepseek-v4-pro");
  assert.ok(translated.threadId, "Generates threadId UUID");
  assert.strictEqual(translated.params.model, "deepseek/deepseek-v4-pro");
  assert.strictEqual(translated.params.system, "You are a code reviewer.");
  assert.strictEqual(translated.params.messages.length, 1);
  assert.strictEqual(translated.params.messages[0].role, "user");
  assert.deepStrictEqual(translated.params.messages[0].content, [{ type: "text", text: "Check this function." }]);
  assert.strictEqual(translated.config.isGitRepo, false, "Isolates git environment by default");
});

test("CommandCode - error parsing handles standard error types", () => {
  const err429 = parseCommandCodeError({ type: "error", error: { message: "Rate limit exceeded" } });
  assert.strictEqual(err429.statusCode, 429);
  assert.strictEqual(err429.type, "rate_limit_error");

  const err401 = parseCommandCodeError({ type: "error", error: "Invalid API key" });
  assert.strictEqual(err401.statusCode, 401);
  assert.strictEqual(err401.type, "authentication_error");

  const err503 = parseCommandCodeError({ type: "error", error: "Overloaded" });
  assert.strictEqual(err503.statusCode, 503);
});

test("CommandCode - executor translates NDJSON stream to OpenAI SSE chunks with fresh session isolation", async () => {
  let capturedHeaders = null;
  let capturedBody = null;

  const mockFetch = async (url, init) => {
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);

    const ndjsonEvents = [
      JSON.stringify({ type: "text-delta", text: "Hello " }) + "\n",
      JSON.stringify({ type: "text-delta", text: "world!" }) + "\n",
      JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { promptTokens: 10, completionTokens: 2 } }) + "\n",
    ];

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        for (const ev of ndjsonEvents) {
          controller.enqueue(enc.encode(ev));
        }
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };

  const executor = new CommandCodeExecutor({ fetchFn: mockFetch });

  const res = await executor.execute({
    url: "https://api.commandcode.ai/alpha/generate",
    method: "POST",
    headers: { Authorization: "Bearer user_secret_key_abc" },
    body: JSON.stringify({
      model: "commandcode/deepseek/deepseek-v4-pro",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

  // Verify security & session isolation headers via Headers instance
  assert.ok(capturedHeaders.get("x-session-id"), "Must inject unique x-session-id per request");
  assert.strictEqual(capturedHeaders.get("x-command-code-version"), "0.25.7");
  assert.strictEqual(capturedHeaders.get("x-cli-environment"), "cli");
  assert.strictEqual(capturedHeaders.get("authorization"), "Bearer user_secret_key_abc");

  const text = await res.text();
  assert.ok(text.includes('data: {"id":"chatcmpl-'));
  assert.ok(text.includes('"content":"Hello "'));
  assert.ok(text.includes('"content":"world!"'));
  assert.ok(text.includes("data: [DONE]"));
});
