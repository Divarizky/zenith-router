import test from "node:test";
import assert from "node:assert";
import { openaiToGeminiRequest, cleanJsonSchema } from "../src/translator/gemini.js";

test("Gemini schema - strips const/patternProperties inside anyOf", () => {
  const out = openaiToGeminiRequest({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "t", parameters: {
      type: "object",
      properties: {
        mode: { anyOf: [{ const: "a", type: "string" }, { const: "b", type: "string" }] },
        map: { type: "object", patternProperties: { "^x": { type: "string" } } },
      },
    } } }],
  }, "gemini-3-pro");
  const json = JSON.stringify(out);
  assert.ok(!json.includes('"const"'));
  assert.ok(!json.includes("patternProperties"));
  assert.ok(json.includes('"enum":["a"]'));
});

test("Gemini schema - removes x-google-identifier at root and property levels", () => {
  const schema = {
    type: "object",
    "x-google-identifier": "root_tool_id",
    properties: {
      query: {
        type: "string",
        "x-google-identifier": "param_query_id",
      },
    },
  };
  const cleaned = cleanJsonSchema(schema);
  assert.strictEqual("x-google-identifier" in cleaned, false);
  assert.strictEqual("x-google-identifier" in cleaned.properties.query, false);
  assert.strictEqual(cleaned.properties.query.type, "string");
});

test("Gemini schema - removes x-google-enum-descriptions on enum field", () => {
  const schema = {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["ACTIVE", "INACTIVE"],
        "x-google-enum-descriptions": ["The item is active", "The item is inactive"],
      },
    },
  };
  const cleaned = cleanJsonSchema(schema);
  assert.strictEqual("x-google-enum-descriptions" in cleaned.properties.status, false);
  assert.deepStrictEqual(cleaned.properties.status.enum, ["ACTIVE", "INACTIVE"]);
});

test("Gemini schema - removes deprecated, readOnly, and writeOnly attributes", () => {
  const schema = {
    type: "object",
    deprecated: true,
    properties: {
      legacyField: {
        type: "string",
        deprecated: true,
      },
      readOnlyId: {
        type: "string",
        readOnly: true,
      },
      writeOnlySecret: {
        type: "string",
        writeOnly: true,
      },
    },
  };
  const cleaned = cleanJsonSchema(schema);
  assert.strictEqual("deprecated" in cleaned, false);
  assert.strictEqual("deprecated" in cleaned.properties.legacyField, false);
  assert.strictEqual("readOnly" in cleaned.properties.readOnlyId, false);
  assert.strictEqual("writeOnly" in cleaned.properties.writeOnlySecret, false);
  assert.strictEqual(cleaned.properties.legacyField.type, "string");
  assert.strictEqual(cleaned.properties.readOnlyId.type, "string");
  assert.strictEqual(cleaned.properties.writeOnlySecret.type, "string");
});

test("Gemini schema - preserves property name starting with x- while stripping x-* attributes inside it", () => {
  const schema = {
    type: "object",
    "x-google-identifier": "auth_tool",
    properties: {
      "x-api-key": {
        type: "string",
        "x-google-identifier": true,
        deprecated: true,
      },
      "x-request-id": {
        type: "string",
        readOnly: true,
      },
    },
    required: ["x-api-key"],
  };
  const cleaned = cleanJsonSchema(schema);
  assert.strictEqual("x-google-identifier" in cleaned, false);
  assert.ok("x-api-key" in cleaned.properties, "x-api-key property should be preserved");
  assert.ok("x-request-id" in cleaned.properties, "x-request-id property should be preserved");
  assert.strictEqual("x-google-identifier" in cleaned.properties["x-api-key"], false);
  assert.strictEqual("deprecated" in cleaned.properties["x-api-key"], false);
  assert.strictEqual("readOnly" in cleaned.properties["x-request-id"], false);
  assert.strictEqual(cleaned.properties["x-api-key"].type, "string");
  assert.strictEqual(cleaned.properties["x-request-id"].type, "string");
  assert.deepStrictEqual(cleaned.required, ["x-api-key"]);
});

test("Gemini schema - removes x-* and unsupported attributes in nested array items", () => {
  const schema = {
    type: "array",
    "x-google-identifier": "items_list",
    items: {
      type: "object",
      "x-google-identifier": "item_record",
      deprecated: false,
      properties: {
        id: {
          type: "string",
          readOnly: true,
          "x-google-identifier": "field_id",
        },
        "x-meta-tag": {
          type: "string",
          writeOnly: true,
          "x-google-identifier": "field_meta",
        },
      },
      required: ["id", "x-meta-tag"],
    },
  };
  const cleaned = cleanJsonSchema(schema);
  assert.strictEqual("x-google-identifier" in cleaned, false);
  assert.strictEqual("x-google-identifier" in cleaned.items, false);
  assert.strictEqual("deprecated" in cleaned.items, false);
  assert.ok("x-meta-tag" in cleaned.items.properties, "x-meta-tag property should be preserved");
  assert.strictEqual("readOnly" in cleaned.items.properties.id, false);
  assert.strictEqual("x-google-identifier" in cleaned.items.properties.id, false);
  assert.strictEqual("writeOnly" in cleaned.items.properties["x-meta-tag"], false);
  assert.strictEqual("x-google-identifier" in cleaned.items.properties["x-meta-tag"], false);
  assert.deepStrictEqual(cleaned.items.required, ["id", "x-meta-tag"]);
});

test("Gemini schema - end-to-end openaiToGeminiRequest sanitizes vendor x-* and unsupported keys", () => {
  const out = openaiToGeminiRequest({
    messages: [{ role: "user", content: "test" }],
    tools: [
      {
        type: "function",
        function: {
          name: "fetchData",
          description: "Fetches data with header",
          parameters: {
            type: "object",
            "x-google-identifier": "fetchData_params",
            deprecated: true,
            properties: {
              "x-client-trace": {
                type: "string",
                "x-google-identifier": "trace_id",
                readOnly: true,
              },
              action: {
                type: "string",
                enum: ["GET", "POST"],
                "x-google-enum-descriptions": ["Read action", "Write action"],
              },
            },
          },
        },
      },
    ],
  }, "gemini-2.5-flash");

  const decl = out.tools[0].functionDeclarations[0];
  assert.strictEqual(decl.name, "fetchData");
  const params = decl.parameters;
  assert.strictEqual(params["x-google-identifier"], undefined);
  assert.strictEqual(params.deprecated, undefined);
  assert.ok("x-client-trace" in params.properties);
  assert.strictEqual(params.properties["x-client-trace"]["x-google-identifier"], undefined);
  assert.strictEqual(params.properties["x-client-trace"].readOnly, undefined);
  assert.strictEqual(params.properties["x-client-trace"].type, "string");
  assert.strictEqual(params.properties.action["x-google-enum-descriptions"], undefined);
  assert.deepStrictEqual(params.properties.action.enum, ["GET", "POST"]);
});

test("Gemini thinkingConfig - translates reasoning_effort into thinkingConfig", () => {
  const withEffort = openaiToGeminiRequest({
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "high",
  }, "gemini-3.8-flash");
  assert.deepStrictEqual(withEffort.generationConfig.thinkingConfig, { includeThoughts: true });

  const disabledEffort = openaiToGeminiRequest({
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "none",
  }, "gemini-3.8-flash");
  assert.deepStrictEqual(disabledEffort.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

