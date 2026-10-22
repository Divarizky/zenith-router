import test from "node:test";
import assert from "node:assert";
import { HTTPException } from "hono/http-exception";
import { app } from "../src/index.js";
import { getConsoleLogs, clearConsoleLogs } from "../src/services/logger.js";

// Routes must be registered before the first request builds Hono's matcher.
app.get("/__onerror-probe", () => {
  throw new Error("boom-onerror-probe");
});
app.get("/__onerror-http-probe", () => {
  throw new HTTPException(418, { message: "teapot probe" });
});

test("app.onError - logs unhandled errors to the dashboard console, not the terminal", async () => {
  clearConsoleLogs();
  const originalError = console.error;
  let terminalPrints = 0;
  console.error = () => {
    terminalPrints++;
  };

  try {
    const res = await app.request("/__onerror-probe");
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.error.code, "internal_error");
    assert.ok(getConsoleLogs().some((l) => l.includes("boom-onerror-probe")), "error must be visible in the dashboard console");
    assert.strictEqual(terminalPrints, 0, "error must not reach the terminal");
  } finally {
    console.error = originalError;
  }
});

test("app.onError - HTTPException keeps its own status and body", async () => {
  const res = await app.request("/__onerror-http-probe");
  assert.strictEqual(res.status, 418);
  assert.ok((await res.text()).includes("teapot probe"));
});
