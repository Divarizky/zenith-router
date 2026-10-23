import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  createDeepSeekWebTransport,
  collectStreamFragments,
  createStreamParser,
  businessError,
  parseHistoryPayload,
  emptyReplyError,
  DeepSeekWebError,
} from "../src/services/deepseekWeb/transport.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/deepseekWeb/pow-challenge.json", import.meta.url), "utf8")
);
// The fixture challenge is only solvable with its own difficulty and salt; its
// expiry is in the past, so the transport clock is pinned just before it.
const FIXED_NOW = Number(fixture.expire_at) - 1000;

const CONNECTION = {
  id: 1,
  provider: "deepseek-web",
  auth_type: "session",
  credentials: { token: "tok_abc", cookies: "a=1; b=2" },
};

const SSE_OK =
  'data: {"v":{"response":{"fragments":[{"type":"THINKING","content":"renung"},{"type":"RESPONSE","content":"jawaban web"}]}}}\n\ndata: [DONE]\n\n';

const HISTORY_OK = {
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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeUpstream(overrides = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: target, method: init.method || "GET", headers: init.headers || {}, body });

    if (target.endsWith("/chat/create_pow_challenge")) {
      if (overrides.challengeStatus) return jsonResponse({ msg: "no" }, overrides.challengeStatus);
      return jsonResponse({ data: { biz_data: { challenge: fixture } } });
    }
    if (target.endsWith("/chat_session/create")) {
      return jsonResponse({ data: { biz_data: { chat_session: { id: "sess-1" } } } });
    }
    if (target.endsWith("/chat/completion")) {
      return new Response(overrides.sse ?? SSE_OK, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (target.includes("/chat/history_messages")) {
      if (overrides.history) return overrides.history(calls);
      return jsonResponse(HISTORY_OK);
    }
    throw new Error(`unexpected url ${target}`);
  };
  return { calls, fetchFn };
}

const makeTransport = (fake, options = {}) =>
  createDeepSeekWebTransport(CONNECTION, { fetchFn: fake.fetchFn, now: () => FIXED_NOW, ...options });

