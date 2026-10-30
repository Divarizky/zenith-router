import test from "node:test";
import assert from "node:assert";
import { scanForSecrets, redactSecrets, dlpModeFrom } from "../src/services/dlp.js";
import { setSetting, getSetting } from "../src/services/settings.js";
import { app } from "../src/index.js";
import { setCustomExecutor } from "../src/executors/base.js";
import { initDb, addConnection } from "../src/db/index.js";
import { createCombo } from "../src/services/combos.js";

// ============================================================================
// Modul Murni DLP (src/services/dlp.js)
// ============================================================================

test("dlpModeFrom - normalizes mode correctly", () => {
  assert.strictEqual(dlpModeFrom("off"), "off");
  assert.strictEqual(dlpModeFrom("redact"), "redact");
  assert.strictEqual(dlpModeFrom("block"), "block");
  assert.strictEqual(dlpModeFrom("REDACT"), "redact");
  assert.strictEqual(dlpModeFrom("BLOCK"), "block");
  assert.strictEqual(dlpModeFrom("unknown"), "off");
  assert.strictEqual(dlpModeFrom(""), "off");
  assert.strictEqual(dlpModeFrom(null), "off");
  assert.strictEqual(dlpModeFrom(undefined), "off");
  assert.strictEqual(dlpModeFrom({ dlp_mode: "redact" }), "redact");
  assert.strictEqual(dlpModeFrom({ dlp_mode: "block" }), "block");
  assert.strictEqual(dlpModeFrom({ dlp_mode: "invalid" }), "off");
  assert.strictEqual(dlpModeFrom({}), "off");
});

test("dlp - detects and redacts every secret type into [REDACTED:<type>]", () => {
  const anthropicKey = "sk-ant-api03-abcdefghijklmnop12345";
  const openaiKey = "sk-proj-12345678901234567890";
  const ghToken = "ghp_12345678901234567890";
  const ghPat = "github_pat_12345678901234567890_abcdefghij";
  const awsKey = "AKIAIOSFODNN7EXAMPLE";
  const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA012345\n-----END RSA PRIVATE KEY-----";

  // Anthropic API key
  const scanAnt = scanForSecrets(anthropicKey);
  assert.strictEqual(scanAnt.found, true);
  assert.deepStrictEqual(scanAnt.types, ["anthropic_api_key"]);
  const redAnt = redactSecrets(anthropicKey);
  assert.strictEqual(redAnt.value, "[REDACTED:anthropic_api_key]");
  assert.strictEqual(redAnt.count, 1);

  // sk-ant- is not misclassified as openai_api_key
  assert.ok(!scanAnt.types.includes("openai_api_key"), "sk-ant- must not be classified as openai_api_key");

  // OpenAI API key
  const scanOai = scanForSecrets(openaiKey);
  assert.strictEqual(scanOai.found, true);
  assert.deepStrictEqual(scanOai.types, ["openai_api_key"]);
  const redOai = redactSecrets(openaiKey);
  assert.strictEqual(redOai.value, "[REDACTED:openai_api_key]");

  // GitHub tokens
  const scanGh = scanForSecrets(`${ghToken} and ${ghPat}`);
  assert.strictEqual(scanGh.found, true);
  assert.deepStrictEqual(scanGh.types, ["github_token"]);
  const redGh = redactSecrets(`${ghToken} and ${ghPat}`);
  assert.strictEqual(redGh.value, "[REDACTED:github_token] and [REDACTED:github_token]");
  assert.strictEqual(redGh.count, 2);

  // AWS access key
  const scanAws = scanForSecrets(awsKey);
  assert.strictEqual(scanAws.found, true);
  assert.deepStrictEqual(scanAws.types, ["aws_access_key"]);
  const redAws = redactSecrets(awsKey);
  assert.strictEqual(redAws.value, "[REDACTED:aws_access_key]");

  // Private key
  const scanPk = scanForSecrets(privateKey);
  assert.strictEqual(scanPk.found, true);
  assert.deepStrictEqual(scanPk.types, ["private_key"]);
  const redPk = redactSecrets(privateKey);
  assert.strictEqual(redPk.value, "[REDACTED:private_key]");
});

