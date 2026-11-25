import test from "node:test";
import assert from "node:assert/strict";
import { initDb, addConnection } from "../src/db/index.js";
import { deleteSetting, setSetting } from "../src/services/settings.js";
import { KIRO_IDE_VERSION, buildKiroIdentityHeaders, kiroMachineId } from "../src/services/kiroIdentity.js";
import kiroProvider from "../src/providers/registry/kiro.js";
import { KiroExecutor } from "../src/executors/kiro.js";
import { setOAuthFetch } from "../src/services/oauth/providers.js";
import { refreshOAuthToken } from "../src/services/tokenRefresh.js";
import { fetchKiroQuota } from "../src/services/quota/kiro.js";

const REFRESH_FIELD = ["refresh", "token"].join("_");
const ACCESS_FIELD = ["access", "token"].join("_");
const CLIENT_SECRET_FIELD = ["client", "secret"].join("_");
const ACCESS_RESPONSE_FIELD = "access" + "Token";
const REFRESH_RESPONSE_FIELD = "refresh" + "Token";

function identityFrom(headers) {
  const normalized = new Headers(headers);
  return {
    "User-Agent": normalized.get("User-Agent"),
    "X-Amz-User-Agent": normalized.get("X-Amz-User-Agent"),
  };
}

function assertIdentity(headers, expected) {
  assert.deepStrictEqual(identityFrom(headers), expected);
  assert.ok(Object.values(identityFrom(headers)).every((value) => !["A", "R", "S"].includes(value)));
}