const TOOLS = [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object" } } }];

test("transport - a session opens with the web client's own headers", async () => {
  const fake = fakeUpstream();
  const transport = makeTransport(fake);

  const session = await transport.createSession();
  assert.strictEqual(session.chatSessionId, "sess-1");

  const request = fake.calls[0];
  assert.strictEqual(request.headers.Authorization, "Bearer tok_abc");
  assert.strictEqual(request.headers.Cookie, "a=1; b=2");
  assert.strictEqual(request.headers.Origin, "https://chat.deepseek.com");
  assert.strictEqual(request.headers.Referer, "https://chat.deepseek.com/");
  assert.ok(request.headers["User-Agent"].includes("Firefox"));
});

test("transport - a full turn sends the preamble, solves the PoW, and reads history", async () => {
  const fake = fakeUpstream();
  const transport = makeTransport(fake);

  const reply = await transport.complete({
    chatSessionId: "sess-1",
    parentMessageId: null,
    mode: "full",
    messages: [{ role: "user", content: "halo" }],
    tools: TOOLS,
  });

  assert.deepStrictEqual(reply, { text: "jawaban web", reasoning: "renung", parentMessageId: "msg-1" });
  assert.deepStrictEqual(
    fake.calls.map((call) => new URL(call.url).pathname),
    ["/api/v0/chat/create_pow_challenge", "/api/v0/chat/completion", "/api/v0/chat/history_messages"]
  );

  const challengeCall = fake.calls[0];
  assert.deepStrictEqual(challengeCall.body, { target_path: "/api/v0/chat/completion" });

  const completion = fake.calls[1];
  assert.strictEqual(completion.body.chat_session_id, "sess-1");
  assert.strictEqual(completion.body.parent_message_id, null);
  assert.strictEqual(completion.body.thinking_enabled, false);
  assert.strictEqual(completion.body.search_enabled, false);
  assert.deepStrictEqual(completion.body.ref_file_ids, []);
  assert.match(completion.body.prompt, /RULES:/);
  assert.match(completion.body.prompt, /- bash: run a command/);
  assert.match(completion.body.prompt, /User: halo/);
  assert.match(completion.body.prompt, /\[Reminder: you have tools/);

  const pow = JSON.parse(Buffer.from(completion.headers["x-ds-pow-response"], "base64").toString("utf8"));
  assert.strictEqual(pow.target_path, "/api/v0/chat/completion");
  assert.strictEqual(pow.answer, fixture.expected_answer);
  assert.strictEqual(pow.challenge, fixture.challenge);
});

test("transport - thinking mode flips the flag the web endpoint reads", async () => {
  const fake = fakeUpstream();
  const transport = makeTransport(fake);

  await transport.complete({
    chatSessionId: "sess-1",
    mode: "full",
    messages: [{ role: "user", content: "halo" }],
    thinking: true,
  });

  const completion = fake.calls[1];
  assert.strictEqual(completion.body.thinking_enabled, true);
  // Search stays off: it changes the answer surface and the gateway cannot cite sources.
  assert.strictEqual(completion.body.search_enabled, false);
});

const HISTORY_NEXT = {
  data: {
    biz_data: {
      chat_messages: [
        ...HISTORY_OK.data.biz_data.chat_messages,
        { role: "USER", fragments: [{ type: "REQUEST", content: "lanjut" }] },
        { role: "ASSISTANT", message_id: "msg-2", fragments: [{ type: "RESPONSE", content: "lanjutan" }] },
      ],
    },
  },
};

test("transport - a delta turn without tools stays short and carries no reminder", async () => {
  const fake = fakeUpstream({ history: () => jsonResponse(HISTORY_NEXT) });
  const transport = makeTransport(fake);

  await transport.complete({
    chatSessionId: "sess-1",
    parentMessageId: "msg-1",
    mode: "delta",
    messages: [
      { role: "assistant", content: "jawaban lama" },
      { role: "user", content: "lanjut" },
    ],
    tools: [],
  });

  const prompt = fake.calls[1].body.prompt;
  assert.ok(!prompt.includes("RULES:"), "delta turns must not resend the preamble");
  assert.ok(!prompt.includes("TOOLS:"));
  assert.ok(!prompt.includes("[Reminder: you have tools"));
  assert.match(prompt, /Assistant: jawaban lama/);
  assert.match(prompt, /User: lanjut/);
  assert.strictEqual(fake.calls[1].body.parent_message_id, "msg-1");
});

test("transport - stream text rescues a reply that history has not materialised yet", async () => {
  const fake = fakeUpstream({
    history: () =>
      jsonResponse({
        data: {
          biz_data: {
            chat_messages: [
              { role: "USER", fragments: [{ type: "REQUEST", content: "halo" }] },
              { role: "ASSISTANT", message_id: "msg-9", fragments: [] },
            ],
          },
        },
      }),
  });
  const transport = makeTransport(fake);

  const reply = await transport.complete({
    chatSessionId: "sess-1",
    mode: "delta",
    messages: [{ role: "user", content: "halo" }],
  });

  assert.strictEqual(reply.text, "jawaban web", "the SSE text fills the gap");
  assert.strictEqual(reply.reasoning, "renung");
  assert.strictEqual(reply.parentMessageId, "msg-9");
  const historyCalls = fake.calls.filter((call) => call.url.includes("history_messages"));
  assert.strictEqual(historyCalls.length, 2, "history is retried before falling back");
});

test("transport - history is retried while the assistant message is missing", async () => {
  let historyCalls = 0;
  const fake = fakeUpstream({
    history: () => {
      historyCalls += 1;
      if (historyCalls === 1) {
        return jsonResponse({ data: { biz_data: { chat_messages: [{ role: "USER", fragments: [] }] } } });
      }
      return jsonResponse(HISTORY_OK);
    },
  });
  const transport = makeTransport(fake);

  const reply = await transport.complete({
    chatSessionId: "sess-1",
    mode: "delta",
    messages: [{ role: "user", content: "halo" }],
  });

  assert.strictEqual(reply.text, "jawaban web");
  assert.strictEqual(historyCalls, 2);
});

test("transport - an expired challenge is never sent with a solved header", async () => {
  const fake = fakeUpstream();
  const transport = makeTransport(fake, { now: () => Number(fixture.expire_at) + 5000 });

  await assert.rejects(
    transport.complete({ chatSessionId: "sess-1", mode: "delta", messages: [{ role: "user", content: "x" }] }),
    (err) => err instanceof DeepSeekWebError && err.code === "pow_expired"
  );
  assert.strictEqual(fake.calls.filter((call) => call.url.endsWith("/chat/completion")).length, 0);
  assert.strictEqual(fake.calls.filter((call) => call.url.endsWith("/create_pow_challenge")).length, 2);
});

test("transport - upstream auth and rate limits map to gateway errors", async () => {
  const unauthorized = fakeUpstream({ challengeStatus: 401 });
  await assert.rejects(
    makeTransport(unauthorized).complete({ chatSessionId: "s", mode: "delta", messages: [] }),
    (err) => err instanceof DeepSeekWebError && err.status === 401 && err.authExpired === true
  );

  const limited = fakeUpstream({ challengeStatus: 429 });
  await assert.rejects(
    makeTransport(limited).complete({ chatSessionId: "s", mode: "delta", messages: [] }),
    (err) => err.status === 429 && err.code === "rate_limit_exceeded"
  );
});

test("transport - a connection without a token fails before any network call", async () => {
  const fake = fakeUpstream();
  const transport = createDeepSeekWebTransport(
    { id: 2, provider: "deepseek-web", auth_type: "session", credentials: {} },
    { fetchFn: fake.fetchFn, now: () => FIXED_NOW }
  );

  await assert.rejects(
    transport.createSession(),
    (err) => err.status === 401 && err.authExpired === true
  );
  assert.strictEqual(fake.calls.length, 0);
});

test("transport - fragment and history parsers tolerate cumulative frames and many message shapes", () => {
  const fragments = collectStreamFragments(
    [
      'data: {"fragments":[{"type":"RESPONSE","content":"halo"}]}',
      'data: {"fragments":[{"type":"RESPONSE","content":"halo dunia"}]}',
      'data: {"fragments":[{"type":"THINKING","content":"hmm"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n")
  );
  // One entry per kind: the cumulative frame wins, the delta after it is appended.
  assert.deepStrictEqual(fragments, [
    { type: "RESPONSE", content: "halo dunia" },
    { type: "THINKING", content: "hmm" },
  ]);

  const history = parseHistoryPayload(
    JSON.stringify({
      data: {
        biz_data: {
          chat_messages: [
            { role: "ASSISTANT", message_id: "old", fragments: [{ type: "RESPONSE", content: "lama" }] },
            { role: "USER", fragments: [{ type: "REQUEST", content: "baru" }] },
            { role: "ASSISTANT", message_id: "new", fragments: [{ type: "RESPONSE", content: "baru " }, { type: "RESPONSE", content: "baru sekali" }] },
          ],
        },
      },
    })
  );
  assert.deepStrictEqual(history, { text: "baru sekali", reasoning: "", parentMessageId: "new" });
  assert.strictEqual(parseHistoryPayload("not json"), null);
});

test("transport - the live patch-shaped stream keeps reasoning and answer", () => {
  // Path and op carry over: a frame without `o` (or without `p`) continues the last patch.
  const stream = [
    'data: {"v":{"response":{"message_id":2,"role":"ASSISTANT","thinking_enabled":true,"fragments":[{"type":"THINK","content":"We"}]}}}',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}',
    'data: {"v":" it"}',
    'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"37"}]}',
    'data: {"p":"response/fragments/-1/content","v":" x 48"}',
    'data: {"v":" = 1776"}',
    'data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}]}',
    "data: [DONE]",
    "",
  ].join("\n\n");

  assert.deepStrictEqual(collectStreamFragments(stream), [
    { type: "THINKING", content: "We need it" },
    { type: "RESPONSE", content: "37 x 48 = 1776" },
  ]);
});

test("transport - an APPEND delta that repeats the text so far is still appended", () => {
  const stream = [
    'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"1"}]}}}',
    'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"1"}',
    'data: {"v":"1"}',
    "",
  ].join("\n\n");
  assert.deepStrictEqual(collectStreamFragments(stream), [{ type: "RESPONSE", content: "111" }]);
});

test("transport - the captured live stream parses to exactly what history stored", () => {
  const sse = readFileSync(new URL("./fixtures/deepseekWeb/completion-thinking.sse.txt", import.meta.url), "utf8");
  const historyText = readFileSync(new URL("./fixtures/deepseekWeb/history-thinking.json", import.meta.url), "utf8");
  const history = parseHistoryPayload(historyText);

  const parser = createStreamParser();
  // Feed it in uneven chunks, the way a socket delivers it.
  for (let index = 0; index < sse.length; index += 37) parser.push(sse.slice(index, index + 37));
  parser.end();
  const result = parser.result();

  assert.strictEqual(result.responseMessageId, 2, "event: ready names the new message");
  assert.strictEqual(result.status, "FINISHED");
  assert.deepStrictEqual(result.fragments, [
    { type: "THINKING", content: history.reasoning },
    { type: "RESPONSE", content: history.text },
  ]);
  assert.strictEqual(history.text, "Saya membeli apel, pisang, dan jeruk.");
});

test("transport - reasoning is reported as it streams", () => {
  const sse = readFileSync(new URL("./fixtures/deepseekWeb/completion-thinking.sse.txt", import.meta.url), "utf8");
  const deltas = [];
  const parser = createStreamParser({ onReasoning: (delta) => deltas.push(delta) });
  parser.push(sse);
  parser.end();
  assert.ok(deltas.length > 10, "reasoning arrives in many pieces");
  assert.strictEqual(deltas.join(""), parser.result().fragments[0].content);
});

test("transport - HTTP 200 error bodies become errors", () => {
  const dead = businessError('{"code":40003,"msg":"INVALID_TOKEN","data":null}');
  assert.strictEqual(dead.status, 401);
  assert.strictEqual(dead.authExpired, true);
  assert.strictEqual(businessError('{"code":40002,"msg":"Missing Token","data":null}').authExpired, true);

  const refused = businessError('{"code":0,"msg":"","data":{"biz_code":26,"biz_msg":"invalid message id","biz_data":null}}');
  assert.strictEqual(refused.code, "upstream_rejected");
  assert.strictEqual(refused.bizCode, 26);
  assert.match(refused.message, /invalid message id/);

  assert.strictEqual(businessError('{"code":0,"msg":"","data":{"biz_code":0,"biz_data":{}}}'), null);
  assert.strictEqual(businessError("event: ready\ndata: {}"), null);
});

test("transport - a dead token answered with HTTP 200 marks the account expired", async () => {
  const fetchFn = async () => jsonResponse({ code: 40003, msg: "Authorization Failed (invalid token)", data: null });
  const transport = createDeepSeekWebTransport(CONNECTION, { fetchFn, now: () => FIXED_NOW });
  await assert.rejects(transport.createSession(), (err) => err.status === 401 && err.authExpired === true);
  await assert.rejects(transport.fetchChallenge(null), (err) => err.status === 401 && err.authExpired === true);
});

test("transport - a refused completion never returns the previous answer", async () => {
  // Upstream answers a broken turn with a JSON body while history still ends
  // on the last answer; that answer must not come back as this turn's reply.
  const fake = fakeUpstream({
    sse: '{"code":0,"msg":"","data":{"biz_code":26,"biz_msg":"invalid message id","biz_data":null}}',
  });
  await assert.rejects(
    makeTransport(fake).complete({ chatSessionId: "sess-1", parentMessageId: "msg-1", mode: "delta", messages: [{ role: "user", content: "x" }] }),
    (err) => err.code === "upstream_rejected" && err.bizCode === 26 && /invalid message id/.test(err.message)
  );
  assert.strictEqual(fake.calls.filter((call) => call.url.includes("history_messages")).length, 0);
});

test("transport - history that still ends on the parent is not a reply", async () => {
  const fake = fakeUpstream({ sse: "data: [DONE]\n\n" });
  await assert.rejects(
    makeTransport(fake).complete({ chatSessionId: "sess-1", parentMessageId: "msg-1", mode: "delta", messages: [{ role: "user", content: "x" }] }),
    (err) => err.code === "history_incomplete"
  );
});

test("transport - history is matched by the id the stream announced", async () => {
  const sse = 'event: ready\ndata: {"request_message_id":3,"response_message_id":4}\n\ndata: {"v":{"response":{"message_id":4,"fragments":[{"type":"RESPONSE","content":"baru"}]}}}\n\n';
  const fake = fakeUpstream({
    sse,
    // History has not caught up yet: it still ends on message 2.
    history: () =>
      jsonResponse({
        data: { biz_data: { chat_messages: [{ role: "ASSISTANT", message_id: 2, fragments: [{ type: "RESPONSE", content: "lama" }] }] } },
      }),
  });
  const reply = await makeTransport(fake).complete({
    chatSessionId: "sess-1",
    parentMessageId: 2,
    mode: "delta",
    messages: [{ role: "user", content: "x" }],
  });
  assert.deepStrictEqual(reply, { text: "baru", reasoning: "", parentMessageId: 4 });
});

test("transport - deleteSession posts the chat id", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return jsonResponse({ code: 0, msg: "", data: { biz_code: 0, biz_msg: "", biz_data: null } });
  };
  await createDeepSeekWebTransport(CONNECTION, { fetchFn }).deleteSession({ chatSessionId: "sess-9" });
  assert.deepStrictEqual(calls, [{ url: "https://chat.deepseek.com/api/v0/chat_session/delete", body: { chat_session_id: "sess-9" } }]);
});

