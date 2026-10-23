import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { createChainStore } from "../src/services/deepseekWeb/chains.js";
import { runChainTurn } from "../src/services/deepseekWeb/turns.js";
import { DeepSeekWebError } from "../src/services/deepseekWeb/transport.js";

const TOOLS = [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } }];
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });
const CONNECTION = { id: 21, provider: "deepseek-web", auth_type: "session" };

function setup() {
  initDb(":memory:");
  setSetting("max_account_concurrency", "3");
  return createChainStore();
}

/** Records every call; `complete` can be scripted per call. */
function fakeTransport(script = []) {
  const calls = { create: [], complete: [], deleted: [] };
  let sessions = 0;
  return {
    calls,
    async createSession() {
      sessions += 1;
      calls.create.push(sessions);
      return { chatSessionId: `chat-${sessions}` };
    },
    async complete(args) {
      calls.complete.push(args);
      const step = script[calls.complete.length - 1];
      if (typeof step === "function") return step(args);
      return { text: "ok", reasoning: "", parentMessageId: `msg-${calls.complete.length}` };
    },
    async deleteSession({ chatSessionId }) {
      calls.deleted.push(chatSessionId);
    },
  };
}

const turn = (store, transport, messages, extra = {}) =>
  runChainTurn({ store, transport, connection: CONNECTION, messages, tools: TOOLS, sessionKey: "apikey:1", ...extra });

// Deletion is fire-and-forget; let it settle before asserting.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("turns - two conversations under one session key keep their own chats", async () => {
  const store = setup();
  const transport = fakeTransport();

  await turn(store, transport, [user("tugas utama")]);
  await turn(store, transport, [user("tugas subagent")]);
  await turn(store, transport, [user("tugas utama"), assistant("ok"), user("lanjut utama")]);
  await turn(store, transport, [user("tugas subagent"), assistant("ok"), user("lanjut subagent")]);

  assert.strictEqual(transport.calls.create.length, 2, "one web chat per conversation, no ping-pong resets");
  assert.deepStrictEqual(
    transport.calls.complete.map((call) => call.mode),
    ["full", "full", "delta", "delta"]
  );
  assert.strictEqual(store.stats(21).main, 2);
});

test("turns - conversations under one session key run in parallel", async () => {
  const store = setup();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let inFlight = 0;
  let peak = 0;
  const slow = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await gate;
    inFlight -= 1;
    return { text: "ok", reasoning: "", parentMessageId: "m" };
  };
  const transport = fakeTransport([slow, slow]);

  const both = Promise.all([turn(store, transport, [user("a")]), turn(store, transport, [user("b")])]);
  await settle();
  await settle();
  release();
  await both;
  assert.strictEqual(peak, 2, "different conversations do not wait on one lock");
});

test("turns - a delta turn the upstream refuses is retried once on a fresh chat", async () => {
  const store = setup();
  const refused = () => {
    throw new DeepSeekWebError("DeepSeek Web refused the request (biz_code 26): invalid message id", {
      code: "upstream_rejected",
      bizCode: 26,
    });
  };
  const transport = fakeTransport([undefined, refused]);

  await turn(store, transport, [user("satu")]);
  const history = [user("satu"), assistant("ok"), user("dua")];
  const result = await turn(store, transport, history);

  assert.strictEqual(result.retried, true);
  assert.strictEqual(result.text, "ok");
  assert.deepStrictEqual(
    transport.calls.complete.map((call) => call.mode),
    ["full", "delta", "full"]
  );
  assert.deepStrictEqual(transport.calls.complete[2].messages, history, "the retry carries the whole history");
  assert.strictEqual(transport.calls.complete[2].chatSessionId, "chat-2");
  await settle();
  assert.deepStrictEqual(transport.calls.deleted, ["chat-1"], "the broken chat is removed");
});

test("turns - a failed full render is not retried", async () => {
  const store = setup();
  const refused = () => {
    throw new DeepSeekWebError("too long", { code: "upstream_rejected", bizCode: 99 });
  };
  const transport = fakeTransport([refused]);

  await assert.rejects(turn(store, transport, [user("satu")]), (err) => err.code === "upstream_rejected");
  assert.strictEqual(transport.calls.complete.length, 1);
});

