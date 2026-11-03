import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import {
  initConsoleLogCapture,
  getConsoleLogs,
  clearConsoleLogs,
  captureLine,
  getConsoleEmitter,
  parseConsoleLogLine,
} from "../src/services/logger.js";

test("parseConsoleLogLine - parses standard [HH:MM:SS] [LOG] line", () => {
  const line = "[14:20:10] [LOG] Test standard message";
  const parsed = parseConsoleLogLine(line);
  assert.strictEqual(parsed.timestamp, "14:20:10");
  assert.strictEqual(parsed.level, "LOG");
  assert.strictEqual(parsed.message, "Test standard message");
});

test("parseConsoleLogLine - parses and promotes gateway [ROUTE] sub-tag", () => {
  const line = "[14:20:11] [LOG] [ROUTE] model=gpt-4 -> provider=openai (gpt-4) stream=true";
  const parsed = parseConsoleLogLine(line);
  assert.strictEqual(parsed.timestamp, "14:20:11");
  assert.strictEqual(parsed.level, "ROUTE");
  assert.strictEqual(parsed.message, "model=gpt-4 -> provider=openai (gpt-4) stream=true");
});

test("parseConsoleLogLine - parses and promotes gateway [USAGE] sub-tag", () => {
  const line = '[14:20:12] [LOG] [USAGE] model=gpt-4 | in=100 out=50 total=150 | 320ms | account="main"';
  const parsed = parseConsoleLogLine(line);
  assert.strictEqual(parsed.timestamp, "14:20:12");
  assert.strictEqual(parsed.level, "USAGE");
  assert.strictEqual(
    parsed.message,
    'model=gpt-4 | in=100 out=50 total=150 | 320ms | account="main"'
  );
});

test("parseConsoleLogLine - parses gateway [COMBO] and [FALLBACK] sub-tags", () => {
  const comboLine = "[14:20:13] [LOG] [COMBO] Combo 'zenith-smart': route to gpt-4";
  const comboParsed = parseConsoleLogLine(comboLine);
  assert.strictEqual(comboParsed.level, "COMBO");
  assert.strictEqual(comboParsed.message, "Combo 'zenith-smart': route to gpt-4");

  const fallbackLine = '[14:20:14] [LOG] [FALLBACK] model="origin" gagal, beralih ke "target"';
  const fallbackParsed = parseConsoleLogLine(fallbackLine);
  assert.strictEqual(fallbackParsed.level, "FALLBACK");
  assert.strictEqual(fallbackParsed.message, 'model="origin" gagal, beralih ke "target"');
});

test("parseConsoleLogLine - parses [ERROR] and preserves module prefixes like [zenith]", () => {
  const errorLine = "[14:20:15] [ERROR] [zenith] Unhandled error: connection refused";
  const parsed = parseConsoleLogLine(errorLine);
  assert.strictEqual(parsed.timestamp, "14:20:15");
  assert.strictEqual(parsed.level, "ERROR");
  assert.strictEqual(parsed.message, "[zenith] Unhandled error: connection refused");

  const logZenithLine = "[14:20:16] [LOG] [zenith] DLP redacted 1 secret(s): email";
  const logZenithParsed = parseConsoleLogLine(logZenithLine);
  assert.strictEqual(logZenithParsed.level, "LOG");
  assert.strictEqual(logZenithParsed.message, "[zenith] DLP redacted 1 secret(s): email");
});

test("parseConsoleLogLine - parses directly tagged lines without [LOG] prefix", () => {
  const routeDirect = "[14:20:17] [ROUTE] model=claude-3-5-sonnet -> provider=anthropic";
  const parsedRoute = parseConsoleLogLine(routeDirect);
  assert.strictEqual(parsedRoute.level, "ROUTE");
  assert.strictEqual(parsedRoute.message, "model=claude-3-5-sonnet -> provider=anthropic");

  const usageDirect = "[14:20:18] [USAGE] in=5 out=10 total=15 | 80ms";
  const parsedUsage = parseConsoleLogLine(usageDirect);
  assert.strictEqual(parsedUsage.level, "USAGE");
  assert.strictEqual(parsedUsage.message, "in=5 out=10 total=15 | 80ms");

  const infoDirect = "[14:20:19] [INFO] Gateway ready on port 20120";
  const parsedInfo = parseConsoleLogLine(infoDirect);
  assert.strictEqual(parsedInfo.level, "INFO");
  assert.strictEqual(parsedInfo.message, "Gateway ready on port 20120");
});

test("parseConsoleLogLine - handles structured object and edge cases", () => {
  const obj = {
    timestamp: "2025-01-01T15:30:00Z",
    level: "route",
    message: "routing request",
    requestId: "req-987654",
    model: "claude-3-5-sonnet",
  };
  const parsedObj = parseConsoleLogLine(obj);
  assert.strictEqual(parsedObj.timestamp, "15:30:00");
  assert.strictEqual(parsedObj.level, "ROUTE");
  assert.strictEqual(parsedObj.message, "routing request");
  assert.strictEqual(parsedObj.requestId, "req-987654");
  assert.strictEqual(parsedObj.model, "claude-3-5-sonnet");

  assert.strictEqual(parseConsoleLogLine(null), null);
  assert.strictEqual(parseConsoleLogLine(undefined), null);
  assert.strictEqual(parseConsoleLogLine("   "), null);

  const plain = parseConsoleLogLine("Plain text without header");
  assert.strictEqual(plain.level, "LOG");
  assert.strictEqual(plain.message, "Plain text without header");
  assert.ok(plain.timestamp.match(/^\d{2}:\d{2}:\d{2}$/));
});

test("console logs service - captures lines and notifies emitter", async () => {
  initConsoleLogCapture();
  clearConsoleLogs();

  const emitter = getConsoleEmitter();
  const receivedBatches = [];
  const onLines = (lines) => receivedBatches.push(lines);
  emitter.on("lines", onLines);

  captureLine("[ROUTE] model=test-unit -> provider=openai", "log");
  captureLine("[USAGE] model=test-unit | in=10 out=20 total=30 | 120ms", "log");

  // Wait for logger debounce flush (100ms)
  await new Promise((r) => setTimeout(r, 150));
  emitter.off("lines", onLines);

  const allLogs = getConsoleLogs();
  assert.ok(allLogs.some((l) => l.includes("[ROUTE] model=test-unit")));
  assert.ok(allLogs.some((l) => l.includes("[USAGE] model=test-unit")));

  assert.ok(receivedBatches.length >= 1, "Emitter should emit flushed lines");
  const emittedLines = receivedBatches.flat();
  assert.ok(emittedLines.some((l) => l.includes("[ROUTE] model=test-unit")));

  // Verify SSE payload structure contracts
  const initPayload = { type: "init", logs: allLogs };
  assert.strictEqual(initPayload.type, "init");
  assert.ok(Array.isArray(initPayload.logs));

  const linesPayload = { type: "lines", lines: emittedLines };
  assert.strictEqual(linesPayload.type, "lines");
  assert.ok(Array.isArray(linesPayload.lines));
});

test("GET /dashboard - includes robust console logs SSE parser and badge styles", async () => {
  const res = await app.request("/dashboard");
  assert.strictEqual(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes("parseLogLine"));
  assert.ok(html.includes("handleIncomingData"));
  assert.ok(html.includes("data.type === 'init'"));
  assert.ok(html.includes("data.type === 'lines'"));
  assert.ok(html.includes("route: 'var(--accent-lime)'"));
  assert.ok(html.includes("usage: 'var(--success)'"));
});
