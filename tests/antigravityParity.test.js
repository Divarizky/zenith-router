import test from "node:test";
import assert from "node:assert";
import { AntigravityExecutor } from "../src/executors/antigravity.js";
import { openaiToGeminiRequest, createGeminiToOpenAITransformStream, geminiToOpenAIResponse } from "../src/translator/gemini.js";
import { antigravityUserAgent, ANTIGRAVITY_VERSION } from "../src/services/antigravityIdentity.js";

function captureExecutor() {
  const seen = {};
  const executor = new AntigravityExecutor({
    fetchFn: async (url, init = {}) => {
      seen.url = url;
      seen.headers = Object.fromEntries(new Headers(init.headers).entries());
      seen.body = JSON.parse(init.body);
      return new Response("{}", { status: 200 });
    },
  });
  return { executor, seen };
}

async function runStream(chunks) {
  const ts = createGeminiToOpenAITransformStream("m");
  const writer = ts.writable.getWriter();
  const reader = ts.readable.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const drain = (async () => {
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value);
    }
    return out;
  })();
  for (const c of chunks) await writer.write(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
  await writer.close();
  return drain;
}

function chunksOf(out) {
  return out
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

test("Antigravity wrapper - membawa requestId per request dan requestType agent", async () => {
  const { executor, seen } = captureExecutor();
  await executor.execute({
    url: "x",
    body: JSON.stringify({ model: "gemini-3.8-flash", contents: [] }),
    connection: { credentials: { project_id: "proj-1" } },
    stream: true,
    targetModel: "gemini-3.8-flash",
  });
  assert.strictEqual(seen.body.requestType, "agent");
  assert.match(seen.body.requestId, /^agent-[0-9a-f-]{36}$/);
  assert.strictEqual(seen.body.userAgent, "antigravity");
  assert.strictEqual(seen.body.project, "proj-1");
});

test("Antigravity wrapper - requestId berbeda untuk tiap request", async () => {
  const { executor, seen } = captureExecutor();
  const args = {
    url: "x",
    body: JSON.stringify({ contents: [] }),
    connection: { credentials: { project_id: "p" } },
    targetModel: "gemini-3.8-flash",
  };
  await executor.execute(args);
  const first = seen.body.requestId;
  await executor.execute(args);
  assert.notStrictEqual(seen.body.requestId, first);
});

test("Antigravity wrapper - User-Agent memakai versi identitas terpusat", async () => {
  const { executor, seen } = captureExecutor();
  await executor.execute({
    url: "x",
    body: JSON.stringify({ contents: [] }),
    connection: { credentials: { project_id: "p" } },
    targetModel: "gemini-3.8-flash",
  });
  assert.strictEqual(seen.headers["user-agent"], antigravityUserAgent());
  assert.ok(seen.headers["user-agent"].startsWith(`antigravity/ide/${ANTIGRAVITY_VERSION} `));
  assert.ok(!seen.headers["user-agent"].includes("0.0.1"));
});

test("Antigravity - tanpa project_id request ditolak, tidak memakai project acak", async () => {
  const { executor, seen } = captureExecutor();
  const res = await executor.execute({
    url: "x",
    body: JSON.stringify({ contents: [] }),
    connection: { credentials: {} },
    targetModel: "gemini-3.8-flash",
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(seen.body, undefined, "upstream tidak boleh dipanggil");
});

test("Antigravity stream - thought part keluar sebagai reasoning_content, bukan content", async () => {
  const out = await runStream([
    { response: { candidates: [{ content: { parts: [{ text: "pikir", thought: true }, { text: "jawab" }] } }] } },
  ]);
  const deltas = chunksOf(out).map((c) => c.choices[0].delta);
  assert.deepStrictEqual(deltas[0], { reasoning_content: "pikir" });
  assert.deepStrictEqual(deltas[1], { content: "jawab" });
});

test("Antigravity stream - MAX_TOKENS menjadi finish_reason length", async () => {
  const out = await runStream([
    { response: { candidates: [{ content: { parts: [{ text: "potong" }] }, finishReason: "MAX_TOKENS" }] } },
  ]);
  const finish = chunksOf(out).find((c) => c.choices[0].finish_reason);
  assert.strictEqual(finish.choices[0].finish_reason, "length");
});

test("Antigravity stream - usage memasukkan reasoning dan cache", async () => {
  const out = await runStream([
    {
      response: {
        candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 50,
          cachedContentTokenCount: 80,
          totalTokenCount: 170,
        },
      },
    },
  ]);
  const usage = chunksOf(out).find((c) => c.usage).usage;
  assert.strictEqual(usage.prompt_tokens, 100);
  assert.strictEqual(usage.completion_tokens, 70);
  assert.strictEqual(usage.total_tokens, 170);
  assert.deepStrictEqual(usage.prompt_tokens_details, { cached_tokens: 80 });
  assert.deepStrictEqual(usage.completion_tokens_details, { reasoning_tokens: 50 });
});

test("Gemini non-stream - thought dipisah ke reasoning_content dan MAX_TOKENS jadi length", async () => {
  const res = await geminiToOpenAIResponse(
    {
      response: {
        candidates: [{ content: { parts: [{ text: "pikir", thought: true }, { text: "jawab" }] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 4 },
      },
    },
    "m"
  );
  assert.strictEqual(res.choices[0].message.content, "jawab");
  assert.strictEqual(res.choices[0].message.reasoning_content, "pikir");
  assert.strictEqual(res.choices[0].finish_reason, "length");
  assert.strictEqual(res.usage.completion_tokens, 6);
});

test("Gemini request - tool_choice required dan nama tertentu jadi functionCallingConfig", () => {
  const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
  const base = { model: "m", messages: [{ role: "user", content: "hi" }], tools };

  const req = openaiToGeminiRequest({ ...base, tool_choice: "required" }, "m");
  assert.deepStrictEqual(req.toolConfig, { functionCallingConfig: { mode: "ANY" } });

  const named = openaiToGeminiRequest({ ...base, tool_choice: { type: "function", function: { name: "read_file" } } }, "m");
  assert.deepStrictEqual(named.toolConfig, {
    functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] },
  });

  const none = openaiToGeminiRequest({ ...base, tool_choice: "none" }, "m");
  assert.deepStrictEqual(none.toolConfig, { functionCallingConfig: { mode: "NONE" } });
});

test("Gemini request - tanpa tools tidak ada toolConfig", () => {
  const req = openaiToGeminiRequest({ model: "m", messages: [{ role: "user", content: "hi" }], tool_choice: "required" }, "m");
  assert.strictEqual(req.toolConfig, undefined);
});

test("Gemini request - stop dan top_k masuk generationConfig, stop dibatasi 5", () => {
  const req = openaiToGeminiRequest(
    {
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stop: ["a", "b", "c", "d", "e", "f"],
      top_k: 40,
    },
    "m"
  );
  assert.deepStrictEqual(req.generationConfig.stopSequences, ["a", "b", "c", "d", "e"]);
  assert.strictEqual(req.generationConfig.topK, 40);

  const single = openaiToGeminiRequest({ model: "m", messages: [{ role: "user", content: "hi" }], stop: "END" }, "m");
  assert.deepStrictEqual(single.generationConfig.stopSequences, ["END"]);
});