test("dlp - placeholders are not counted as secrets", () => {
  const placeholders = [
    'password = "your-api-key"',
    "token: <token>",
    "secret: ${API_KEY}",
    "apiKey: process.env.TOKEN",
    'password = "xxxxxxxx"',
    "passwd: changeme",
    'token = "example"',
    'secret = "sample"',
    'password = "test"',
    'apikey: "dummy"',
    'client_secret: "placeholder"',
    'signing_secret: "none"',
  ];

  for (const text of placeholders) {
    const scan = scanForSecrets(text);
    assert.strictEqual(scan.found, false, `Placeholder should not be detected: ${text}`);
    assert.strictEqual(scan.types.length, 0);

    const red = redactSecrets(text);
    assert.strictEqual(red.count, 0, `Placeholder should not be redacted: ${text}`);
    assert.strictEqual(red.value, text);
  }
});

test("dlp - free text credential assignment replaces only the value", () => {
  const input1 = 'password = "hunter2hunter2"';
  const red1 = redactSecrets(input1);
  assert.strictEqual(red1.value, 'password = "[REDACTED:credential_assignment]"');
  assert.strictEqual(red1.count, 1);
  assert.deepStrictEqual(red1.types, ["credential_assignment"]);

  const input2 = "token: abcdefghij12";
  const red2 = redactSecrets(input2);
  assert.strictEqual(red2.value, "token: [REDACTED:credential_assignment]");
  assert.strictEqual(red2.count, 1);

  const input3 = "The admin token: abcdefghij12.";
  const red3 = redactSecrets(input3);
  assert.strictEqual(red3.value, "The admin token: [REDACTED:credential_assignment].");
  assert.strictEqual(red3.count, 1);
});

test("dlp - object field apiKey is redacted, other fields are untouched", () => {
  const obj = {
    apiKey: "real_secret_token_12345",
    otherField: "real_secret_token_12345",
    model: "gpt-4o",
  };

  const scan = scanForSecrets(obj);
  assert.strictEqual(scan.found, true);
  assert.deepStrictEqual(scan.types, ["credential_assignment"]);

  const red = redactSecrets(obj);
  assert.strictEqual(red.count, 1);
  assert.strictEqual(red.value.apiKey, "[REDACTED:credential_assignment]");
  assert.strictEqual(red.value.otherField, "real_secret_token_12345");
  assert.strictEqual(red.value.model, "gpt-4o");
});

test("dlp - JSON-in-string tool call arguments parsed, redacted, and re-stringified", () => {
  // JSON string containing a secret
  const withSecret = JSON.stringify({
    action: "login",
    password: "hunter2hunter2",
  });
  const redWithSecret = redactSecrets(withSecret);
  assert.strictEqual(redWithSecret.count, 1);
  const parsedRedacted = JSON.parse(redWithSecret.value);
  assert.strictEqual(parsedRedacted.action, "login");
  assert.strictEqual(parsedRedacted.password, "[REDACTED:credential_assignment]");

  // JSON string without secrets returns exact same string instance/content
  const cleanJson = JSON.stringify({ location: "Tokyo", count: 5 });
  const redClean = redactSecrets(cleanJson);
  assert.strictEqual(redClean.count, 0);
  assert.strictEqual(redClean.value, cleanJson, "Output must be identical to input when no secrets exist");
});

test("dlp - multiline private keys redacted entirely, including escaped \\n and truncated", () => {
  // Multi-line complete key
  const fullKey = `header text
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACD42l9x...
-----END OPENSSH PRIVATE KEY-----
footer text`;
  const redFull = redactSecrets(fullKey);
  assert.strictEqual(redFull.value, "header text\n[REDACTED:private_key]\nfooter text");
  assert.strictEqual(redFull.count, 1);

  // Escaped \n inside a string
  const escapedKey = "prefix -----BEGIN EC PRIVATE KEY-----\\nMHcCAQEE...\\n-----END EC PRIVATE KEY----- suffix";
  const redEscaped = redactSecrets(escapedKey);
  assert.strictEqual(redEscaped.value, "prefix [REDACTED:private_key] suffix");

  // Truncated private key (no END)
  const truncatedKey = "prefix text\n-----BEGIN DSA PRIVATE KEY-----\nMIIBvAIBAAKCAQEA...";
  const redTruncated = redactSecrets(truncatedKey);
  assert.strictEqual(redTruncated.value, "prefix text\n[REDACTED:private_key]");
  assert.strictEqual(redTruncated.count, 1);
});

