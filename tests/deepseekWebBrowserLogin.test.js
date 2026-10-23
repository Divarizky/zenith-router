import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { getConnections } from "../src/db/index.js";
import {
  cancelBrowserLogin,
  pollBrowserLogin,
  resetBrowserLoginDriver,
  resetBrowserLogins,
  setBrowserLoginDriver,
  startBrowserLogin,
} from "../src/services/deepseekWeb/browserLogin.js";
import { app } from "../src/index.js";

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function boot(t) {
  initDb(":memory:");
  resetBrowserLogins();
  resetBrowserLoginDriver();
  t.after(() => {
    resetBrowserLogins();
    resetBrowserLoginDriver();
  });
}

test("browser login - a captured session becomes a session account", async (t) => {
  boot(t);
  let seen = null;
  setBrowserLoginDriver(() => ({
    captureSession: async (options) => {
      seen = options;
      return { token: '{"value":"eyJcaptured","__version":"0"}', cookies: "intercom-id=1; ds_session_id=2" };
    },
  }));

  const { flowId } = startBrowserLogin({ providerId: "deepseek-web", name: "Akun hasil login", proxyUrl: "http://127.0.0.1:8080" });
  assert.ok(flowId);

  const status = await waitFor(() => {
    const current = pollBrowserLogin(flowId);
    return current.status === "pending" ? null : current;
  });
  assert.strictEqual(status.status, "done");
  assert.strictEqual(status.account, "Akun hasil login");
  // The wrapper from localStorage is unwrapped before it is stored.
  const [account] = getConnections("deepseek-web");
  assert.strictEqual(account.auth_type, "session");
  assert.strictEqual(account.credentials.token, "eyJcaptured");
  assert.strictEqual(account.credentials.cookies, "intercom-id=1; ds_session_id=2");
  assert.strictEqual(account.proxy_url, "http://127.0.0.1:8080");
  assert.strictEqual(seen.proxyUrl, "http://127.0.0.1:8080");
  assert.ok(seen.signal, "the driver receives an abort signal");
});

test("browser login - the poll exposes what the browser is doing", async (t) => {
  boot(t);
  let release;
  setBrowserLoginDriver(() => ({
    captureSession: ({ onStatus }) =>
      new Promise((resolve) => {
        onStatus?.("waiting");
        release = () => {
          onStatus?.("verifying");
          resolve({ token: "eyJphase.token.value", cookies: "" });
        };
      }),
  }));

  const { flowId } = startBrowserLogin({ providerId: "deepseek-web" });
  assert.strictEqual(pollBrowserLogin(flowId).phase, "waiting");
  release();
  const status = await waitFor(() => (pollBrowserLogin(flowId).status === "done" ? pollBrowserLogin(flowId) : null));
  assert.strictEqual(status.status, "done");
  assert.strictEqual(status.phase, "verifying");
});

test("browser login - a failing driver leaves no account behind", async (t) => {
  boot(t);
  setBrowserLoginDriver(() => ({
    captureSession: async () => {
      throw new Error("Chrome atau Edge tidak ditemukan.");
    },
  }));

  const { flowId } = startBrowserLogin({ providerId: "deepseek-web" });
  const status = await waitFor(() => {
    const current = pollBrowserLogin(flowId);
    return current.status === "pending" ? null : current;
  });
  assert.strictEqual(status.status, "error");
  assert.match(status.error, /Chrome atau Edge tidak ditemukan/);
  assert.strictEqual(getConnections("deepseek-web").length, 0);
});

test("browser login - a missing token is an error, not an empty account", async (t) => {
  boot(t);
  setBrowserLoginDriver(() => ({ captureSession: async () => ({ token: "", cookies: "" }) }));

  const { flowId } = startBrowserLogin({ providerId: "deepseek-web" });
  const status = await waitFor(() => {
    const current = pollBrowserLogin(flowId);
    return current.status === "pending" ? null : current;
  });
  assert.strictEqual(status.status, "error");
  assert.match(status.error, /Token sesi tidak ditemukan/);
  assert.strictEqual(getConnections("deepseek-web").length, 0);
});

test("browser login - only session providers may start a flow", (t) => {
  boot(t);
  assert.throws(() => startBrowserLogin({ providerId: "claude" }), /token sesi browser/);
  assert.throws(() => startBrowserLogin({ providerId: "tidak-ada" }), /tidak dikenal/);
});

test("browser login - a second flow waits for the first to settle", async (t) => {
  boot(t);
  let release;
  setBrowserLoginDriver(() => ({
    captureSession: () => new Promise((resolve) => {
      release = resolve;
    }),
  }));

  const first = startBrowserLogin({ providerId: "deepseek-web", name: "pertama" });
  assert.throws(() => startBrowserLogin({ providerId: "deepseek-web", name: "kedua" }), /masih berjalan/);

  release({ token: "eyJfirst", cookies: "" });
  const status = await waitFor(() => {
    const current = pollBrowserLogin(first.flowId);
    return current.status === "pending" ? null : current;
  });
  assert.strictEqual(status.status, "done");
  // Once the first one settled, a new login is allowed again.
  const second = startBrowserLogin({ providerId: "deepseek-web", name: "kedua" });
  assert.ok(second.flowId);
});

