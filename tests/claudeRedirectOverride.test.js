import test from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/**
 * The redirect URI is read from the environment when the OAuth module loads,
 * so an override has to be observed in a fresh process.
 */
function runWithEnv(env, code) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

test("claude OAuth - CLAUDE_CODE_REDIRECT_URI menimpa redirect URI resmi", () => {
  const code = `
    const { OAUTH_CONFIG } = await import("./src/services/oauth/providers.js");
    console.log(OAUTH_CONFIG.claude.redirectUri);
  `;
  const overridden = runWithEnv({ CLAUDE_CODE_REDIRECT_URI: "https://example.test/cb" }, code);
  assert.strictEqual(overridden.status, 0, overridden.stderr);
  assert.strictEqual(overridden.stdout, "https://example.test/cb");

  const fallback = runWithEnv({ CLAUDE_CODE_REDIRECT_URI: "" }, code);
  assert.strictEqual(fallback.status, 0, fallback.stderr);
  assert.strictEqual(fallback.stdout, "https://platform.claude.com/oauth/code/callback");
});

test("claude OAuth - redirect URI yang dipakai authorization dan token exchange sama", async () => {
  const code = `
    const { startOAuthFlow } = await import("./src/services/oauth/flows.js");
    const { initDb } = await import("./src/db/index.js");
    initDb(":memory:");
    const started = await startOAuthFlow({ providerId: "claude", origin: "http://127.0.0.1:20120" });
    const auth = new URL(started.authUrl);
    console.log(auth.searchParams.get("redirect_uri"));
  `;
  const r = runWithEnv({ CLAUDE_CODE_REDIRECT_URI: "https://example.test/cb" }, code);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, "https://example.test/cb");
});
