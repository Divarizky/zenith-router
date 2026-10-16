import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { openaiToResponsesRequest } from "../src/translator/responses.js";
import {
  sanitizeResponsesToolName,
  prepareResponsesBody,
  restoreResponsesToolNames,
} from "../src/executors/opencodeResponses.js";
import { OpencodeExecutor } from "../src/executors/opencode.js";
import { CodexExecutor } from "../src/executors/codex.js";

// Intercepts the request an executor hands to BaseExecutor and answers it.
async function captureUpstream(ExecutorClass, run, reply) {
  const proto = Object.getPrototypeOf(ExecutorClass.prototype);
  const orig = proto.execute;
  const captured = {};
  proto.execute = async function (args) {
    captured.body = JSON.parse(args.body);
    captured.headers = args.headers;
    return reply ? reply(captured.body) : new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    captured.result = await run();
  } finally {
    proto.execute = orig;
  }
  return captured;
}

function responsesSse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("sanitizeResponsesToolName - replaces non [a-zA-Z0-9_-] characters with underscore", () => {
  assert.strictEqual(sanitizeResponsesToolName("mcp:fs:read"), "mcp_fs_read");
  assert.strictEqual(sanitizeResponsesToolName("tool.name.v1"), "tool_name_v1");
  assert.strictEqual(sanitizeResponsesToolName("hello world!"), "hello_world_");
  assert.strictEqual(sanitizeResponsesToolName("valid_tool-name_123"), "valid_tool-name_123");
});

test("Shared translator - leaves tool names and history alone, maps the budget without clamping", () => {
  const req = openaiToResponsesRequest({
    model: "gpt-5-codex",
    messages: [
      { role: "user", content: "baca file" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_orphan", type: "function", function: { name: "mcp:fs:read", arguments: "{}" } }],
      },
    ],
    tools: [{ type: "function", function: { name: "mcp:fs:read", parameters: { type: "object" } } }],
    max_tokens: 5,
  });

  assert.strictEqual(req.tools[0].name, "mcp:fs:read", "translator bersama tidak mengganti nama tool");
  assert.strictEqual(req.input.find((i) => i.type === "function_call").name, "mcp:fs:read");
  assert.ok(!req.input.some((i) => i.type === "function_call_output"), "translator bersama tidak membuat output sintetis");
  assert.strictEqual(req.max_output_tokens, 5, "translator memetakan max_tokens tanpa clamp");
});

test("Codex executor - never forwards max_output_tokens to the Codex backend", async () => {
  const executor = new CodexExecutor();
  const captured = await captureUpstream(CodexExecutor, () =>
    executor.execute({
      url: "https://chatgpt.com/backend-api/codex/responses",
      body: JSON.stringify({ model: "gpt-5-codex", input: [], max_output_tokens: 1000 }),
      connection: { credentials: {} },
    })
  );
  assert.ok(!("max_output_tokens" in captured.body), "Codex menolak max_output_tokens, jadi field dibuang");
  assert.strictEqual(captured.body.model, "gpt-5-codex", "field lain tetap utuh");
});

test("prepareResponsesBody - sanitizes names with a collision-free reverse map, pairs orphans, clamps", () => {
  const body = {
    tools: [
      { type: "function", name: "mcp:fs:read" },
      { type: "function", name: "mcp.fs.read" },
      { type: "function", name: "bash" },
    ],
    tool_choice: { type: "function", name: "mcp:fs:read" },
    input: [
      { type: "function_call", call_id: "c_1", name: "mcp:fs:read", arguments: "{}" },
      { type: "function_call_output", call_id: "c_ghost", output: "ghost" },
    ],
    max_output_tokens: 10,
  };
  const map = prepareResponsesBody(body);

  assert.strictEqual(body.tools[0].name, "mcp_fs_read");
  assert.strictEqual(body.tools[1].name, "mcp_fs_read_2", "dua nama berbeda tidak boleh bertabrakan");
  assert.strictEqual(body.tools[2].name, "bash");
  assert.strictEqual(body.tool_choice.name, "mcp_fs_read");
  assert.strictEqual(body.input[0].name, "mcp_fs_read", "riwayat memakai nama yang sama dengan daftar tool");
  assert.ok(!body.input.some((i) => i.call_id === "c_ghost"), "output yatim dibuang");
  const synthetic = body.input.find((i) => i.type === "function_call_output" && i.call_id === "c_1");
  assert.strictEqual(synthetic?.output, "{}", "call yatim dipasangkan output sintetis");
  assert.strictEqual(body.max_output_tokens, 16, "di bawah 16 di-clamp ke 16");

  assert.strictEqual(map.get("mcp_fs_read"), "mcp:fs:read");
  assert.strictEqual(map.get("mcp_fs_read_2"), "mcp.fs.read");
  assert.ok(!map.has("bash"), "nama yang tidak berubah tidak masuk peta");

  const large = { max_output_tokens: 100000 };
  prepareResponsesBody(large);
  assert.strictEqual(large.max_output_tokens, 65536, "di atas 65536 di-clamp ke 65536");
});

