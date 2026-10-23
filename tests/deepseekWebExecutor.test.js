import test from "node:test";
import assert from "node:assert";
import { DeepSeekWebExecutor } from "../src/executors/deepseekWeb.js";
import { buildChainKey, conversationId, createChainStore } from "../src/services/deepseekWeb/chains.js";
import { initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { resetDeepSeekTransportFactory } from "../src/services/deepseekWeb/transport.js";

const TOOLS = [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object" } } }];
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });

function fakeTransport({ text = "jawaban web", failAt = null, authExpired = false } = {}) {
  const calls = { create: [], complete: [] };
  let sessions = 0;
  let turns = 0;
  return {
    calls,
    async createSession(args) {
      calls.create.push(args);
      sessions += 1;
      return { chatSessionId: `chat-${sessions}` };
    },
    async complete(args) {
      calls.complete.push(args);
      turns += 1;
      if (failAt === turns) {
        throw Object.assign(new Error("web upstream exploded"), { status: 500, code: "upstream_error", authExpired });
      }
      return { text, reasoning: "renungan", parentMessageId: `msg-${turns}` };
    },
  };
}

function setup(transport) {
  initDb(":memory:");
  setSetting("traffic_guard_enabled", "true");
  setSetting("request_jitter_enabled", "false");
  setSetting("max_account_concurrency", "2");
  const store = createChainStore();
  const executor = new DeepSeekWebExecutor({ transportResolver: () => transport, store });
  const connection = { id: 11, provider: "deepseek-web", auth_type: "session" };
  return { store, executor, connection };
}

const payload = (messages, extra = {}) => JSON.stringify({ model: "deepseek-chat", messages, ...extra });
// Chains are keyed by conversation too: the first non-system message names it.
const keyFor = (sessionKey, messages, purpose = "main") =>
  buildChainKey({ connectionId: 11, purpose, sessionKey, conversation: conversationId(messages) });

test("executor - a reasoning model asks upstream for thinking and streams it", async () => {
  const transport = fakeTransport();
  const { executor, connection } = setup(transport);
  const request = () =>
    executor.execute({
      body: payload([user("kenapa langit biru?")]),
      connection,
      sessionKey: "client-reason",
      targetModel: "deepseek-reasoner",
      stream: true,
    });

  const streamed = await request();
  assert.strictEqual(streamed.status, 200);
  const frames = (await streamed.text())
    .split("\n\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  const reasoning = frames.find((frame) => frame.choices?.[0]?.delta?.reasoning_content);
  assert.ok(reasoning, "the reasoning arrives as its own delta");
  assert.strictEqual(reasoning.choices[0].delta.reasoning_content, "renungan");

  // The flag travels with the turn, not with the response shaping.
  assert.strictEqual(transport.calls.complete[0].thinking, true);
});

test("executor - the chat model keeps thinking off", async () => {
  const transport = fakeTransport();
  const { executor, connection } = setup(transport);

  await executor.execute({
    body: payload([user("halo")], { tools: TOOLS }),
    connection,
    sessionKey: "client-chat",
    targetModel: "deepseek-chat",
  });

  assert.strictEqual(transport.calls.complete[0].thinking, false);
});

test("executor - first turn opens a session and sends the full render", async () => {
  const transport = fakeTransport();
  const { store, executor, connection } = setup(transport);

  const res = await executor.execute({
    body: payload([user("halo")], { tools: TOOLS }),
    connection,
    sessionKey: "client-a",
    targetModel: "deepseek-chat",
  });

  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.object, "chat.completion");
  assert.strictEqual(json.choices[0].message.content, "jawaban web");
  assert.strictEqual(json.choices[0].message.reasoning_content, "renungan");
  assert.strictEqual(json.choices[0].finish_reason, "stop");
  assert.ok(json.usage.total_tokens > 0);

  assert.strictEqual(transport.calls.create.length, 1, "a new web chat session is created");
  assert.strictEqual(transport.calls.complete[0].mode, "full");
  assert.deepStrictEqual(transport.calls.complete[0].messages, [user("halo")]);
  assert.strictEqual(transport.calls.complete[0].parentMessageId, null);

  const key = keyFor("client-a", [user("halo")]);
  const chain = store.get(key);
  assert.strictEqual(chain.chatSessionId, "chat-1");
  assert.strictEqual(chain.count, 1, "the watermark counts the forwarded messages");
  assert.strictEqual(chain.parentMessageId, "msg-1");
  assert.strictEqual(chain.busy, false, "the chain is idle again after the turn");
  assert.ok(chain.fingerprint);
});