test("dlp - input not mutated, circular reference protected, base64 images untouched", () => {
  // Input immutability
  const original = {
    apiKey: "secret_12345678",
    nested: {
      items: ["sk-proj-12345678901234567890"],
    },
  };
  const snapshot = JSON.stringify(original);
  const red = redactSecrets(original);
  assert.strictEqual(JSON.stringify(original), snapshot, "Original input must not be mutated");
  assert.notStrictEqual(red.value, original);

  // Circular reference
  const circular = { name: "test" };
  circular.self = circular;
  const scanCirc = scanForSecrets(circular);
  assert.strictEqual(scanCirc.found, false);
  const redCirc = redactSecrets(circular);
  assert.strictEqual(redCirc.count, 0);

  // Base64 image
  const base64Data = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
  const claudeImage = {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP...",
    },
  };

  const redDataUri = redactSecrets(base64Data);
  assert.strictEqual(redDataUri.value, base64Data);
  assert.strictEqual(redDataUri.count, 0);

  const redClaude = redactSecrets(claudeImage);
  assert.strictEqual(redClaude.value.source.data, claudeImage.source.data);
  assert.strictEqual(redClaude.count, 0);
});

test("dlp - fail-closed: input that still has secrets after redaction returns value: null", () => {
  // Object with a non-writable property containing a secret that cannot be sanitized
  const unredactable = {};
  Object.defineProperty(unredactable, "apiKey", {
    value: "sk-proj-12345678901234567890",
    writable: false,
    configurable: false,
    enumerable: true,
  });

  const res = redactSecrets(unredactable);
  assert.strictEqual(res.value, null, "Must fail closed with value: null");
  assert.ok(res.types.includes("openai_api_key"));
  assert.ok(res.count > 0);
});

test("dlp - performance: 2 MB string scanned < 500 ms and ReDoS backtracking protected", () => {
  // 2 MB clean text
  const largeClean = "This is a clean sentence for performance benchmarking.\n".repeat(38000); // ~2.1 MB
  const t0 = performance.now();
  const scanLarge = scanForSecrets(largeClean);
  const durationLarge = performance.now() - t0;

  assert.strictEqual(scanLarge.found, false);
  assert.ok(durationLarge < 500, `2 MB scan took ${durationLarge}ms, expected < 500ms`);

  // ReDoS backtracking test: 10,000 repetitions of "sk-" finishes quickly without stalling
  const repeatedSk = "sk-".repeat(10000);
  const t1 = performance.now();
  scanForSecrets(repeatedSk);
  const durationReDoS = performance.now() - t1;

  assert.ok(durationReDoS < 100, `ReDoS scan took ${durationReDoS}ms, expected < 100ms`);
});

// ============================================================================
// Pengaturan DLP (Dashboard GET & POST)
// ============================================================================

test("POST /dashboard/dlp - saves only valid values, rejects unknown values", async () => {
  initDb(":memory:");
  const originalMode = getSetting("dlp_mode", "off");

  try {
    // Valid: redact
    await app.request("/dashboard/dlp", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ dlp_mode: "redact" }).toString(),
    });
    assert.strictEqual(getSetting("dlp_mode"), "redact");

    // Valid: block
    await app.request("/dashboard/dlp", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ dlp_mode: "block" }).toString(),
    });
    assert.strictEqual(getSetting("dlp_mode"), "block");

    // Invalid value: must NOT change the setting (remains 'block')
    await app.request("/dashboard/dlp", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ dlp_mode: "invalid_value_hax" }).toString(),
    });
    assert.strictEqual(getSetting("dlp_mode"), "block");

    // Valid: off
    await app.request("/dashboard/dlp", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ dlp_mode: "off" }).toString(),
    });
    assert.strictEqual(getSetting("dlp_mode"), "off");
  } finally {
    setSetting("dlp_mode", originalMode);
  }
});

// ============================================================================
// Gateway Integration (relay.js with app.request and mock executor)
// ============================================================================