test("transport - history reports reasoning that upstream spells THINK", () => {
  const history = parseHistoryPayload(
    JSON.stringify({
      data: {
        biz_data: {
          chat_messages: [
            {
              role: "ASSISTANT",
              message_id: "msg-think",
              fragments: [
                { type: "THINK", content: "We need answer Indonesian." },
                { type: "RESPONSE", content: "37 x 48 = 1776" },
              ],
            },
          ],
        },
      },
    })
  );
  assert.deepStrictEqual(history, {
    text: "37 x 48 = 1776",
    reasoning: "We need answer Indonesian.",
    parentMessageId: "msg-think",
  });
});

test("transport - a silent stream keeps its status and notice events", async () => {
  // What an empty turn really looks like: a close and a title, no fragments.
  const sse = [
    'event: ready\ndata: {"request_message_id":1,"response_message_id":2}',
    'event: title\ndata: {"content":"committing"}',
    'event: close\ndata: {"click_behavior":"none"}',
    "",
  ].join("\n\n");
  const parser = createStreamParser();
  parser.push(sse);
  parser.end();
  const result = parser.result();

  assert.deepStrictEqual(result.fragments, []);
  assert.strictEqual(result.status, null);
  assert.deepStrictEqual(
    result.notices.map((notice) => notice.event),
    ["title", "close"]
  );
  assert.strictEqual(result.notices[0].hint, "committing");
});