test("turns - other errors are not retried", async () => {
  const store = setup();
  const expired = () => {
    throw new DeepSeekWebError("dead", { status: 401, code: "invalid_token", authExpired: true });
  };
  const transport = fakeTransport([undefined, expired]);

  await turn(store, transport, [user("satu")]);
  await assert.rejects(turn(store, transport, [user("satu"), assistant("ok"), user("dua")]), (err) => err.status === 401);
  assert.strictEqual(transport.calls.complete.length, 2);
});

test("turns - a reset retires the old chat unless sessions are kept", async () => {
  const store = setup();
  const transport = fakeTransport();

  await turn(store, transport, [user("satu")]);
  // Same history again: the chain resets onto a new chat.
  await turn(store, transport, [user("satu")]);
  await settle();
  assert.deepStrictEqual(transport.calls.deleted, ["chat-1"]);

  process.env.ZENITH_DEEPSEEK_KEEP_SESSIONS = "1";
  try {
    await turn(store, transport, [user("satu")]);
    await settle();
    assert.deepStrictEqual(transport.calls.deleted, ["chat-1"], "kept when the user opts out");
  } finally {
    delete process.env.ZENITH_DEEPSEEK_KEEP_SESSIONS;
  }
});

test("turns - the full history and the reasoning callback reach the transport", async () => {
  const store = setup();
  const transport = fakeTransport();
  const onReasoning = () => {};

  await turn(store, transport, [user("satu")]);
  const history = [user("satu"), assistant("ok"), user("dua")];
  await turn(store, transport, history, { onReasoning, thinking: true });

  const call = transport.calls.complete[1];
  assert.strictEqual(call.mode, "delta");
  assert.deepStrictEqual(call.history, history);
  assert.strictEqual(call.onReasoning, onReasoning);
  assert.strictEqual(call.thinking, true);
});

test("turns - an unreadable tool call is retried once on a fresh chat", async () => {
  const store = setup();
  const broken = () => ({ text: 'Saya commit.\n<tool_call>{"name": "bash", "arguments": {"command": git commit}}</tool_call>' });
  const transport = fakeTransport([broken]);

  const result = await turn(store, transport, [user("commit")], { tools: TOOLS });

  assert.strictEqual(result.retried, true);
  assert.strictEqual(result.text, "ok");
  assert.deepStrictEqual(
    transport.calls.complete.map((call) => call.mode),
    ["full", "full"]
  );
  assert.strictEqual(transport.calls.complete[1].chatSessionId, "chat-2");
  await settle();
  assert.deepStrictEqual(transport.calls.deleted, ["chat-1"], "the chat that produced the broken call is removed");
});

test("turns - a tool call that is still unreadable after the retry fails with 502", async () => {
  const store = setup();
  const broken = () => ({ text: '<tool_call>{"name": broken}</tool_call>' });
  const transport = fakeTransport([broken, broken]);

  await assert.rejects(turn(store, transport, [user("commit")]), (err) => err.code === "malformed_tool_call" && err.status === 502);
  assert.strictEqual(transport.calls.complete.length, 2, "one retry, no more");
});

test("turns - a chat upstream now reads as too long is replaced by a fresh one", async () => {
  const store = setup();
  const tooLong = () => {
    throw new DeepSeekWebError("DeepSeek Web refused the turn as too long (status=none; events=close)", {
      status: 413,
      code: "conversation_limit",
    });
  };
  const transport = fakeTransport([undefined, tooLong]);

  await turn(store, transport, [user("satu")]);
  const result = await turn(store, transport, [user("satu"), assistant("ok"), user("dua")]);

  assert.strictEqual(result.retried, true);
  assert.strictEqual(result.text, "ok");
  assert.deepStrictEqual(transport.calls.complete.map((call) => call.mode), ["full", "delta", "full"]);
  assert.strictEqual(transport.calls.complete[2].chatSessionId, "chat-2");
});

test("turns - a withheld reply is reported without retrying", async () => {
  const store = setup();
  const filtered = () => {
    throw new DeepSeekWebError("DeepSeek Web withheld the reply (status=CONTENT_FILTER)", {
      status: 400,
      code: "content_filtered",
    });
  };
  const transport = fakeTransport([undefined, filtered]);

  await turn(store, transport, [user("satu")]);
  await assert.rejects(turn(store, transport, [user("satu"), assistant("ok"), user("dua")]), (err) => err.code === "content_filtered");
  assert.strictEqual(transport.calls.complete.length, 2, "a filter is not a chat-state problem");
});
