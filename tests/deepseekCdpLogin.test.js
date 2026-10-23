import test from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  browserCandidates,
  CdpConnection,
  cdpEndpoint,
  cdpEndpoints,
  cookiesToHeader,
  findBrowser,
  looksLikeSessionToken,
  parseDevToolsActivePort,
} from "../src/services/deepseekWeb/cdpLogin.js";

test("cdp - the browser override wins over the platform defaults", () => {
  const previous = process.env.ZENITH_BROWSER_PATH;
  process.env.ZENITH_BROWSER_PATH = "/opt/custom/chrome";
  try {
    assert.deepStrictEqual(browserCandidates("win32"), ["/opt/custom/chrome"]);
    assert.deepStrictEqual(browserCandidates("linux"), ["/opt/custom/chrome"]);
  } finally {
    if (previous === undefined) delete process.env.ZENITH_BROWSER_PATH;
    else process.env.ZENITH_BROWSER_PATH = previous;
  }
});

test("cdp - default candidates follow the platform", () => {
  const previous = process.env.ZENITH_BROWSER_PATH;
  delete process.env.ZENITH_BROWSER_PATH;
  try {
    assert.ok(browserCandidates("win32").some((entry) => entry.endsWith("chrome.exe")));
    assert.ok(browserCandidates("win32").some((entry) => entry.endsWith("msedge.exe")));
    assert.ok(browserCandidates("darwin").some((entry) => entry.includes("Google Chrome.app")));
    assert.ok(browserCandidates("linux").some((entry) => entry === "/usr/bin/google-chrome"));
  } finally {
    if (previous !== undefined) process.env.ZENITH_BROWSER_PATH = previous;
  }
});

test("cdp - the debugging port file is parsed, junk is rejected", () => {
  assert.deepStrictEqual(parseDevToolsActivePort("51234\n/devtools/browser/abc-123\n"), {
    port: 51234,
    wsPath: "/devtools/browser/abc-123",
  });
  // Windows profiles write CRLF.
  assert.deepStrictEqual(parseDevToolsActivePort("4321\r\n/devtools/browser/x\r\n"), { port: 4321, wsPath: "/devtools/browser/x" });
  assert.strictEqual(parseDevToolsActivePort(""), null);
  assert.strictEqual(parseDevToolsActivePort("not-a-port\n/devtools/browser/x"), null);
  assert.strictEqual(parseDevToolsActivePort("0\n/devtools/browser/x"), null);
});

test("cdp - only plausible tokens are handed to the verifier", () => {
  assert.strictEqual(looksLikeSessionToken("x".repeat(40)), true);
  assert.strictEqual(looksLikeSessionToken("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl"), true);
  assert.strictEqual(looksLikeSessionToken("undefined"), false);
  assert.strictEqual(looksLikeSessionToken("eyJhbGciOiJIUzI1NiJ9.short.sig"), false);
  assert.strictEqual(looksLikeSessionToken("has whitespace inside the value that is long enough"), false);
  assert.strictEqual(looksLikeSessionToken(""), false);
  assert.strictEqual(looksLikeSessionToken(null), false);
});

test("cdp - the attach endpoint defaults to the Chrome debugging port", () => {
  const previous = process.env.ZENITH_CDP_ENDPOINT;
  try {
    delete process.env.ZENITH_CDP_ENDPOINT;
    assert.strictEqual(cdpEndpoint(), "http://127.0.0.1:9222");
    process.env.ZENITH_CDP_ENDPOINT = "http://127.0.0.1:9333/";
    assert.strictEqual(cdpEndpoint(), "http://127.0.0.1:9333");
  } finally {
    if (previous === undefined) delete process.env.ZENITH_CDP_ENDPOINT;
    else process.env.ZENITH_CDP_ENDPOINT = previous;
  }
});

test("cdp - cookies become a paste-ready header", () => {
  assert.strictEqual(
    cookiesToHeader([
      { name: "ds_session_id", value: "2" },
      { name: "intercom-id", value: "abc" },
      { value: "no-name" },
    ]),
    "ds_session_id=2; intercom-id=abc"
  );
  assert.strictEqual(cookiesToHeader([]), "");
  assert.strictEqual(cookiesToHeader(undefined), "");
});

test("cdp - findBrowser honours a custom path and reports a missing one", () => {
  const previous = process.env.ZENITH_BROWSER_PATH;
  const dir = mkdtempSync(path.join(os.tmpdir(), "zr-browser-"));
  const fake = path.join(dir, "chrome");
  writeFileSync(fake, "");
  try {
    process.env.ZENITH_BROWSER_PATH = fake;
    assert.strictEqual(findBrowser(), fake);

    process.env.ZENITH_BROWSER_PATH = path.join(dir, "tidak-ada");
    assert.throws(() => findBrowser(), /ZENITH_BROWSER_PATH/);
  } finally {
    if (previous === undefined) delete process.env.ZENITH_BROWSER_PATH;
    else process.env.ZENITH_BROWSER_PATH = previous;
  }
});

test("cdp - common debugging ports are probed without any dashboard button", () => {
  const previous = process.env.ZENITH_CDP_ENDPOINT;
  try {
    delete process.env.ZENITH_CDP_ENDPOINT;
    const endpoints = cdpEndpoints();
    assert.strictEqual(endpoints[0], "http://127.0.0.1:9222");
    assert.ok(endpoints.includes("http://127.0.0.1:9333"));
    assert.strictEqual(new Set(endpoints).size, endpoints.length);

    // An explicit endpoint wins the first probe but the defaults stay reachable.
    process.env.ZENITH_CDP_ENDPOINT = "http://127.0.0.1:9555/";
    assert.strictEqual(cdpEndpoints()[0], "http://127.0.0.1:9555");
    assert.ok(cdpEndpoints().includes("http://127.0.0.1:9222"));
  } finally {
    if (previous === undefined) delete process.env.ZENITH_CDP_ENDPOINT;
    else process.env.ZENITH_CDP_ENDPOINT = previous;
  }
});

test("cdp - a closed tab is visible to the login loop and fails pending calls", async () => {
  // Stand-in for Node's WebSocket: the same event interface, nothing on the wire.
  const ws = new EventTarget();
  ws.send = () => {};
  ws.close = () => {};
  const connection = new CdpConnection(ws);
  assert.strictEqual(connection.closed, false);

  const pending = connection.send("Runtime.evaluate", { expression: "1" });
  ws.dispatchEvent(new Event("close"));

  assert.strictEqual(connection.closed, true, "the loop stops instead of polling a dead tab");
  await assert.rejects(pending, /terputus/);
});
