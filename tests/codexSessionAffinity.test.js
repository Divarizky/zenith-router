import test from "node:test";
import assert from "node:assert";
import { CodexExecutor, codexSessionId, withPromptCacheKey } from "../src/executors/codex.js";

// Mencegat request yang diserahkan CodexExecutor ke BaseExecutor.
async function captureCodexRequest({ sessionKey, sessionSource = "header", sessionPromptCacheKey = false, body = { model: "gpt-5-codex", input: [] } }) {
  const proto = Object.getPrototypeOf(CodexExecutor.prototype);
  const orig = proto.execute;
  const captured = {};
  proto.execute = async function (args) {
    captured.headers = Object.fromEntries(new Headers(args.headers));
    captured.body = JSON.parse(args.body);
    return new Response("{}", { status: 200 });
  };
  try {
    await new CodexExecutor().execute({
      url: "https://chatgpt.com/backend-api/codex/responses",
      body: JSON.stringify(body),
      connection: { credentials: {} },
      sessionKey,
      sessionSource,
      sessionPromptCacheKey,
    });
  } finally {
    proto.execute = orig;
  }
  return captured;
}

test("Codex executor - forwards a client session header as session_id and conversation_id", async () => {
  const { headers } = await captureCodexRequest({ sessionKey: "sess-abc_123" });
  assert.strictEqual(headers.session_id, "sess-abc_123");
  assert.strictEqual(headers.conversation_id, "sess-abc_123");
});

test("Codex executor - never forwards the apikey fallback as a session id", async () => {
  const { headers } = await captureCodexRequest({ sessionKey: "apikey:42", sessionSource: "apikey" });
  assert.strictEqual(headers.session_id, undefined);
  assert.strictEqual(headers.conversation_id, undefined);
});

test("Codex executor - ignores metadata.user_id and user markers, which may carry personal data", async () => {
  const { headers, body } = await captureCodexRequest({ sessionKey: "alice@example.com", sessionSource: "body", sessionPromptCacheKey: false });
  assert.strictEqual(headers.session_id, undefined);
  assert.strictEqual(body.prompt_cache_key, undefined);
});

test("Codex executor - sends no session header when the key has unsafe characters", async () => {
  const { headers } = await captureCodexRequest({ sessionKey: "bad id/with spaces" });
  assert.strictEqual(headers.session_id, undefined);
  assert.strictEqual(headers.conversation_id, undefined);
});

test("Codex executor - a client prompt_cache_key is forwarded and kept unchanged", async () => {
  const { headers, body } = await captureCodexRequest({
    sessionKey: "pk-client-1",
    sessionSource: "body",
    sessionPromptCacheKey: true,
    body: { model: "gpt-5-codex", input: [], prompt_cache_key: "pk-client-1" },
  });
  assert.strictEqual(headers.session_id, "pk-client-1");
  assert.strictEqual(body.prompt_cache_key, "pk-client-1");
});

test("withPromptCacheKey - fills an absent key and never overwrites a present one", () => {
  const filled = JSON.parse(withPromptCacheKey(JSON.stringify({ input: [] }), "s-1"));
  assert.strictEqual(filled.prompt_cache_key, "s-1");
  const kept = JSON.parse(withPromptCacheKey(JSON.stringify({ prompt_cache_key: "mine" }), "s-1"));
  assert.strictEqual(kept.prompt_cache_key, "mine");
});

test("codexSessionId - rejects ids longer than 128 characters", () => {
  assert.strictEqual(codexSessionId("a".repeat(128), { source: "header" }), "a".repeat(128));
  assert.strictEqual(codexSessionId("a".repeat(129), { source: "header" }), null);
});

test("Codex executor - a header session is also used as prompt_cache_key when the client sent none", async () => {
  const { headers, body } = await captureCodexRequest({ sessionKey: "sess-hdr-7", sessionSource: "header" });
  assert.strictEqual(headers.session_id, "sess-hdr-7");
  assert.strictEqual(body.prompt_cache_key, "sess-hdr-7");
});