test("executor - a continued turn sends only the delta and reuses the session", async () => {
  const transport = fakeTransport();
  const { store, executor, connection } = setup(transport);
  const key = keyFor("client-a", [user("satu")]);

  await executor.execute({ body: payload([user("satu")], { tools: TOOLS }), connection, sessionKey: "client-a" });

  const history = [user("satu"), assistant("jawaban web"), user("dua")];
  const res = await executor.execute({ body: payload(history, { tools: TOOLS }), connection, sessionKey: "client-a" });
  assert.strictEqual((await res.json()).choices[0].message.content, "jawaban web");

  assert.strictEqual(transport.calls.create.length, 1, "the existing session is reused");
  assert.strictEqual(transport.calls.complete[1].mode, "delta");
  assert.deepStrictEqual(transport.calls.complete[1].messages, [assistant("jawaban web"), user("dua")]);
  assert.strictEqual(transport.calls.complete[1].parentMessageId, "msg-1", "the delta hangs off the last reply");

  const chain = store.get(key);
  assert.strictEqual(chain.count, 3);
  assert.strictEqual(chain.parentMessageId, "msg-2");
});

test("executor - an edited history or an identical retry resets to a new session", async () => {
  const transport = fakeTransport();
  const { executor, connection } = setup(transport);

  await executor.execute({ body: payload([user("satu")], { tools: TOOLS }), connection, sessionKey: "s" });

  // Same history as last turn: the previous reply may not have been consumed.
  await executor.execute({ body: payload([user("satu")], { tools: TOOLS }), connection, sessionKey: "s" });
  assert.strictEqual(transport.calls.complete[1].mode, "full");
  assert.strictEqual(transport.calls.create.length, 2);

  // Edited history at the anchor.
  await executor.execute({ body: payload([user("diedit")], { tools: TOOLS }), connection, sessionKey: "s" });
  assert.strictEqual(transport.calls.complete[2].mode, "full");
  assert.strictEqual(transport.calls.create.length, 3);
});

test("executor - a failed turn marks the chain dirty and the next turn starts over", async () => {
  const transport = fakeTransport({ failAt: 1 });
  const { store, executor, connection } = setup(transport);
  const key = keyFor("s", [user("satu")]);

  const res = await executor.execute({ body: payload([user("satu")], { tools: TOOLS }), connection, sessionKey: "s" });
  assert.strictEqual(res.status, 500, "the upstream status is passed through");
  const json = await res.json();
  assert.strictEqual(json.error.code, "upstream_error");
  assert.strictEqual(store.get(key).dirty, true);

  const ok = await executor.execute({ body: payload([user("satu")], { tools: TOOLS }), connection, sessionKey: "s" });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(transport.calls.complete[1].mode, "full", "a dirty chain never appends to the old chat");
  assert.strictEqual(transport.calls.create.length, 2);
  assert.strictEqual(store.get(key).dirty, false);
});

test("executor - the expired-session header follows the transport error", async () => {
  const transport = {
    async createSession() {
      return { chatSessionId: "chat-expired" };
    },
    async complete() {
      throw Object.assign(new Error("token mati"), { status: 401, code: "invalid_token", authExpired: true });
    },
  };
  const { executor, connection } = setup(transport);

  const res = await executor.execute({ body: payload([user("x")], { tools: TOOLS }), connection });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.get("x-zenith-auth-expired"), "1");
});