test("browser login - cancelling aborts the driver and forgets the flow", async (t) => {
  boot(t);
  let aborted = false;
  setBrowserLoginDriver(() => ({
    captureSession: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("Login dibatalkan."));
        });
      }),
  }));

  const { flowId } = startBrowserLogin({ providerId: "deepseek-web" });
  assert.strictEqual(cancelBrowserLogin(flowId), true);
  assert.strictEqual(await waitFor(() => aborted), true);
  assert.strictEqual(pollBrowserLogin(flowId).status, "error");
  assert.strictEqual(getConnections("deepseek-web").length, 0);
});

test("browser login - the routes start, poll, and store the account", async (t) => {
  boot(t);
  setBrowserLoginDriver(() => ({ captureSession: async () => ({ token: "eyJroute", cookies: "a=1" }) }));

  const start = await app.request("/dashboard/providers/accounts/login/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "deepseek-web", name: "dari route" }),
  });
  assert.strictEqual(start.status, 200);
  const { flowId } = await start.json();
  assert.ok(flowId);

  let payload = { status: "pending" };
  for (let attempt = 0; attempt < 100 && payload.status === "pending"; attempt += 1) {
    const poll = await app.request("/dashboard/providers/accounts/login/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId }),
    });
    assert.strictEqual(poll.status, 200);
    payload = await poll.json();
    if (payload.status === "pending") await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.strictEqual(payload.status, "done", JSON.stringify(payload));
  assert.strictEqual(getConnections("deepseek-web")[0].name, "dari route");
});

test("browser login - a non-session provider is rejected by the route", async (t) => {
  boot(t);
  const res = await app.request("/dashboard/providers/accounts/login/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "claude" }),
  });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /token sesi browser/);
});

test("browser login - an invalid proxy is rejected before a browser opens", async (t) => {
  boot(t);
  let launched = false;
  setBrowserLoginDriver(() => ({
    captureSession: async () => {
      launched = true;
      return { token: "eyJx", cookies: "" };
    },
  }));
  const res = await app.request("/dashboard/providers/accounts/login/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "deepseek-web", proxy_url: "socks9://nope" }),
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(launched, false);
});

test("browser login - the button lives in the add-account modal, manual fields stay", async (t) => {
  boot(t);
  setBrowserLoginDriver(() => ({ captureSession: async () => ({ token: "eyJsecret-token", cookies: "" }) }));
  const { flowId } = startBrowserLogin({ providerId: "deepseek-web", name: "Akun rahasia" });
  await waitFor(() => pollBrowserLogin(flowId).status === "done");

  const html = await (await app.request("/dashboard/providers/deepseek-web")).text();
  // One-click login is an option inside the add-account dialog, not a separate card.
  const modalAt = html.indexOf('id="add-account-modal"');
  const buttonAt = html.indexOf('id="session-login-start"');
  assert.ok(modalAt > -1, "the add-account modal is rendered");
  assert.ok(buttonAt > modalAt, "the login button sits inside the dialog");
  // Same shape as the OAuth dialogs: primary button, status area, manual entry folded away.
  assert.ok(/id="session-login-start"[^>]*data-provider="deepseek-web"/.test(html));
  assert.ok(html.includes('id="oauth-status" class="oauth-status"'));
  assert.ok(html.includes('<details class="manual">'));
  assert.ok(html.includes("zrSessionLoginCancel()"));
  // Manual paste stays available, folded under the same summary as the OAuth dialogs.
  assert.ok(html.includes("<summary>Tempel token manual</summary>"));
  assert.ok(html.includes('name="token"'));
  // Manual entry ships short steps; the token lives in Local Storage.
  assert.ok(html.includes("Local Storage"));
  assert.ok(html.includes("userToken"));
  assert.ok(html.includes("F12"));
  assert.ok(html.includes('__version'));
  assert.ok(html.includes('name="cookies"'));
  assert.ok(html.includes("Akun rahasia"));
  assert.ok(!html.includes("eyJsecret-token"), "the token must never reach the page");
});

test("browser login - logging in again with the same session adds no twin", async (t) => {
  boot(t);
  const capture = (cookies) => () => ({
    captureSession: async () => ({ token: '{"value":"eyJsame","__version":"0"}', cookies }),
  });
  const settle = async (flowId) =>
    waitFor(() => {
      const current = pollBrowserLogin(flowId);
      return current.status === "pending" ? null : current;
    });

  setBrowserLoginDriver(capture("a=1"));
  const first = await settle(startBrowserLogin({ providerId: "deepseek-web", name: "Pertama" }).flowId);
  assert.strictEqual(first.existing, false);

  setBrowserLoginDriver(capture("a=2"));
  const second = await settle(startBrowserLogin({ providerId: "deepseek-web", name: "Kedua" }).flowId);
  assert.strictEqual(second.status, "done");
  assert.strictEqual(second.existing, true);
  assert.strictEqual(second.account, "Pertama");

  const accounts = getConnections("deepseek-web");
  assert.strictEqual(accounts.length, 1, "one web login stays one account");
  assert.strictEqual(accounts[0].credentials.cookies, "a=2", "the fresher cookies are kept");
});

test("browser login - a pasted token that is already an account is not added twice", async (t) => {
  boot(t);
  const add = (token) =>
    app.request("/dashboard/providers/accounts/add", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ provider: "deepseek-web", name: "Manual", token }).toString(),
    });

  const first = await add("eyJmanual");
  assert.match(first.headers.get("location") || "", /notice=account_added/);
  // Same token in the localStorage wrapper shape.
  const second = await add('{"value":"eyJmanual","__version":"0"}');
  assert.match(second.headers.get("location") || "", /notice=account_exists/);
  assert.strictEqual(getConnections("deepseek-web").length, 1);
});
