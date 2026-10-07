import test from "node:test";
import assert from "node:assert";
import {
  openaiToClaude,
  claudeToOpenAI,
} from "../src/translator/request.js";
import {
  claudeToOpenAIResponse,
  openAIToClaudeResponse,
} from "../src/translator/response.js";

test("Tool Calling - translates OpenAI tools definition to Claude input_schema", () => {
  const openAIBody = {
    model: "claude-3-7-sonnet",
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for location",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "get_weather" } },
    messages: [{ role: "user", content: "What is the weather?" }],
  };

  const claudeBody = openaiToClaude(openAIBody);
  assert.ok(Array.isArray(claudeBody.tools));
  assert.strictEqual(claudeBody.tools.length, 1);
  assert.strictEqual(claudeBody.tools[0].name, "get_weather");
  assert.strictEqual(claudeBody.tools[0].description, "Get weather for location");
  assert.deepStrictEqual(claudeBody.tools[0].input_schema, openAIBody.tools[0].function.parameters);
  assert.deepStrictEqual(claudeBody.tool_choice, { type: "tool", name: "get_weather" });
});

test("Tool Calling - translates OpenAI tool_calls assistant turn and tool result to Claude", () => {
  const openAIBody = {
    model: "claude-3-7-sonnet",
    messages: [
      { role: "user", content: "Check weather in Tokyo" },
      {
        role: "assistant",
        content: "Checking now...",
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: JSON.stringify({ location: "Tokyo" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: JSON.stringify({ temp: 22, condition: "Sunny" }),
      },
    ],
  };

  const claudeBody = openaiToClaude(openAIBody);
  assert.strictEqual(claudeBody.messages.length, 3);

  // Assistant turn contains text and tool_use block
  const asstMsg = claudeBody.messages[1];
  assert.strictEqual(asstMsg.role, "assistant");
  assert.ok(Array.isArray(asstMsg.content));
  assert.strictEqual(asstMsg.content[0].type, "text");
  assert.strictEqual(asstMsg.content[0].text, "Checking now...");
  assert.strictEqual(asstMsg.content[1].type, "tool_use");
  assert.strictEqual(asstMsg.content[1].id, "call_123");
  assert.strictEqual(asstMsg.content[1].name, "get_weather");
  assert.deepStrictEqual(asstMsg.content[1].input, { location: "Tokyo" });

  // Tool turn is converted to user message with tool_result
  const toolMsg = claudeBody.messages[2];
  assert.strictEqual(toolMsg.role, "user");
  assert.ok(Array.isArray(toolMsg.content));
  assert.strictEqual(toolMsg.content[0].type, "tool_result");
  assert.strictEqual(toolMsg.content[0].tool_use_id, "call_123");
  assert.ok(toolMsg.content[0].content.includes("Sunny"));
});

test("Tool Calling - translates Claude tool_use response to OpenAI tool_calls completion", () => {
  const claudeResponse = {
    id: "msg_tool_resp_1",
    model: "claude-3-7-sonnet",
    role: "assistant",
    content: [
      { type: "text", text: "I will check the weather." },
      {
        type: "tool_use",
        id: "toolu_456",
        name: "get_weather",
        input: { location: "Kyoto" },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 30, output_tokens: 15 },
  };

  const openAIComp = claudeToOpenAIResponse(claudeResponse);
  assert.strictEqual(openAIComp.choices[0].message.role, "assistant");
  assert.strictEqual(openAIComp.choices[0].message.content, "I will check the weather.");
  assert.ok(Array.isArray(openAIComp.choices[0].message.tool_calls));
  assert.strictEqual(openAIComp.choices[0].message.tool_calls.length, 1);

  const tc = openAIComp.choices[0].message.tool_calls[0];
  assert.strictEqual(tc.id, "toolu_456");
  assert.strictEqual(tc.type, "function");
  assert.strictEqual(tc.function.name, "get_weather");
  assert.deepStrictEqual(JSON.parse(tc.function.arguments), { location: "Kyoto" });
});

test("Tool Calling - translates OpenAI tool_calls response to Claude message", () => {
  const openAIResponse = {
    id: "chatcmpl_tool_789",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "Let me check.",
          tool_calls: [
            {
              id: "call_789",
              type: "function",
              function: {
                name: "lookup_data",
                arguments: JSON.stringify({ key: "alpha" }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 40, completion_tokens: 20 },
  };

  const claudeMsg = openAIToClaudeResponse(openAIResponse);
  assert.strictEqual(claudeMsg.role, "assistant");
  assert.ok(Array.isArray(claudeMsg.content));
  assert.strictEqual(claudeMsg.content[0].text, "Let me check.");
  assert.strictEqual(claudeMsg.content[1].type, "tool_use");
  assert.strictEqual(claudeMsg.content[1].id, "call_789");
  assert.strictEqual(claudeMsg.content[1].name, "lookup_data");
  assert.deepStrictEqual(claudeMsg.content[1].input, { key: "alpha" });
});