test("executor - a client abort returns 499 and leaves the chain dirty when a turn had started", async () => {
  const { executor, connection, store } = setup(fakeTransport());
  const key = keyFor("s", [user("satu")]);
  const startedKey = keyFor("s", [user("dua")]);

  const preAborted = new AbortController();
  preAborted.abort();
  const early = await executor.execute({
    body: payload([user("satu")], { tools: TOOLS }),
    connection,
    sessionKey: "s",
    signal: preAborted.signal,
  });
  assert.strictEqual(early.status, 499);
  assert.strictEqual(store.get(key), null, "nothing was sent upstream, so no chain state exists");

  const controller = new AbortController();
  const aborting = {
    async createSession() {
      return { chatSessionId: "chat-abort" };
    },
    async complete() {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    },
  };
  const abortExecutor = new DeepSeekWebExecutor({ transportResolver: () => aborting, store });
  const res = await abortExecutor.execute({
    body: payload([user("dua")], { tools: TOOLS }),
    connection,
    sessionKey: "s",
    signal: controller.signal,
  });
  assert.strictEqual(res.status, 499);
  assert.strictEqual(store.get(startedKey).dirty, true, "a turn that reached upstream must not be replayed");
  assert.strictEqual(store.get(startedKey).busy, false);
});

test("executor - streaming emits OpenAI chunks and an optional usage chunk", async () => {
  const transport = fakeTransport({ text: "halo" });
  const { executor, connection } = setup(transport);

  const res = await executor.execute({
    body: payload([user("hi")], { tools: TOOLS, stream: true, stream_options: { include_usage: true } }),
    connection,
    stream: true,
  });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/event-stream/);

  const text = await res.text();
  const frames = text
    .split("\n\n")
    .filter(Boolean)
    .map((line) => line.replace(/^data: /, ""));
  assert.strictEqual(frames.at(-1), "[DONE]");

  const chunks = frames.slice(0, -1).map((frame) => JSON.parse(frame));
  assert.strictEqual(chunks[0].object, "chat.completion.chunk");
  assert.deepStrictEqual(chunks[0].choices[0].delta, { role: "assistant" });
  // A reasoning delta may precede the answer, so find frames by content, not index.
  const answer = chunks.find((chunk) => typeof chunk.choices[0]?.delta?.content === "string");
  assert.strictEqual(answer.choices[0].delta.content, "halo");
  assert.strictEqual(chunks.find((chunk) => chunk.choices[0]?.finish_reason === "stop").choices[0].finish_reason, "stop");
  assert.ok(chunks.at(-1).usage.total_tokens > 0, "the usage chunk feeds the gateway token tap");
});

test("executor - a call without tools uses its own auxiliary chain", async () => {
  const transport = fakeTransport();
  const { store, executor, connection } = setup(transport);

  await executor.execute({ body: payload([user("judul sesi")]), connection, sessionKey: "s" });
  await executor.execute({ body: payload([user("kerjaan")], { tools: TOOLS }), connection, sessionKey: "s" });

  assert.deepStrictEqual(store.stats(11), { main: 1, aux: 1, busy: 0, total: 2 });
  assert.strictEqual(transport.calls.create.length, 2, "the auxiliary chain has its own web session");
  assert.strictEqual(transport.calls.complete[0].messages.length, 1);
});

test("executor - aborting while the session opens leaves no chain behind", async () => {
  const controller = new AbortController();
  const transport = {
    async createSession() {
      controller.abort();
      return { chatSessionId: "chat-late" };
    },
    async complete() {
      throw new Error("the turn must not be sent after the client hung up");
    },
  };
  const { executor, connection, store } = setup(transport);

  const res = await executor.execute({
    body: payload([user("x")], { tools: TOOLS }),
    connection,
    sessionKey: "s",
    signal: controller.signal,
  });

  assert.strictEqual(res.status, 499);
  assert.strictEqual(store.get(keyFor("s", [user("x")])), null);
});

test("executor - missing credentials fail before touching upstream", async () => {
  resetDeepSeekTransportFactory();
  initDb(":memory:");
  const executor = new DeepSeekWebExecutor();
  const connection = { id: 11, provider: "deepseek-web", auth_type: "session", credentials: {} };

  const missingToken = await executor.execute({ body: payload([user("hi")], { tools: TOOLS }), connection });
  assert.strictEqual(missingToken.status, 401);
  assert.strictEqual(missingToken.headers.get("x-zenith-auth-expired"), "1");
  assert.strictEqual((await missingToken.json()).error.code, "invalid_token");

  const badJson = await executor.execute({ body: "{not json", connection });
  assert.strictEqual(badJson.status, 400);
  assert.strictEqual((await badJson.json()).error.code, "invalid_request");

  const empty = await executor.execute({ body: payload([]), connection });
  assert.strictEqual(empty.status, 400);
});

