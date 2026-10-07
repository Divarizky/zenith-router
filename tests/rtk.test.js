import test from "node:test";
import assert from "node:assert";
import { condenseContent, condenseMessages } from "../src/services/rtk.js";

test("rtk service - suppresses consecutive duplicate lines", () => {
  const repeatingLog = [
    "info: initializing server",
    "debug: checking connection heartbeats",
    "debug: checking connection heartbeats",
    "debug: checking connection heartbeats",
    "debug: checking connection heartbeats",
    "debug: checking connection heartbeats",
    "info: server started successfully",
  ].join("\n");

  const result = condenseContent(repeatingLog);
  assert.ok(result.condensedText.includes("info: initializing server"));
  assert.ok(result.condensedText.includes("info: server started successfully"));
  assert.ok(result.condensedText.includes("duplicate lines suppressed"));
  assert.ok(result.savedChars > 0);
  assert.ok(result.savedTokensEstimate > 0);
  assert.ok(result.condensedLength < result.originalLength);
});

test("rtk service - preserves code blocks intact", () => {
  const codeContent = `Here is the code implementation:

\`\`\`javascript
function calculateSum(a, b) {
  // line 1
  // line 1
  // line 1
  // line 1
  return a + b;
}
\`\`\`

Hope this helps!`;

  const result = condenseContent(codeContent);
  // Code block inside markdown must NOT be stripped or altered
  assert.ok(result.condensedText.includes("function calculateSum(a, b)"));
  assert.ok(result.condensedText.includes("return a + b;"));
  assert.strictEqual(result.condensedText, codeContent);
});

test("rtk service - condenseMessages processes messages array and tracks metrics", () => {
  const messages = [
    { role: "system", content: "You are a coding agent." },
    {
      role: "user",
      content: `Here are the build logs:\n${"npm install verbose line\n".repeat(10)}Done`,
    },
  ];

  const result = condenseMessages(messages);
  assert.strictEqual(result.messages.length, 2);
  assert.ok(result.totalSavedChars > 0);
  assert.ok(result.totalSavedTokens > 0);
  assert.ok(result.messages[1].content.includes("duplicate lines suppressed"));
  assert.ok(result.messages[1].content.includes("Done"));
});