test("gateway - dlp_mode=off: payload passes to executor unmodified", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM test", credentials: { api_key: "test-key" } });
  setSetting("dlp_mode", "off");

  const captured = [];
  setCustomExecutor({
    async execute({ body }) {
      captured.push(JSON.parse(body));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    const rawSecret = "sk-proj-12345678901234567890";
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm/glm-4-flash",
        messages: [{ role: "user", content: `my key is ${rawSecret}` }],
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(captured.length, 1);
    assert.ok(captured[0].messages[0].content.includes(rawSecret), "Secret must pass through untouched when off");
  } finally {
    setCustomExecutor(null);
    setSetting("dlp_mode", "off");
  }
});

test("gateway - dlp_mode=redact: payload is sanitized, 200 response returned", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM test", credentials: { api_key: "test-key" } });
  setSetting("dlp_mode", "redact");

  const captured = [];
  setCustomExecutor({
    async execute({ body }) {
      captured.push(JSON.parse(body));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    const rawSecret = "sk-proj-12345678901234567890";
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm/glm-4-flash",
        messages: [{ role: "user", content: `my key is ${rawSecret}` }],
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(captured.length, 1);
    assert.ok(!captured[0].messages[0].content.includes(rawSecret), "Secret must not be present in relayed payload");
    assert.ok(captured[0].messages[0].content.includes("[REDACTED:openai_api_key]"), "Redacted token must be present");
  } finally {
    setCustomExecutor(null);
    setSetting("dlp_mode", "off");
  }
});

test("gateway - dlp_mode=block: returns 422 with proper client envelope (OpenAI & Claude)", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM test", credentials: { api_key: "test-key" } });
  addConnection({ provider: "anthropic", name: "Anthropic test", credentials: { api_key: "test-key" } });
  setSetting("dlp_mode", "block");

  let executorCalled = false;
  setCustomExecutor({
    async execute() {
      executorCalled = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  try {
    const rawSecret = "sk-proj-12345678901234567890";

    // 1. OpenAI endpoint (/v1/chat/completions)
    const oaiRes = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "glm/glm-4-flash",
        messages: [{ role: "user", content: `here is ${rawSecret}` }],
      }),
    });

    assert.strictEqual(oaiRes.status, 422);
    assert.strictEqual(executorCalled, false, "Executor must NOT be called when blocked");
    const oaiJson = await oaiRes.json();
    assert.ok(oaiJson.error, "Must match OpenAI error envelope");
    assert.strictEqual(oaiJson.error.type, "security_policy_error");
    assert.strictEqual(oaiJson.error.code, "security_policy_error");
    assert.ok(oaiJson.error.message.includes("openai_api_key"));
    assert.ok(!oaiJson.error.message.includes(rawSecret), "Error message must NEVER contain secret value");

    // 2. Anthropic endpoint (/v1/messages)
    const claudeRes = await app.request("/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "anthropic/claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: `here is ${rawSecret}` }],
        max_tokens: 100,
      }),
    });

    assert.strictEqual(claudeRes.status, 422);
    assert.strictEqual(executorCalled, false, "Executor must NOT be called when blocked");
    const claudeJson = await claudeRes.json();
    assert.strictEqual(claudeJson.type, "error", "Must match Claude error envelope");
    assert.ok(claudeJson.error);
    assert.strictEqual(claudeJson.error.type, "security_policy_error");
    assert.ok(claudeJson.error.message.includes("openai_api_key"));
    assert.ok(!claudeJson.error.message.includes(rawSecret), "Error message must NEVER contain secret value");
  } finally {
    setCustomExecutor(null);
    setSetting("dlp_mode", "off");
  }
});

test("gateway - combo chain and fallback members receive cleaned payload (single scan at relay)", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM test", credentials: { api_key: "test-key" } });
  createCombo({
    name: "test-dlp-combo",
    strategy: "fallback",
    models: ["glm/glm-4-flash", "glm/glm-4-air"],
  });

  setSetting("dlp_mode", "redact");

  const capturedBodies = [];
  let attempt = 0;

  setCustomExecutor({
    async execute({ body }) {
      capturedBodies.push(JSON.parse(body));
      attempt++;
      if (attempt === 1) {
        // First combo member fails with 500 to trigger fallback to second member
        return new Response(JSON.stringify({ error: { message: "member 1 failed", type: "api_error" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Second combo member succeeds
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from member 2" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    const rawSecret = "sk-proj-12345678901234567890";
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "test-dlp-combo",
        messages: [{ role: "user", content: `secret is ${rawSecret}` }],
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(capturedBodies.length, 2, "Both combo members were attempted");

    // Both members received the sanitized payload
    for (const b of capturedBodies) {
      assert.ok(!b.messages[0].content.includes(rawSecret), "Combo member must not receive raw secret");
      assert.ok(b.messages[0].content.includes("[REDACTED:openai_api_key]"), "Combo member must receive redacted marker");
    }
  } finally {
    setCustomExecutor(null);
    setSetting("dlp_mode", "off");
  }
});
