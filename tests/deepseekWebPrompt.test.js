import test from "node:test";
import assert from "node:assert";
import { renderMessage, renderToolCatalog, renderTurn } from "../src/services/deepseekWeb/prompt.js";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  },
];
const user = (content) => ({ role: "user", content });

test("prompt - the full render carries the preamble, catalog, and conversation", () => {
  const prompt = renderTurn({ mode: "full", messages: [user("halo")], tools: TOOLS });

  assert.match(prompt, /You are the reasoning engine/);
  assert.match(prompt, /<tool_call>\{"name": "TOOL_NAME", "arguments": \{ \.\.\. \}\}<\/tool_call>/);
  assert.match(prompt, /- bash: run a shell command/);
  assert.match(prompt, /params: \{"type":"object"/);
  assert.match(prompt, /--- CONVERSATION ---/);
  assert.match(prompt, /User: halo/);
  assert.match(prompt, /\[Reminder: you have tools/);
});

test("prompt - the delta render has no preamble and no catalog", () => {
  const prompt = renderTurn({ mode: "delta", messages: [{ role: "tool", name: "bash", content: "ok" }], tools: TOOLS });

  assert.doesNotMatch(prompt, /You are the reasoning engine/);
  assert.doesNotMatch(prompt, /--- CONVERSATION ---/);
  assert.doesNotMatch(prompt, /- bash:/);
  assert.match(prompt, /Tool result \(bash\): ok/);
  assert.match(prompt, /\[Reminder: you have tools/);
});

test("prompt - a request without tools gets no preamble and no reminder", () => {
  const prompt = renderTurn({ mode: "full", messages: [user("halo")], tools: [] });

  assert.doesNotMatch(prompt, /You are the reasoning engine/);
  assert.doesNotMatch(prompt, /Reminder/);
  assert.strictEqual(prompt, "--- CONVERSATION ---\n\nUser: halo");
});

test("prompt - catalog sizes are capped per tool", () => {
  const longTool = {
    function: {
      name: "big",
      description: "d".repeat(400),
      parameters: { type: "object", properties: { blob: { type: "string", description: "x".repeat(3000) } } },
    },
  };
  const catalog = renderToolCatalog([longTool]);

  assert.match(catalog, /d{240}\.\.\./);
  assert.doesNotMatch(catalog, /d{241}/);
  assert.match(catalog, /\.\.\.\(trimmed\)/);
  assert.ok(catalog.length < 1800, `catalog stays bounded, got ${catalog.length}`);
});

test("prompt - tool results and assistant calls are rendered in a readable shape", () => {
  // Under the limit nothing is cut.
  const result = "r".repeat(5000);
  assert.strictEqual(renderMessage({ role: "tool", name: "bash", content: result }), `Tool result (bash): ${result}`);

  // Over it, the head and the tail survive and the gap is counted.
  const longResult = `HEAD${"m".repeat(20000)}TAIL`;
  const trimmed = renderMessage({ role: "tool", name: "bash", content: longResult });
  assert.match(trimmed, /^Tool result \(bash\): HEAD/);
  assert.match(trimmed, /TAIL$/);
  assert.match(trimmed, /\.\.\.\(8008 characters omitted from the middle of this result\)\.\.\./);

  const assistant = renderMessage({
    role: "assistant",
    content: "Aku cek.",
    tool_calls: [{ function: { name: "bash", arguments: '{"command":"ls"}' } }],
  });
  assert.match(assistant, /Assistant: Aku cek\./);
  assert.match(assistant, /Assistant called tool bash: \{"command":"ls"\}/);

  assert.strictEqual(renderMessage({ role: "assistant", content: null }), "Assistant: (tool call)");

  const withId = renderMessage({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_a", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
  });
  assert.strictEqual(withId, 'Assistant called tool read (call_a): {"path":"a.txt"}');
  assert.match(renderMessage({ role: "system", content: "aturan" }), /\[System instructions\]\naturan/);
});

test("prompt - tool results are named after the call that produced them", () => {
  // What Claude Code, Codex, and plain OpenAI clients send: results carry only
  // tool_call_id, and the call itself may sit in an earlier turn.
  const history = [
    { role: "user", content: "baca a.txt dan b.txt" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_a", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
        { id: "call_b", type: "function", function: { name: "grep", arguments: '{"q":"x"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_b", content: "isi B" },
    { role: "tool", tool_call_id: "call_a", content: "isi A" },
  ];
  const prompt = renderTurn({ mode: "delta", messages: history.slice(2), history });
  assert.strictEqual(prompt, "Tool result (grep, call_b): isi B\nTool result (read, call_a): isi A");
});
