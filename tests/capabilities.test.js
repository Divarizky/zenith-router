import test from "node:test";
import assert from "node:assert/strict";

import { resolveCapabilities, capabilitiesFromApi, DEFAULT_CAPABILITIES } from "../src/providers/capabilities.js";

test("capabilities - stored provider data wins over the pattern table", () => {
  // Mistral's API says codestral-2508 has no vision; the pattern table would only
  // say "text model" too, so use a model where the two disagree.
  assert.deepEqual(resolveCapabilities("codestral-2508", { vision: false, reasoning: false }), {
    vision: false,
    reasoning: false,
    contextWindow: 256000,
    maxOutput: null,
  });

  const ministral = resolveCapabilities("ministral-14b-latest", { vision: true, reasoning: false });
  assert.equal(ministral.vision, true);
  assert.equal(ministral.reasoning, false);
});

test("capabilities - stored data can turn a capability on that the pattern does not know", () => {
  const caps = resolveCapabilities("mistral-large-latest", { vision: false });
  assert.equal(caps.vision, false, "API data overrides the pattern's vision: true");
  assert.equal(caps.reasoning, false);
});

test("capabilities - pattern table resolves known families", () => {
  const gpt = resolveCapabilities("gpt-6.1-sol");
  assert.equal(gpt.vision, true);
  assert.equal(gpt.reasoning, true);
  assert.equal(gpt.contextWindow, 1050000);

  const gemini = resolveCapabilities("gemini-3.8-flash-high");
  assert.equal(gemini.vision, true);
  assert.equal(gemini.reasoning, true);

  // Prefixed reseller ids resolve on the model name, not the vendor prefix.
  const qwen = resolveCapabilities("qwen/qwen3-vl-plus:free");
  assert.equal(qwen.vision, true);
  assert.equal(qwen.reasoning, true);

  const deepseek = resolveCapabilities("deepseek/deepseek-v4-flash-0731");
  assert.equal(deepseek.reasoning, true);
  assert.equal(deepseek.vision, false);
});

test("capabilities - text-only models resolve with both flags false", () => {
  const voxtral = resolveCapabilities("voxtral-small-latest");
  assert.equal(voxtral.vision, false);
  assert.equal(voxtral.reasoning, false);
});

test("capabilities - unknown models resolve to null so no icon and no field are shown", () => {
  assert.equal(resolveCapabilities("auto:free"), null);
  assert.equal(resolveCapabilities("solar-mini4"), null);
  assert.equal(resolveCapabilities(""), null);
  assert.equal(resolveCapabilities(undefined), null);
});

test("capabilities - only explicit booleans are read from the provider payload", () => {
  assert.deepEqual(capabilitiesFromApi({ capabilities: { reasoning: false, vision: true, completion_chat: true } }), {
    vision: true,
    reasoning: false,
  });
  assert.equal(capabilitiesFromApi({ capabilities: { completion_chat: true } }), null);
  assert.equal(capabilitiesFromApi({ capabilities: {} }), null);
  assert.equal(capabilitiesFromApi({}), null);
  assert.equal(capabilitiesFromApi(null), null);
});

test("capabilities - defaults are conservative", () => {
  assert.equal(DEFAULT_CAPABILITIES.vision, false);
  assert.equal(DEFAULT_CAPABILITIES.reasoning, false);
});
test("capabilities - Claude 1M windows match both id spellings, older Sonnet stays unset", () => {
  assert.equal(resolveCapabilities("claude-sonnet-5-5").contextWindow, 1000000);
  assert.equal(resolveCapabilities("claude-sonnet-4-6").contextWindow, 1000000);
  assert.equal(resolveCapabilities("claude-sonnet-4.6").contextWindow, 1000000);
  assert.equal(resolveCapabilities("claude-opus-4-6").contextWindow, 1000000);
  // No verified API window for this model, so the table does not guess one.
  assert.equal(resolveCapabilities("claude-sonnet-4-5-20250929").contextWindow, null);
});