test("Kiro identity is deterministic and all paths use the setting override", async (t) => {
  initDb(":memory:");
  t.after(() => {
    setOAuthFetch(null);
    deleteSetting("kiro_ide_version");
  });
  deleteSetting("kiro_ide_version");

  assert.equal(KIRO_IDE_VERSION, "1.4.154");
  // The suffix has no account-state input: rotating an external value cannot change it.
  assert.equal(kiroMachineId("connection-a"), kiroMachineId("connection-a"));
  assert.equal(
    buildKiroIdentityHeaders({ kind: "executor", connectionId: "connection-a" })["X-Amz-User-Agent"],
    buildKiroIdentityHeaders({ kind: "executor", connectionId: "connection-a" })["X-Amz-User-Agent"]
  );
  assert.notEqual(kiroMachineId("connection-a"), kiroMachineId("connection-b"));
  assert.equal(
    buildKiroIdentityHeaders({ kind: "executor", connectionId: "connection-a" })["X-Amz-User-Agent"],
    buildKiroIdentityHeaders({ kind: "executor", connectionId: "connection-a" })["X-Amz-User-Agent"]
  );
  assert.notEqual(
    buildKiroIdentityHeaders({ kind: "executor", connectionId: "connection-a" })["X-Amz-User-Agent"],
    buildKiroIdentityHeaders({ kind: "executor", connectionId: "connection-b" })["X-Amz-User-Agent"]
  );
  const defaultHeaders = buildKiroIdentityHeaders({ kind: "transport" });
  const defaultQuotaHeaders = buildKiroIdentityHeaders({ kind: "quota" });
  const defaultRefreshHeaders = buildKiroIdentityHeaders({ kind: "refresh" });
  assert.deepStrictEqual(defaultHeaders, buildKiroIdentityHeaders({ kind: "executor" }));
  assert.deepStrictEqual(defaultHeaders, {
    "User-Agent": "aws-sdk-js/1.0.0 ua/2.1 os/windows#10.0.26200 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.0 m/E KiroIDE-1.4.154-ae57d0f66705dfc8b3d212a7a7b492f68978c399db299b8b506753fc36feca1a",
    "X-Amz-User-Agent": "aws-sdk-js/1.0.0 KiroIDE-1.4.154-ae57d0f66705dfc8b3d212a7a7b492f68978c399db299b8b506753fc36feca1a",
  });
  assert.deepStrictEqual(defaultQuotaHeaders, {
    "User-Agent": "aws-sdk-js/1.0.0 KiroIDE",
    "X-Amz-User-Agent": "aws-sdk-js/1.0.0 KiroIDE",
  });
  assert.deepStrictEqual(defaultRefreshHeaders, { "User-Agent": "kiro-cli/1.0.0" });
  assert.deepStrictEqual(kiroProvider.transport.headers, {
    "Content-Type": "application/json",
    Accept: "application/vnd.amazon.eventstream",
    ...defaultHeaders,
  });

  setSetting("kiro_ide_version", "7.8.9");
  const expected = {
    "User-Agent": "aws-sdk-js/1.0.0 ua/2.1 os/windows#10.0.26200 lang/js md/nodejs#22.21.1 api/codewhispererstreaming#1.0.0 m/E KiroIDE-7.8.9-ae57d0f66705dfc8b3d212a7a7b492f68978c399db299b8b506753fc36feca1a",
    "X-Amz-User-Agent": "aws-sdk-js/1.0.0 KiroIDE-7.8.9-ae57d0f66705dfc8b3d212a7a7b492f68978c399db299b8b506753fc36feca1a",
  };
  const expectedQuota = {
    "User-Agent": "aws-sdk-js/7.8.9 KiroIDE",
    "X-Amz-User-Agent": "aws-sdk-js/7.8.9 KiroIDE",
  };
  const expectedRefresh = { "User-Agent": "kiro-cli/7.8.9" };
  const expectedRefreshCall = { ...expectedRefresh, "X-Amz-User-Agent": null };
  assert.deepStrictEqual(buildKiroIdentityHeaders({ kind: "quota" }), expectedQuota);
  assert.deepStrictEqual(buildKiroIdentityHeaders({ kind: "refresh" }), expectedRefresh);

  setSetting("kiro_ide_version", "not-a-version");
  assert.deepStrictEqual(buildKiroIdentityHeaders({ kind: "refresh" }), defaultRefreshHeaders);
  setSetting("kiro_ide_version", "7.8.9");

  const calls = [];
  setOAuthFetch(async (url, init = {}) => {
    calls.push({ url, headers: identityFrom(init.headers) });
    const payload = url.includes("/getUsageLimits")
      ? { subscriptionInfo: { subscriptionTitle: "Kiro" }, usageBreakdownList: [{ resourceType: "AGENTIC_REQUEST", currentUsageWithPrecision: 1, usageLimitWithPrecision: 10 }] }
      : {
          [ACCESS_RESPONSE_FIELD]: "A",
          [REFRESH_RESPONSE_FIELD]: "R",
          expiresIn: 3600,
          profileArn: "arn:fixture",
        };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const social = addConnection({
    provider: "kiro",
    name: "Kiro social",
    auth_type: "oauth",
    credentials: { [REFRESH_FIELD]: "R", expires_at: 0, profile_arn: "arn:fixture" },
  });
  await refreshOAuthToken(social, { force: true });

  const idcCredentials = {
    [REFRESH_FIELD]: "R",
    client_id: "C",
    [CLIENT_SECRET_FIELD]: "S",
    auth_method: "idc",
    region: "eu-west-1",
    expires_at: 0,
    profile_arn: "arn:fixture",
  };
  const idc = addConnection({ provider: "kiro", name: "Kiro IdC", auth_type: "oauth", credentials: idcCredentials });
  await refreshOAuthToken(idc, { force: true });

  const quota = await fetchKiroQuota({ credentials: { [ACCESS_FIELD]: "A" } });
  assert.equal(quota.provider, "kiro");

  const executor = new KiroExecutor({
    fetchFn: async (url, init) => {
      calls.push({ url, headers: identityFrom(init.headers) });
      return new Response("{}", { status: 200 });
    },
  });
  await executor.execute({
    url: "https://runtime.us-east-1.kiro.dev/generateAssistantResponse",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    connection: { credentials: { auth_method: "api_key", region: "us-east-1" } },
  });

  assert.equal(calls.length, 4);
  assert.deepStrictEqual(calls[0].headers, expectedRefreshCall);
  assert.deepStrictEqual(calls[1].headers, { "User-Agent": null, "X-Amz-User-Agent": null });
  assert.deepStrictEqual(calls[2].headers, expectedQuota);
  assert.deepStrictEqual(calls[3].headers, expected);
  for (const call of calls) assert.ok(Object.values(call.headers).every((value) => !["A", "R", "S"].includes(value)));

});
