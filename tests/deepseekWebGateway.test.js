import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { app } from "../src/index.js";
import { addConnection, initDb } from "../src/db/index.js";
import { setSetting } from "../src/services/settings.js";
import { resetTrafficGuardState } from "../src/services/trafficGuard.js";
import { chainStats, resetChainStore } from "../src/services/deepseekWeb/chains.js";
import { createDeepSeekWebTransport, resetDeepSeekTransportFactory, setDeepSeekTransportFactory } from "../src/services/deepseekWeb/transport.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/deepseekWeb/pow-challenge.json", import.meta.url), "utf8")
);
const FIXED_NOW = Number(fixture.expire_at) - 1000;

const HISTORY = {
  data: {
    biz_data: {
      chat_messages: [
        { role: "USER", fragments: [{ type: "REQUEST", content: "halo" }] },
        {
          role: "ASSISTANT",
          message_id: "msg-1",
          fragments: [
            { type: "THINKING", content: "renung" },
            { type: "RESPONSE", content: "jawaban web" },
          ],
        },
      ],
    },
  },
};

function fakeUpstream() {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers || {} });
    if (target.endsWith("/chat/create_pow_challenge")) {
      return new Response(JSON.stringify({ data: { biz_data: { challenge: fixture } } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (target.endsWith("/chat_session/create")) {
      return new Response(JSON.stringify({ data: { biz_data: { chat_session: { id: "sess-1" } } } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (target.endsWith("/chat/completion")) {
      return new Response('data: {"fragments":[{"type":"RESPONSE","content":"jawaban web"}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (target.includes("/history_messages")) {
      return new Response(JSON.stringify(HISTORY), { headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected url ${target}`);
  };
  return { calls, fetchFn };
}

function seed(settings = {}) {
  initDb(":memory:");
  resetTrafficGuardState();
  resetChainStore();
  setSetting("request_jitter_enabled", "false");
  setSetting("traffic_guard_enabled", "true");
  setSetting("provider_throttle_ms:deepseek-web", "0");
  for (const [key, value] of Object.entries(settings)) setSetting(key, value);
  addConnection({
    provider: "deepseek-web",
    name: "Web",
    auth_type: "session",
    credentials: { token: "tok_abc", cookies: "a=1" },
  });
}

const chatRequest = (extraHeaders = {}, body = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...extraHeaders },
  body: JSON.stringify({
    model: "deepseek-web/deepseek-chat",
    messages: [{ role: "user", content: "halo" }],
    ...body,
  }),
});

test("gateway - deepseek-web resolves the model and answers a turn end to end", async () => {
  seed();
  const fake = fakeUpstream();
  setDeepSeekTransportFactory((connection, options) =>
    createDeepSeekWebTransport(connection, { fetchFn: fake.fetchFn, now: () => FIXED_NOW, ...options })
  );

  try {
    const res = await app.request("/v1/chat/completions", chatRequest({ "x-session-id": "s1" }));
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.model, "deepseek-chat", "the response echoes the upstream model id");
    assert.strictEqual(json.choices[0].message.content, "jawaban web");
    assert.strictEqual(json.choices[0].message.reasoning_content, "renung");
    assert.ok(json.usage.total_tokens > 0);

    const paths = fake.calls.map((call) => new URL(call.url).pathname);
    assert.deepStrictEqual(paths, [
      "/api/v0/chat_session/create",
      "/api/v0/chat/create_pow_challenge",
      "/api/v0/chat/completion",
      "/api/v0/chat/history_messages",
    ]);
    assert.strictEqual(fake.calls[0].headers.Authorization, "Bearer tok_abc");
    // No tools in this request, so it belongs to an auxiliary chain.
    assert.deepStrictEqual(chainStats(), { main: 0, aux: 1, busy: 0, total: 1 });
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("gateway - a tools request carries the tool contract and streams OpenAI chunks", async () => {
  seed();
  const fake = fakeUpstream();
  setDeepSeekTransportFactory((connection, options) =>
    createDeepSeekWebTransport(connection, { fetchFn: fake.fetchFn, now: () => FIXED_NOW, ...options })
  );

  try {
    const res = await app.request(
      "/v1/chat/completions",
      chatRequest(
        { "x-session-id": "s2" },
        {
          stream: true,
          tools: [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object" } } }],
        }
      )
    );
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.match(text, /"object":"chat\.completion\.chunk"/);
    assert.match(text, /jawaban web/);
    assert.match(text, /data: \[DONE\]/);

    const prompt = fake.calls.find((call) => call.url.endsWith("/chat/completion")).body.prompt;
    assert.match(prompt, /- bash: run/);
    assert.match(prompt, /\[Reminder: you have tools/);
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("gateway - four parallel conversations run at most two turns and the third waits", async () => {
  seed();

  let active = 0;
  let maxActive = 0;
  let sessions = 0;
  let messages = 0;
  setDeepSeekTransportFactory(() => ({
    async createSession() {
      sessions += 1;
      return { chatSessionId: `chat-${sessions}` };
    },
    async complete() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 80));
      messages += 1;
      active -= 1;
      return { text: `balasan ${messages}`, reasoning: "", parentMessageId: `msg-${messages}` };
    },
  }));

  try {
    const responses = await Promise.all(
      ["a", "b", "c", "d"].map((session) => app.request("/v1/chat/completions", chatRequest({ "x-session-id": session })))
    );

    for (const res of responses) assert.strictEqual(res.status, 200);
    assert.strictEqual(maxActive, 2, "the third turn waits for a free slot");
    assert.strictEqual(messages, 4);
  } finally {
    resetDeepSeekTransportFactory();
  }
});

const CALL_REPLY = 'Aku jalankan.\n<tool_call>{"name":"bash","arguments":{"command":"ls -la"}}</tool_call>';
const CLAUDE_TOOLS = [
  { name: "bash", description: "run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
];

function staticReply(text) {
  let sessions = 0;
  let turns = 0;
  return () => ({
    async createSession() {
      sessions += 1;
      return { chatSessionId: `chat-${sessions}` };
    },
    async complete() {
      turns += 1;
      return { text, reasoning: "", parentMessageId: `msg-${turns}` };
    },
  });
}

test("gateway - a web tool call reaches a Claude client as tool_use", async () => {
  seed();
  setDeepSeekTransportFactory(staticReply(CALL_REPLY));

  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "claude-1" },
      body: JSON.stringify({
        model: "dsw/deepseek-chat",
        max_tokens: 200,
        tools: CLAUDE_TOOLS,
        messages: [{ role: "user", content: "cek folder" }],
      }),
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.stop_reason, "tool_use");
    const toolUse = json.content.find((block) => block.type === "tool_use");
    assert.ok(toolUse, "the tag block became a tool_use block");
    assert.strictEqual(toolUse.name, "bash");
    assert.deepStrictEqual(toolUse.input, { command: "ls -la" });
    assert.ok(json.content.some((block) => block.type === "text" && block.text.includes("Aku jalankan")));
    assert.ok(!JSON.stringify(json.content).includes("<tool_call>"), "no markup leaks into Claude content");
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("gateway - Claude streaming translates the call delta into a tool_use block", async () => {
  seed();
  setDeepSeekTransportFactory(staticReply(CALL_REPLY));

  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "claude-2" },
      body: JSON.stringify({
        model: "dsw/deepseek-chat",
        max_tokens: 200,
        stream: true,
        tools: CLAUDE_TOOLS,
        messages: [{ role: "user", content: "cek folder" }],
      }),
    });

    assert.strictEqual(res.status, 200);
    const text = await res.text();
    const events = text
      .split("\n\n")
      .map((frame) => frame.split("\n").find((line) => line.startsWith("data: ")))
      .filter(Boolean)
      .map((line) => JSON.parse(line.slice("data: ".length)));

    const start = events.find((event) => event.type === "content_block_start" && event.content_block?.type === "tool_use");
    assert.ok(start, "a tool_use block opens");
    assert.strictEqual(start.content_block.name, "bash");
    const delta = events.find((event) => event.type === "content_block_delta" && event.delta?.type === "input_json_delta");
    assert.ok(delta, "the arguments stream as input_json_delta");
    const messageDelta = events.find((event) => event.type === "message_delta");
    assert.strictEqual(messageDelta.delta.stop_reason, "tool_use");
  } finally {
    resetDeepSeekTransportFactory();
  }
});

test("gateway - a web tool call becomes a Responses function_call item", async () => {
  seed();
  setDeepSeekTransportFactory(staticReply(CALL_REPLY));

  try {
    const res = await app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": "resp-1" },
      body: JSON.stringify({
        model: "dsw/deepseek-chat",
        input: "cek folder",
        tools: [{ type: "function", name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } } } }],
      }),
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    const call = json.output.find((item) => item.type === "function_call");
    assert.ok(call, "the call is a function_call item");
    assert.strictEqual(call.name, "bash");
    assert.deepStrictEqual(JSON.parse(call.arguments), { command: "ls -la" });
  } finally {
    resetDeepSeekTransportFactory();
  }
});
