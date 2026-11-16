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
  assert.strictEqual(headers.conversation_id, undefined);
  // Failure mode dicegah: identitas pribadi (email) bocor ke upstream Codex,
  // dan request tetap memperoleh prompt_cache_key turunan yang valid untuk caching.
  assert.match(body.prompt_cache_key, /^zr-[a-f0-9]{32}$/);
  assert.strictEqual(body.prompt_cache_key.includes("alice@example.com"), false);
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

test("AC1: Codex executor - derives stable prompt_cache_key across conversation turns without client session", async () => {
  // Failure mode dicegah: riwayat percakapan bertambah menghasilkan hash berbeda sehingga prompt cache hancur (cache miss terus menerus).
  const turn1 = {
    model: "gpt-5-codex",
    instructions: "You are a code assistant",
    tools: [{ type: "function", name: "exec", description: "run" }],
    input: [{ role: "user", content: "first question" }],
  };
  const turn2 = {
    model: "gpt-5-codex",
    instructions: "You are a code assistant",
    tools: [{ type: "function", name: "exec", description: "run" }],
    input: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ],
  };

  const req1 = await captureCodexRequest({ sessionKey: "apikey:key-99", sessionSource: "apikey", body: turn1 });
  const req2 = await captureCodexRequest({ sessionKey: "apikey:key-99", sessionSource: "apikey", body: turn2 });

  assert.match(req1.body.prompt_cache_key, /^zr-[a-f0-9]{32}$/);
  assert.strictEqual(req1.body.prompt_cache_key, req2.body.prompt_cache_key, "request 1 dan request 2 dalam percakapan sama harus punya key identik");
  assert.strictEqual(req1.headers.session_id, undefined, "derived key tidak boleh dikirim sebagai session_id header");
  assert.strictEqual(req2.headers.session_id, undefined);
});

test("AC2: Codex executor - client prompt_cache_key is prioritized and never overwritten; raw apikey and metadata are never sent", async () => {
  // Failure mode dicegah: menimpa key eksplisit dari klien, atau membocorkan string identitas mentah seperti apikey dan metadata.user_id ke upstream body.
  const reqWithClientKey = await captureCodexRequest({
    sessionKey: "apikey:key-abc",
    sessionSource: "apikey",
    body: {
      model: "gpt-5-codex",
      prompt_cache_key: "custom-client-key-xyz",
      input: [{ role: "user", content: "hello" }],
    },
  });
  assert.strictEqual(reqWithClientKey.body.prompt_cache_key, "custom-client-key-xyz", "key klien tidak boleh ditimpa");

  const reqWithMetadata = await captureCodexRequest({
    sessionKey: "apikey:secret-token-123",
    sessionSource: "apikey",
    body: {
      model: "gpt-5-codex",
      metadata: { user_id: "private-user-id" },
      user: "legacy-user-marker",
      input: [{ role: "user", content: "hello" }],
    },
  });
  assert.strictEqual(reqWithMetadata.body.metadata, undefined, "metadata.user_id harus dibersihkan dari body upstream");
  assert.strictEqual(reqWithMetadata.body.user, undefined, "user marker harus dibersihkan");
  assert.strictEqual(JSON.stringify(reqWithMetadata.body).includes("secret-token-123"), false, "apikey mentah tidak pernah muncul di body");
  assert.match(reqWithMetadata.body.prompt_cache_key, /^zr-[a-f0-9]{32}$/);
});

test("AC3: Codex executor - different conversations produce distinct derived prompt_cache_keys", async () => {
  // Failure mode dicegah: collision cache key antar percakapan berbeda yang menyebabkan context contamination / kebocoran jawaban.
  const convA = {
    model: "gpt-5-codex",
    instructions: "System prompt A",
    input: [{ role: "user", content: "question A" }],
  };
  const convB = {
    model: "gpt-5-codex",
    instructions: "System prompt B",
    input: [{ role: "user", content: "question A" }],
  };
  const convC = {
    model: "gpt-5-codex",
    instructions: "System prompt A",
    input: [{ role: "user", content: "question C" }],
  };

  const reqA = await captureCodexRequest({ sessionKey: "apikey:1", sessionSource: "apikey", body: convA });
  const reqB = await captureCodexRequest({ sessionKey: "apikey:1", sessionSource: "apikey", body: convB });
  const reqC = await captureCodexRequest({ sessionKey: "apikey:1", sessionSource: "apikey", body: convC });

  assert.notStrictEqual(reqA.body.prompt_cache_key, reqB.body.prompt_cache_key, "instructions berbeda menghasilkan key berbeda");
  assert.notStrictEqual(reqA.body.prompt_cache_key, reqC.body.prompt_cache_key, "first input berbeda menghasilkan key berbeda");
});