test("restoreResponsesToolNames - SSE and JSON responses carry the client's original names", async () => {
  const map = new Map([["mcp_fs_read", "mcp:fs:read"]]);
  const sse = responsesSse([
    { type: "response.output_item.added", item: { type: "function_call", call_id: "c_1", name: "mcp_fs_read" } },
    { type: "response.completed", response: { output: [{ type: "function_call", call_id: "c_1", name: "mcp_fs_read" }] } },
  ]);
  const restored = await restoreResponsesToolNames(
    new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    map
  );
  const text = await restored.text();
  assert.ok(!text.includes("mcp_fs_read"), "nama upstream tidak bocor ke klien");
  assert.strictEqual(text.match(/mcp:fs:read/g)?.length, 2, "kedua event memuat nama asli");
  assert.ok(text.endsWith("data: [DONE]\n\n"), "struktur SSE tetap utuh");

  const json = await restoreResponsesToolNames(
    new Response(JSON.stringify({ output: [{ type: "function_call", name: "mcp_fs_read" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    map
  );
  assert.strictEqual((await json.json()).output[0].name, "mcp:fs:read");

  const untouched = new Response("x", { status: 200 });
  assert.strictEqual(await restoreResponsesToolNames(untouched, new Map()), untouched, "tanpa rename, respons diteruskan apa adanya");
});

test("Gateway - an OpenCode Responses model gets sanitized names upstream and returns the original name", async () => {
  initDb(":memory:");
  const captured = await captureUpstream(
    OpencodeExecutor,
    () =>
      app.request("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "opencode/muse-spark-1.2-contributor-free",
          messages: [{ role: "user", content: "baca a.txt" }],
          tools: [{ type: "function", function: { name: "mcp:fs:read", parameters: { type: "object", properties: {} } } }],
          max_tokens: 5,
          stream: false,
        }),
      }),
    () =>
      new Response(
        responsesSse([
          { type: "response.output_item.added", item: { type: "function_call", call_id: "c_1", name: "mcp_fs_read" } },
          { type: "response.function_call_arguments.delta", delta: '{"path":"a.txt"}' },
          { type: "response.output_item.done", item: { type: "function_call", call_id: "c_1", name: "mcp_fs_read" } },
          { type: "response.completed", response: { output: [] } },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
  );

  assert.ok(captured.body.tools.some((t) => t.name === "mcp_fs_read"), "upstream menerima nama tersanitasi");
  // Token budgeting reasoning: max_tokens 5 dari klien dinaikkan menjadi
  // max(5, 1024) + 4096 = 5120 sebelum clamp [16, 65536] /responses.
  assert.strictEqual(captured.body.max_output_tokens, 5120, "budget dari klien sampai dan di-clamp");
  const res = captured.result;
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.strictEqual(json.choices[0].message.tool_calls?.[0]?.function?.name, "mcp:fs:read", "klien menerima nama tool aslinya");
});

test("Gateway /v1/responses - a client max_output_tokens reaches the OpenCode clamp", async () => {
  initDb(":memory:");
  const captured = await captureUpstream(OpencodeExecutor, () =>
    app.request("/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "opencode/muse-spark-1.2-contributor-free", input: "halo", max_output_tokens: 200000 }),
    })
  );
  assert.strictEqual(captured.body.max_output_tokens, 65536, "max_output_tokens dari klien Responses tidak lagi hilang");
});

test("Shared translator - a forced tool in chat shape becomes the Responses shape", () => {
  const base = { model: "gpt-5-codex", messages: [{ role: "user", content: "x" }] };
  const forced = openaiToResponsesRequest(
    { ...base, tool_choice: { type: "function", function: { name: "read_file" } } },
    "gpt-5-codex"
  );
  assert.deepStrictEqual(forced.tool_choice, { type: "function", name: "read_file" }, "nama dipindah ke level atas");

  const keyword = openaiToResponsesRequest({ ...base, tool_choice: "required" }, "gpt-5-codex");
  assert.strictEqual(keyword.tool_choice, "required", "kata kunci string diteruskan apa adanya");

  const already = openaiToResponsesRequest({ ...base, tool_choice: { type: "function", name: "x" } }, "gpt-5-codex");
  assert.deepStrictEqual(already.tool_choice, { type: "function", name: "x" }, "bentuk Responses tidak diubah");

  const none = openaiToResponsesRequest(base, "gpt-5-codex");
  assert.strictEqual(none.tool_choice, undefined);
});

test("Gateway - a forced tool reaches OpenCode Responses with the same sanitized name as its tool", async () => {
  initDb(":memory:");
  const captured = await captureUpstream(OpencodeExecutor, () =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode/muse-spark-1.2-contributor-free",
        messages: [{ role: "user", content: "baca a.txt" }],
        tools: [{ type: "function", function: { name: "mcp:fs:read", parameters: { type: "object", properties: {} } } }],
        tool_choice: { type: "function", function: { name: "mcp:fs:read" } },
      }),
    })
  );
  assert.deepStrictEqual(captured.body.tool_choice, { type: "function", name: "mcp_fs_read" });
  assert.ok(
    captured.body.tools.some((t) => t.name === captured.body.tool_choice.name),
    "tool yang dipaksa ada di daftar tool upstream"
  );
});

test("Gateway /v1/responses - the client output budget reaches non-OpenCode providers as max_tokens", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "k", credentials: { api_key: "k" } });
  const seen = [];
  setCustomExecutor({
    async execute({ body }) {
      seen.push(JSON.parse(body).max_tokens);
      return new Response(
        JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });
  try {
    for (const extra of [{ max_output_tokens: 3000 }, { max_tokens: 1200, max_output_tokens: 3000 }, {}]) {
      const res = await app.request("/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "glm/glm-4-flash", input: "hai", ...extra }),
      });
      assert.strictEqual(res.status, 200);
    }
  } finally {
    setCustomExecutor(null);
  }
  assert.deepStrictEqual(
    seen,
    [3000, 1200, undefined],
    "max_output_tokens dipakai bila max_tokens kosong; tanpa keduanya provider memakai default-nya"
  );
});