function parseSse(text) {
  return text
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => frame.slice("data: ".length))
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

test("executor - a tagged tool call becomes native tool_calls and leaves content empty", async () => {
  const reply = `Aku cek dulu.\n<tool_call>{"name":"bash","arguments":{"command":"ls -la"}}</tool_call>`;
  const transport = fakeTransport({ text: reply });
  const { executor, connection } = setup(transport);

  const res = await executor.execute({
    body: payload([user("cek folder")], { tools: TOOLS }),
    connection,
    sessionKey: "tools-a",
    targetModel: "deepseek-chat",
  });

  const json = await res.json();
  const choice = json.choices[0];
  assert.strictEqual(res.status, 200);
  assert.strictEqual(choice.finish_reason, "tool_calls");
  assert.strictEqual(choice.message.content, "Aku cek dulu.", "markup never reaches the content");
  assert.strictEqual(choice.message.tool_calls.length, 1);
  assert.match(choice.message.tool_calls[0].id, /^call_/);
  assert.strictEqual(choice.message.tool_calls[0].function.name, "bash");
  assert.deepStrictEqual(JSON.parse(choice.message.tool_calls[0].function.arguments), { command: "ls -la" });
  assert.ok(json.usage.completion_tokens > 0);
});

test("executor - a reply that is only a tool call has null content", async () => {
  const transport = fakeTransport({ text: '<tool_call>{"name":"read","arguments":{"path":"/tmp/a"}}</tool_call>' });
  const { executor, connection } = setup(transport);

  const json = await (
    await executor.execute({ body: payload([user("baca")], { tools: TOOLS }), connection, sessionKey: "tools-b" })
  ).json();

  assert.strictEqual(json.choices[0].message.content, null);
  assert.strictEqual(json.choices[0].finish_reason, "tool_calls");
});

test("executor - streaming sends indexed tool_calls then a tool_calls finish reason", async () => {
  const reply = [
    "Sebentar.",
    '<tool_call>{"name":"bash","arguments":{"command":"pwd"}}</tool_call>',
    '<tool_call>{"name":"read","arguments":{"path":"/etc/hosts"}}</tool_call>',
  ].join("\n");
  const transport = fakeTransport({ text: reply });
  const { executor, connection } = setup(transport);

  const res = await executor.execute({
    body: payload([user("cek")], { tools: TOOLS, stream: true, stream_options: { include_usage: true } }),
    connection,
    sessionKey: "tools-c",
    stream: true,
  });

  assert.strictEqual(res.headers.get("content-type"), "text/event-stream");
  const frames = parseSse(await res.text());
  const delta = frames.find((frame) => frame.choices[0]?.delta?.tool_calls);
  assert.ok(delta, "a delta carries the calls");
  assert.strictEqual(delta.choices[0].delta.content, "Sebentar.");
  assert.deepStrictEqual(delta.choices[0].delta.tool_calls.map((call) => call.index), [0, 1]);
  for (const call of delta.choices[0].delta.tool_calls) {
    assert.match(call.id, /^call_/);
    assert.strictEqual(call.type, "function");
    assert.deepStrictEqual(JSON.parse(call.function.arguments), call.function.name === "bash" ? { command: "pwd" } : { path: "/etc/hosts" });
  }
  const finish = frames.find((frame) => frame.choices[0]?.finish_reason);
  assert.strictEqual(finish.choices[0].finish_reason, "tool_calls");
  assert.ok(frames.at(-1).usage, "the usage chunk still closes the stream");
});

