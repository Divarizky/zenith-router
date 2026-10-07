import test from "node:test";
import assert from "node:assert";
import { injectCaveman, hasCaveman, CAVEMAN_PROMPT } from "../src/services/caveman.js";

test("caveman service - injects into OpenAI payload with existing system message", () => {
  const body = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are an assistant." },
      { role: "user", content: "Explain async/await" },
    ],
  };

  const modified = injectCaveman(body, "openai");
  assert.strictEqual(modified.messages.length, 2);
  assert.ok(modified.messages[0].content.includes("You are an assistant."));
  assert.ok(modified.messages[0].content.includes(CAVEMAN_PROMPT));
});

test("caveman service - injects into OpenAI payload without existing system message", () => {
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Explain closures" }],
  };

  const modified = injectCaveman(body, "openai");
  assert.strictEqual(modified.messages.length, 2);
  assert.strictEqual(modified.messages[0].role, "system");
  assert.ok(modified.messages[0].content.includes(CAVEMAN_PROMPT));
});

test("caveman service - injects into Anthropic payload system field", () => {
  const body = {
    model: "claude-3-7-sonnet",
    system: "Base instructions.",
    messages: [{ role: "user", content: "Write a test" }],
  };

  const modified = injectCaveman(body, "claude");
  assert.ok(typeof modified.system === "string");
  assert.ok(modified.system.includes("Base instructions."));
  assert.ok(modified.system.includes(CAVEMAN_PROMPT));
});

test("caveman service - prevents duplicate injection if prompt already present", () => {
  const body = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: `You are an assistant.\n\n${CAVEMAN_PROMPT}` },
      { role: "user", content: "Hello" },
    ],
  };

  const modified = injectCaveman(body, "openai");
  const count = (modified.messages[0].content.match(/minimal filler/g) || []).length;
  assert.strictEqual(count, 1, "Must not inject duplicate Caveman rules");
});