test("transport - an empty turn reports the status and events it saw", async () => {
  const sse =
    'event: title\ndata: {"content":"commit"}\n\n' +
    'data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}]}\n\ndata: [DONE]\n\n';
  const fake = fakeUpstream({ sse });
  await assert.rejects(
    makeTransport(fake).complete({ chatSessionId: "sess-1", parentMessageId: "msg-1", mode: "delta", messages: [{ role: "user", content: "x" }] }),
    (err) => {
      assert.strictEqual(err.code, "history_incomplete");
      assert.match(err.message, /status=FINISHED/);
      assert.match(err.message, /events=title/);
      assert.match(err.message, /history=stale/);
      return true;
    }
  );
});

test("transport - a filtered status becomes its own error", async () => {
  const sse = 'data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"CONTENT_FILTER"}]}\n\ndata: [DONE]\n\n';
  const fake = fakeUpstream({ sse });
  await assert.rejects(
    makeTransport(fake).complete({ chatSessionId: "sess-1", parentMessageId: "msg-1", mode: "delta", messages: [{ role: "user", content: "x" }] }),
    (err) => err.code === "content_filtered" && err.status === 400 && /CONTENT_FILTER/.test(err.message)
  );
});

test("transport - a turn refused as too long is a 413 the caller can retry", async () => {
  const sse = 'event: close\ndata: {"msg":"The conversation is too long, please start a new chat."}\n\ndata: [DONE]\n\n';
  const fake = fakeUpstream({ sse });
  await assert.rejects(
    makeTransport(fake).complete({ chatSessionId: "sess-1", parentMessageId: "msg-1", mode: "delta", messages: [{ role: "user", content: "x" }] }),
    (err) => err.code === "conversation_limit" && err.status === 413 && /too long/.test(err.message)
  );
});

