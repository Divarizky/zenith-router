import test from "node:test";
import assert from "node:assert";
import {
  prepareToolsWithFingerprint,
  FINGERPRINT_TOOL_DEFINITIONS,
  OpencodeExecutor,
} from "../src/executors/opencode.js";
import { restoreResponsesToolNames } from "../src/executors/opencodeResponses.js";

test("prepareToolsWithFingerprint - injects canonical read and shell when no tools provided", () => {
  const body = {
    model: "big-pickle",
    messages: [{ role: "user", content: "hello" }],
  };
  const aliasMap = prepareToolsWithFingerprint(body, "/inference/v1/chat/completions");

  assert.strictEqual(aliasMap.size, 0);
  assert.strictEqual(body.tools.length, 2);
  const names = body.tools.map((t) => t.function.name);
  assert.deepStrictEqual(names, ["read", "shell"]);
  assert.strictEqual(body.tools[0].function.description, FINGERPRINT_TOOL_DEFINITIONS.read.description);
  assert.strictEqual(body.tools[1].function.description, FINGERPRINT_TOOL_DEFINITIONS.shell.description);

  // Injects placeholder note
  assert.strictEqual(body.messages.length, 2);
  assert.strictEqual(body.messages[0].role, "system");
  assert.ok(body.messages[0].content.includes("Do not call the `read` or `shell` tools"));
});

test("prepareToolsWithFingerprint - aliases custom client tool colliding with read or shell", () => {
  const customRead = {
    type: "function",
    function: {
      name: "read",
      description: "My custom file reader",
      parameters: { type: "object", properties: { file: { type: "string" } } },
    },
  };
  const body = {
    model: "big-pickle",
    messages: [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "read file" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"file":"a.txt"}' } }] },
      { role: "tool", name: "read", tool_call_id: "c1", content: "file content" },
    ],
    tools: [customRead],
    tool_choice: { type: "function", function: { name: "read" } },
  };

  const aliasMap = prepareToolsWithFingerprint(body, "/inference/v1/chat/completions");

  assert.strictEqual(aliasMap.get("read_client"), "read");
  // Tools: custom read (aliased), canonical read, canonical shell
  assert.strictEqual(body.tools.length, 3);
  const toolNames = body.tools.map((t) => t.function.name);
  assert.deepStrictEqual(toolNames, ["read_client", "read", "shell"]);

  // Message references rewritten to alias
  assert.strictEqual(body.messages[2].tool_calls[0].function.name, "read_client");
  assert.strictEqual(body.messages[3].name, "read_client");

  // tool_choice rewritten to alias
  assert.strictEqual(body.tool_choice.function.name, "read_client");

  // System note appended to existing system prompt
  assert.ok(body.messages[0].content.includes("You are an assistant."));
  assert.ok(body.messages[0].content.includes("[System Note:"));
});

test("prepareToolsWithFingerprint - removes tool_choice: none to prevent 403 FreeTierError", () => {
  const body = {
    model: "big-pickle",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "none",
  };
  prepareToolsWithFingerprint(body, "/inference/v1/chat/completions");
  assert.strictEqual(body.tool_choice, undefined);
});

test("prepareToolsWithFingerprint - formats tools for Responses API path correctly", () => {
  const body = {
    model: "muse-spark-1.3-contributor-free",
    input: [{ type: "message", role: "user", content: "hi" }],
    instructions: "Answer concisely.",
  };
  prepareToolsWithFingerprint(body, "/inference/v1/responses");

  assert.strictEqual(body.tools.length, 2);
  assert.strictEqual(body.tools[0].type, "function");
  assert.strictEqual(body.tools[0].name, "read");
  assert.strictEqual(body.tools[0].function, undefined);
  assert.strictEqual(body.tools[0].strict, false);

  assert.ok(body.instructions.includes("Answer concisely."));
  assert.ok(body.instructions.includes("Do not call the `read` or `shell` tools"));
});

test("prepareToolsWithFingerprint - jalur /messages menaruh note di top-level system, bukan di messages", () => {
  // Body claude-format hasil translateRequest: system jadi field top-level.
  const body = {
    model: "union-alpha",
    system: "You are helpful.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  prepareToolsWithFingerprint(body, "/inference/v1/messages");

  assert.ok(body.system.includes("You are helpful."));
  assert.ok(body.system.includes("[System Note: Do not call the `read` or `shell` tools"));
  assert.ok(
    body.messages.every((m) => m.role !== "system"),
    "role system tidak boleh disuntikkan ke dalam messages Anthropic-style"
  );

  // Tanpa system top-level dan tanpa system message: note jadi top-level system baru.
  const body2 = {
    model: "union-alpha",
    messages: [{ role: "user", content: "hi" }],
  };
  prepareToolsWithFingerprint(body2, "/inference/v1/messages");
  assert.strictEqual(typeof body2.system, "string");
  assert.ok(body2.system.includes("[System Note:"));
});

test("restoreResponsesToolNames - restores aliased client tool names in SSE stream", async () => {
  const nameMap = new Map([["read_client", "read"]]);

  const sseChunk = 'data: {"id":"1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read_client","arguments":"{\\"file\\""}}]}}]}\n\n';
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseChunk));
      controller.close();
    },
  });

  const origResponse = new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });

  const restored = await restoreResponsesToolNames(origResponse, nameMap);
  const text = await restored.text();

  assert.ok(text.includes('"name":"read"'), `nama tool harus direstorasi ke read, didapat: ${text}`);
  assert.ok(!text.includes('"name":"read_client"'));
});
