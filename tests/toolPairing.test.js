import test from "node:test";
import assert from "node:assert";
import { repairClaudeToolPairing } from "../src/translator/toolPairing.js";
import { translateRequest, FORMATS } from "../src/translator/index.js";

const use = (id) => ({ type: "tool_use", id, name: "Bash", input: {} });
const res = (id) => ({ type: "tool_result", tool_use_id: id, content: "ok" });

test("repair - well-formed history is returned untouched", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a"), use("b")] },
    { role: "user", content: [res("a"), res("b"), { type: "text", text: "next" }] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.messages, messages);
});

test("repair - drops orphan tool_result at the reported position (content.1)", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a")] },
    { role: "user", content: [res("a"), res("toolu_01QyL")] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.droppedResults, 1);
  assert.deepStrictEqual(out.messages[2].content, [res("a")]);
  assert.strictEqual(messages[2].content.length, 2, "input not mutated");
});

test("repair - drops tool_result whose assistant turn vanished, removes empty message", () => {
  const messages = [
    { role: "user", content: "a" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [res("gone")] },
    { role: "assistant", content: [{ type: "text", text: "next" }] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.droppedMessages, 1);
  assert.strictEqual(out.messages.length, 3);
});

test("repair - merges split parallel results and puts tool_result first", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a"), use("b")] },
    { role: "user", content: [res("a")] },
    { role: "user", content: [res("b")] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.mergedMessages, 1);
  assert.deepStrictEqual(out.messages[2].content, [res("a"), res("b")]);
});

test("repair - adds synthetic error result for an unanswered tool_use", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a"), use("b")] },
    { role: "user", content: [res("a"), { type: "text", text: "continue" }] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.addedResults, 1);
  const blocks = out.messages[2].content;
  assert.deepStrictEqual(blocks.slice(0, 2).map((b) => b.tool_use_id), ["a", "b"]);
  assert.strictEqual(blocks[1].is_error, true);
  assert.strictEqual(blocks[2].type, "text");
});

test("repair - trailing assistant tool_use is left alone", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a")] },
  ];
  assert.strictEqual(repairClaudeToolPairing(messages).messages, messages);
});

test("pivot - assistant turn with only redacted_thinking no longer leaves an orphan after repair", () => {
  const body = {
    model: "x",
    messages: [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "zzz" }] },
      { role: "user", content: [res("toolu_01QyL")] },
    ],
  };
  const openai = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, body, "x");
  const claude = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, openai, "x");
  const out = repairClaudeToolPairing(claude.messages);
  assert.ok(!JSON.stringify(out.messages).includes("tool_result"));
});

test("repair - duplicate tool_use id in one turn yields a single tool_result", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a"), use("a")] },
    { role: "user", content: "next" },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.addedResults, 1);
  const ids = out.messages[2].content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
  assert.deepStrictEqual(ids, ["a"]);
});

test("repair - duplicate tool_use id answered once is left valid", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a"), use("a")] },
    { role: "user", content: [res("a")] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.addedResults, 0);
  assert.strictEqual(out.messages, messages);
});

test("repair - tool_use whose user turn was dropped gets a synthetic result in a new turn", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a")] },
    { role: "user", content: [res("orphan")] },
    { role: "assistant", content: [{ type: "text", text: "next" }] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.droppedResults, 1);
  assert.strictEqual(out.addedResults, 1);
  assert.strictEqual(out.messages[2].role, "user");
  assert.deepStrictEqual(out.messages[2].content.map((b) => b.tool_use_id), ["a"]);
  assert.strictEqual(out.messages[3].role, "assistant");
});

test("repair - null entries in messages are removed and do not throw", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a")] },
    null,
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.removedEntries, 1);
  assert.ok(out.messages.every((m) => m && typeof m === "object"));
  // The tool_use is now the trailing turn, so it stays unanswered by design (prefill rule).
  assert.strictEqual(out.messages.length, 2);
  assert.strictEqual(out.messages.at(-1).role, "assistant");
  assert.strictEqual(out.addedResults, 0);
});

test("repair - undefined between assistant turn and its answer keeps the real result", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a")] },
    undefined,
    { role: "user", content: [res("a")] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.addedResults, 0);
  assert.strictEqual(out.droppedResults, 0);
  const answer = out.messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"));
  assert.deepStrictEqual(answer.content, [res("a")]);
});

test("repair - null blocks inside content are removed without touching other blocks", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [null, use("a"), undefined] },
    { role: "user", content: [null, res("a"), { type: "text", text: "ok" }] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.removedEntries, 3);
  assert.strictEqual(out.addedResults, 0);
  assert.deepStrictEqual(out.messages[1].content, [use("a")]);
  assert.deepStrictEqual(out.messages[2].content, [res("a"), { type: "text", text: "ok" }]);
});

test("repair - user message with only null content is removed", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [null] },
    { role: "assistant", content: [{ type: "text", text: "next" }] },
  ];
  const out = repairClaudeToolPairing(messages);
  assert.strictEqual(out.messages.length, 3);
  assert.strictEqual(out.messages[2].role, "assistant");
});

test("repair - well-formed history with no nullish values keeps identity", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: [use("a")] },
    { role: "user", content: [res("a")] },
  ];
  assert.strictEqual(repairClaudeToolPairing(messages).messages, messages);
});