test("transport - a busy upstream is reported as a rate limit", async () => {
  const sse = 'event: close\ndata: {"msg":"Too many requests, please slow down."}\n\ndata: [DONE]\n\n';
  const fake = fakeUpstream({ sse });
  await assert.rejects(
    makeTransport(fake).complete({ chatSessionId: "sess-1", parentMessageId: "msg-1", mode: "delta", messages: [{ role: "user", content: "x" }] }),
    (err) => err.code === "rate_limit_exceeded" && err.status === 429
  );
});

test("transport - an incomplete turn is distinguishable from a silent one", async () => {
  const sse = 'data: {"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"INCOMPLETE"}]}\n\ndata: [DONE]\n\n';
  const fake = fakeUpstream({ sse });
  await assert.rejects(
    makeTransport(fake).complete({ chatSessionId: "sess-1", parentMessageId: "msg-1", mode: "delta", messages: [{ role: "user", content: "x" }] }),
    (err) => err.code === "upstream_incomplete" && err.status === 502
  );
});

test("transport - a repeated bookkeeping event never crowds out the hint", async () => {
  // Bookkeeping events repeat every turn; only one slot each, and the hint
  // that names the cause keeps its place.
  const lines = [
    "event: ready",
    'data: {"request_message_id":10,"response_message_id":11}',
    "",
    "event: update_session",
    'data: {"updated_at":1792703701.5}',
    "",
    "event: update_session",
    'data: {"updated_at":1792703702.5}',
    "",
    "event: title",
    'data: {"content":"commit"}',
    "",
    "event: hint",
    'data: {"content":"对话过长"}',
    "",
    "event: close",
    'data: {"click_behavior":"none"}',
    "",
  ];
  const parser = createStreamParser();
  parser.push(lines.join(String.fromCharCode(10)));
  parser.end();
  const { notices } = parser.result();

  assert.deepStrictEqual(
    notices.map((notice) => notice.event),
    ["update_session", "title", "hint", "close"],
    "one slot per bookkeeping event, and the hint keeps its place"
  );
  const err = emptyReplyError({ status: null, notices, history: "empty" });
  assert.strictEqual(err.code, "conversation_limit", "a Chinese length hint is recognised");
  assert.strictEqual(err.status, 413);
});
