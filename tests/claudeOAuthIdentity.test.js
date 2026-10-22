import test from "node:test";
import assert from "node:assert";
import { applyConnectionAuth } from "../src/services/auth.js";
import { extractClaudeSessionId, claudeUserAgent } from "../src/services/claudeIdentity.js";

const oauthClaude = {
  provider: "claude",
  auth_type: "oauth",
  credentials: { access_token: "sk-ant-oat01-xyz", refresh_token: "rt" },
};

test("claude identity - session id dibaca dari metadata.user_id", () => {
  assert.strictEqual(extractClaudeSessionId('{"session_id":"sess-1"}'), "sess-1");
  assert.strictEqual(extractClaudeSessionId("sess-2"), "sess-2");
  assert.strictEqual(extractClaudeSessionId("claude:sess-3"), "sess-3");
  assert.strictEqual(extractClaudeSessionId("claude:"), null);
  assert.strictEqual(extractClaudeSessionId(""), null);
  assert.strictEqual(extractClaudeSessionId(null), null);
  assert.strictEqual(extractClaudeSessionId("{not json"), null);
  assert.strictEqual(extractClaudeSessionId('{"other":"x"}'), null);
});

test("claude identity - session id dibersihkan dari karakter kontrol dan dipotong", () => {
  assert.strictEqual(extractClaudeSessionId("sess\r\nX-Injected: 1"), "sessX-Injected: 1");
  assert.strictEqual(extractClaudeSessionId("sess\u0000evil"), "sessevil");
  const long = extractClaudeSessionId("a".repeat(500));
  assert.strictEqual(long.length, 200, "panjang dibatasi");
  assert.strictEqual(extractClaudeSessionId("claude:\r\n"), null);
});

test("claude identity - user agent sama untuk login, bootstrap, dan runtime", () => {
  assert.match(claudeUserAgent(), /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
});

test("claude auth - header OAuth Claude memakai identitas Claude Code", () => {
  const h = applyConnectionAuth({}, oauthClaude);
  assert.strictEqual(h["Authorization"], "Bearer sk-ant-oat01-xyz");
  assert.strictEqual(h["User-Agent"], claudeUserAgent());
  assert.match(h["User-Agent"], /^claude-cli\/\d+\.\d+\.\d+ /);
  assert.strictEqual(h["X-App"], "cli");
  assert.strictEqual(h["Anthropic-Dangerous-Direct-Browser-Access"], "true");
  assert.ok(h["anthropic-beta"].includes("oauth-2025-04-20"));
  assert.ok(h["anthropic-beta"].includes("claude-code-20250219"));
  assert.ok(h["anthropic-beta"].includes("interleaved-thinking-2025-05-14"));
});

test("claude auth - header beta dari client dipertahankan dan digabung", () => {
  const h = applyConnectionAuth({ "anthropic-beta": "custom-beta-1" }, oauthClaude);
  assert.ok(h["anthropic-beta"].includes("custom-beta-1"));
  assert.ok(h["anthropic-beta"].includes("oauth-2025-04-20"));
});

test("claude auth - API key Claude memakai x-api-key, bukan Bearer", () => {
  const h = applyConnectionAuth({}, {
    provider: "claude",
    auth_type: "apikey",
    credentials: { api_key: "sk-ant-api03-abc" },
  });
  assert.strictEqual(h["x-api-key"], "sk-ant-api03-abc");
  assert.strictEqual(h["Authorization"], undefined);
});

test("claude auth - session id hanya dipasang dari metadata milik request", () => {
  const withSession = applyConnectionAuth({}, oauthClaude, { claudeSessionId: "sess-9" });
  assert.strictEqual(withSession["x-claude-code-session-id"], "sess-9");
  assert.strictEqual(withSession["x-zenith-claude-session"], undefined, "header internal tidak diteruskan");

  const withoutSession = applyConnectionAuth({}, oauthClaude);
  assert.strictEqual(withoutSession["x-claude-code-session-id"], undefined);

  const kept = applyConnectionAuth({ "x-claude-code-session-id": "sess-explicit" }, oauthClaude, {
    claudeSessionId: "sess-other",
  });
  assert.strictEqual(kept["x-claude-code-session-id"], "sess-explicit", "header client tidak ditimpa");
});