test("executor - DSML replies with a long code fence are trimmed before emission", async () => {
  const code = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  const reply = [
    "Ini hasilnya:",
    "```bash",
    code,
    "```",
    `<｜｜DSML｜｜invoke name="bash"><｜｜DSML｜｜parameter name="command" string="true">ls</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>`,
  ].join("\n");
  const transport = fakeTransport({ text: reply });
  const { executor, connection } = setup(transport);

  const json = await (
    await executor.execute({ body: payload([user("jalankan")], { tools: TOOLS }), connection, sessionKey: "tools-d" })
  ).json();
  const message = json.choices[0].message;

  assert.strictEqual(json.choices[0].finish_reason, "tool_calls");
  assert.strictEqual(message.tool_calls[0].function.name, "bash");
  assert.match(message.content, /\.\.\.|… \(trimmed/);
  assert.doesNotMatch(message.content, /line 15/);
  assert.doesNotMatch(message.content, /DSML/);
});

/** Splits an SSE body into parsed JSON frames, dropping [DONE]. */
function framesOf(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((line) => line.replace(/^data: /, ""))
    .filter((frame) => frame !== "[DONE]")
    .map((frame) => JSON.parse(frame));
}

function liveTransport({ pieces, finalReasoning, fail = null }) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    async createSession() {
      return { chatSessionId: "chat-live" };
    },
    async complete({ onReasoning }) {
      onReasoning?.(pieces[0]);
      await gate;
      for (const piece of pieces.slice(1)) onReasoning?.(piece);
      if (fail) throw fail;
      return { text: "jawaban", reasoning: finalReasoning, parentMessageId: "msg-live" };
    },
  };
}

test("executor - reasoning streams before the turn finishes", async () => {
  const transport = liveTransport({ pieces: ["ren", "ungan"], finalReasoning: "renungan panjang" });
  const { executor, connection } = setup(transport);

  const res = await executor.execute({
    body: payload([user("kenapa?")], { stream: true }),
    connection,
    sessionKey: "live",
    targetModel: "deepseek-reasoner",
    stream: true,
  });
  // The response is already open while upstream is still thinking.
  assert.strictEqual(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let early = "";
  while (!early.includes('"ren"')) early += decoder.decode((await reader.read()).value);
  assert.ok(!early.includes("jawaban"), "the answer waits for the end of the turn");

  transport.release();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value);
  }
  const frames = framesOf(early + rest);
  const reasoning = frames.map((frame) => frame.choices?.[0]?.delta?.reasoning_content).filter(Boolean);
  // History held more than the stream delivered: only the rest is sent, nothing twice.
  assert.deepStrictEqual(reasoning, ["ren", "ungan", " panjang"]);
  assert.strictEqual(frames.find((frame) => frame.choices?.[0]?.delta?.content).choices[0].delta.content, "jawaban");
  assert.strictEqual(frames.at(-1).choices[0].finish_reason, "stop");
});

test("executor - a failure after reasoning started arrives inside the stream", async () => {
  const fail = Object.assign(new Error("putus di tengah"), { status: 502, code: "history_incomplete" });
  const transport = liveTransport({ pieces: ["ren"], finalReasoning: "", fail });
  const { executor, connection } = setup(transport);

  const res = await executor.execute({
    body: payload([user("kenapa?")], { stream: true }),
    connection,
    sessionKey: "live-fail",
    targetModel: "deepseek-reasoner",
    stream: true,
  });
  assert.strictEqual(res.status, 200);
  transport.release();
  const frames = framesOf(await res.text());
  assert.strictEqual(frames.at(-1).error.code, "history_incomplete");
  assert.match(frames.at(-1).error.message, /putus di tengah/);
});

test("executor - a failure before any reasoning keeps its status for failover", async () => {
  const transport = {
    async createSession() {
      return { chatSessionId: "chat-dead" };
    },
    async complete() {
      throw Object.assign(new Error("token mati"), { status: 401, code: "invalid_token", authExpired: true });
    },
  };
  const { executor, connection } = setup(transport);

  const res = await executor.execute({
    body: payload([user("x")], { stream: true }),
    connection,
    targetModel: "deepseek-reasoner",
    stream: true,
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.headers.get("x-zenith-auth-expired"), "1");
});

test("executor - usage reports reasoning tokens for the usage tap", async () => {
  const { executor, connection } = setup(fakeTransport());
  const res = await executor.execute({ body: payload([user("x")]), connection, targetModel: "deepseek-reasoner" });
  const json = await res.json();
  assert.ok(json.usage.completion_tokens_details.reasoning_tokens > 0);
  assert.ok(json.usage.completion_tokens >= json.usage.completion_tokens_details.reasoning_tokens);
});
