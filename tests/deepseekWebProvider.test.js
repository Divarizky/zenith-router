import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { getConnections, initDb } from "../src/db/index.js";
import { getAvailableModels, getProvider, resolveModel } from "../src/providers/index.js";
import { addConnection } from "../src/db/index.js";
import { applyConnectionAuth } from "../src/services/auth.js";
import { resolveProviderConcurrency, resetTrafficGuardState } from "../src/services/trafficGuard.js";

test("registry - deepseek-web is a session provider capped at three parallel turns", () => {
  initDb(":memory:");
  resetTrafficGuardState();

  const provider = getProvider("deepseek-web");
  assert.ok(provider, "provider resolves by id and alias");
  assert.strictEqual(provider.category, "session");
  assert.deepStrictEqual(provider.authMethods, ["session"]);
  assert.strictEqual(provider.format, "openai");
  assert.strictEqual(provider.executor, "deepseek-web");
  assert.strictEqual(provider.concurrency, 3);
  // One endpoint, two modes: chat and thinking (`thinking_enabled`).
  assert.deepStrictEqual(provider.models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.strictEqual(provider.alias[0], "dsw", "the model prefix is dsw");
  assert.strictEqual(getProvider("dsw").id, "deepseek-web");
  assert.strictEqual(getProvider("dweb").id, "deepseek-web", "the old prefix still routes");
  assert.strictEqual(resolveProviderConcurrency("deepseek-web"), 3);
});

test("catalog - models are published under dsw/ and the old prefix still resolves", () => {
  initDb(":memory:");
  addConnection({
    provider: "deepseek-web",
    name: "Akun web",
    auth_type: "session",
    credentials: { token: "tok", cookies: "" },
  });

  const ids = getAvailableModels().map((model) => model.id);
  assert.ok(ids.includes("dsw/deepseek-chat"), `catalog: ${ids.join(", ")}`);
  assert.ok(ids.includes("dsw/deepseek-reasoner"), `catalog: ${ids.join(", ")}`);
  assert.ok(!ids.some((id) => id.startsWith("dweb/")), "the old prefix is no longer advertised");

  // Legacy names keep working for clients that were configured before the rename.
  assert.strictEqual(resolveModel("dsw/deepseek-chat").provider.id, "deepseek-web");
  assert.strictEqual(resolveModel("dweb/deepseek-chat").provider.id, "deepseek-web");
  assert.strictEqual(resolveModel("chatbrain/deepseek-chat").provider.id, "deepseek-web");
  assert.strictEqual(resolveModel("dsw/deepseek-reasoner").targetModel, "deepseek-reasoner");
});

test("auth - session credentials become bearer and cookie headers", () => {
  const connection = {
    id: 1,
    provider: "deepseek-web",
    auth_type: "session",
    credentials: { token: "tok_abc", cookies: "a=1; b=2" },
  };
  const headers = applyConnectionAuth({}, connection);
  assert.strictEqual(headers.Authorization, "Bearer tok_abc");
  assert.strictEqual(headers.Cookie, "a=1; b=2");

  const objectCookies = applyConnectionAuth({}, {
    ...connection,
    credentials: { token: "tok", cookies: { a: "1", b: "2" } },
  });
  assert.strictEqual(objectCookies.Cookie, "a=1; b=2");

  const arrayCookies = applyConnectionAuth({}, {
    ...connection,
    credentials: { token: "tok", cookies: [{ name: "a", value: "1" }] },
  });
  assert.strictEqual(arrayCookies.Cookie, "a=1");

  const noToken = applyConnectionAuth({}, { ...connection, credentials: {} });
  assert.strictEqual(noToken.Authorization, undefined, "no token, no header");
});

test("dashboard - the provider list groups deepseek-web under session providers", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers")).text();

  assert.ok(html.includes("Session Providers"));
  assert.ok(html.includes("DeepSeek Web Chat"));
  assert.ok(html.includes("deepseek-web"), "the card links to the detail page");
  assert.ok(html.includes("berisiko pembatasan atau pemblokiran akun"), "the ToS risk is stated up front");
});

test("dashboard - the detail page shows the cap and the session form", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers/deepseek-web")).text();

  assert.ok(html.includes("3 per akun"), "the registry cap is visible before any setting exists");
  assert.ok(html.includes('name="token"'), "the account form asks for the web token");
  assert.ok(html.includes('name="cookies"'), "cookies are optional but offered");
  assert.ok(html.includes("setara akses penuh"), "the account form warns about token scope");
  assert.ok(html.includes("ketentuan layanan"), "the detail page repeats the ToS warning");
  assert.ok(html.includes("nonaktif sampai Anda menambahkan token sendiri"), "the provider is not shared by default");
});

test("dashboard - adding a session account stores the token and cookies", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/providers/accounts/add", {
    method: "POST",
    body: new URLSearchParams({ provider: "deepseek-web", name: "Web", token: "tok_abc", cookies: "a=1" }),
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/deepseek-web?notice=account_added");

  const [connection] = getConnections("deepseek-web");
  assert.strictEqual(connection.auth_type, "session");
  assert.strictEqual(connection.credentials.token, "tok_abc");
  assert.strictEqual(connection.credentials.cookies, "a=1");
  assert.strictEqual(connection.credentials.api_key, undefined, "a session account never stores an api key");
});

test("dashboard - a session account without a token is rejected", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/providers/accounts/add", {
    method: "POST",
    body: new URLSearchParams({ provider: "deepseek-web", name: "Web", token: "   " }),
  });

  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/deepseek-web?notice=session_token_missing");
  assert.deepStrictEqual(getConnections("deepseek-web"), []);
});
