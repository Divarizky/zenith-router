import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GATEWAY_ORIGIN, isLoopbackOrigin, providerBaseUrl, resolveGatewayOrigin } from "../src/config.ts";

test("tanpa ZENITH_URL, provider mengarah ke gateway lokal port 20120", () => {
  const origin = resolveGatewayOrigin({});
  assert.equal(origin, DEFAULT_GATEWAY_ORIGIN);
  assert.equal(providerBaseUrl(origin), "http://127.0.0.1:20120/v1");
});

test("ZENITH_URL dengan garis miring atau suffix /v1 tidak menghasilkan /v1/v1", () => {
  assert.equal(providerBaseUrl(resolveGatewayOrigin({ ZENITH_URL: "http://10.0.0.5:9000/" })), "http://10.0.0.5:9000/v1");
  assert.equal(providerBaseUrl(resolveGatewayOrigin({ ZENITH_URL: "http://10.0.0.5:9000/v1/" })), "http://10.0.0.5:9000/v1");
  assert.equal(resolveGatewayOrigin({ ZENITH_URL: "  " }), DEFAULT_GATEWAY_ORIGIN, "spasi saja dianggap tidak diset");
});

test("hanya origin loopback yang boleh diminta /api/quota", () => {
  assert.equal(isLoopbackOrigin("http://127.0.0.1:20120"), true);
  assert.equal(isLoopbackOrigin("http://localhost:20120"), true);
  assert.equal(isLoopbackOrigin("http://192.168.1.20:20120"), false, "control-plane tidak boleh dibaca dari LAN");
  assert.equal(isLoopbackOrigin("bukan url"), false);
});
