import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";
import {
  normalizeClaudeToolInput,
  openAIToClaudeResponse,
  createResponseTransformStream,
} from "../src/translator/response.js";
import { setCustomExecutor } from "../src/executors/base.js";

test("normalizeClaudeToolInput - Bash aliases (cmd, script, code) mapped to command", () => {
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Bash", { cmd: "ls -la" }),
    { command: "ls -la" }
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Bash", { script: "echo 1" }),
    { command: "echo 1" }
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Bash", { code: "npm test" }),
    { command: "npm test" }
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Bash", { input: "ls" }),
    { command: "ls" },
    "alias input dipetakan dan tidak tertinggal di argumen"
  );
  // Jika command sudah ada, nilai command asli dipertahankan
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Bash", { command: "node -v", cmd: "node -v" }),
    { command: "node -v" }
  );
});

test("normalizeClaudeToolInput - Read/Edit/Write aliases (path, file, filename, old_text, text) mapped", () => {
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Read", { path: "src/index.js" }),
    { file_path: "src/index.js" }
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Read", { file: "README.md" }),
    { file_path: "README.md" }
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Edit", {
      path: "config.json",
      old_text: '"a": 1',
      new_text: '"a": 2',
    }),
    {
      file_path: "config.json",
      old_string: '"a": 1',
      new_string: '"a": 2',
    }
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Write", {
      path: "out.txt",
      text: "hello world",
    }),
    {
      file_path: "out.txt",
      content: "hello world",
    }
  );
});

test("normalizeClaudeToolInput - Glob/Grep aliases (query, regex, dir) mapped to pattern and path", () => {
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Glob", { query: "**/*.js" }),
    { pattern: "**/*.js" }
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Grep", { regex: "function", dir: "src" }),
    { pattern: "function", path: "src" }
  );
});

test("normalizeClaudeToolInput - a correct Grep call keeps its glob file filter", () => {
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Grep", { pattern: "TODO", glob: "*.js", path: "src" }),
    { pattern: "TODO", glob: "*.js", path: "src" },
    "glob pada Grep adalah filter file, bukan alias pattern"
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Grep", { query: "TODO", glob: "*.js" }),
    { pattern: "TODO", glob: "*.js" },
    "alias pattern diperbaiki tanpa menyentuh glob"
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("Glob", { glob: "**/*.md" }),
    { pattern: "**/*.md" },
    "pada tool Glob, glob tetap alias pattern"
  );
});

test("normalizeClaudeToolInput - lowercase tools of other clients keep their own parameter names", () => {
  assert.deepStrictEqual(
    normalizeClaudeToolInput("read", { path: "src/index.js" }),
    { path: "src/index.js" },
    "tool read milik klien lain memakai path, bukan file_path"
  );
  assert.deepStrictEqual(
    normalizeClaudeToolInput("bash", { cmd: "ls" }),
    { cmd: "ls" }
  );
});

test("normalizeClaudeToolInput - custom unknown tools untouched", () => {
  const custom = { my_param: "val", cmd: "should not change" };
  assert.deepStrictEqual(normalizeClaudeToolInput("my_custom_mcp_tool", custom), {
    my_param: "val",
    cmd: "should not change",
  });
});

test("openAIToClaudeResponse - maps tool_calls input arguments to canonical Claude fields", () => {
  const openAIData = {
    id: "chatcmpl-123",
    model: "big-pickle",
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_bash_1",
              type: "function",
              function: {
                name: "Bash",
                arguments: JSON.stringify({ cmd: "pwd" }),
              },
            },
            {
              id: "call_edit_1",
              type: "function",
              function: {
                name: "Edit",
                arguments: JSON.stringify({ path: "x.js", old_text: "foo", new_text: "bar" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };

  const claude = openAIToClaudeResponse(openAIData, "big-pickle");
  const bashUse = claude.content.find((c) => c.name === "Bash");
  assert.ok(bashUse);
  assert.deepStrictEqual(bashUse.input, { command: "pwd" });

  const editUse = claude.content.find((c) => c.name === "Edit");
  assert.ok(editUse);
  assert.deepStrictEqual(editUse.input, { file_path: "x.js", old_string: "foo", new_string: "bar" });
});

test("createResponseTransformStream - streaming tool arguments are normalized before content_block_stop", async () => {
  const stream = createResponseTransformStream("openai", "claude", "big-pickle");

  const chunk1 = `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { role: "assistant" } }] })}\n\n`;
  const chunk2 = `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Bash", arguments: '{"cmd":"git ' } }] } }] })}\n\n`;
  const chunk3 = `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'status"}' } }] } }] })}\n\n`;
  const chunk4 = `data: ${JSON.stringify({ id: "1", choices: [{ index: 0, finish_reason: "tool_calls" }] })}\n\n`;
  const chunk5 = "data: [DONE]\n\n";

  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk1));
      controller.enqueue(new TextEncoder().encode(chunk2));
      controller.enqueue(new TextEncoder().encode(chunk3));
      controller.enqueue(new TextEncoder().encode(chunk4));
      controller.enqueue(new TextEncoder().encode(chunk5));
      controller.close();
    },
  });

  const transformed = readable.pipeThrough(stream);
  const text = await new Response(transformed).text();

  const deltaLine = text.split("\n").find((l) => l.includes("input_json_delta"));
  assert.ok(deltaLine, "delta line harus ada");
  const parsedDelta = JSON.parse(deltaLine.replace(/^data:\s*/, ""));
  assert.strictEqual(
    parsedDelta.delta.partial_json,
    '{"command":"git status"}',
    "partial_json harus memuat argumen yang telah dinormalisasi"
  );
  assert.ok(!deltaLine.includes('"cmd"'), "alias cmd tidak boleh muncul pada delta yang dinormalisasi");
});

test("Messages gateway integration - POST /v1/messages normalizes tool arguments from non-Anthropic models", async () => {
  initDb(":memory:");

  setCustomExecutor({
    async execute() {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-mock",
          model: "big-pickle",
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_b_1",
                    type: "function",
                    function: {
                      name: "Bash",
                      arguments: JSON.stringify({ cmd: "whoami" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    },
  });

  try {
    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "opencode/big-pickle",
        messages: [{ role: "user", content: "whoami" }],
        stream: false,
      }),
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.type, "message");
    const toolUse = json.content.find((c) => c.type === "tool_use");
    assert.ok(toolUse, "tool_use harus ada di respons Claude");
    assert.strictEqual(toolUse.name, "Bash");
    assert.deepStrictEqual(toolUse.input, { command: "whoami" });
  } finally {
    setCustomExecutor(null);
  }
});
