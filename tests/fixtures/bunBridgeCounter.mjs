// Runs under Bun only. Real Bun fetch + real handleBridgeRequest against a local
// target, with a local forwarding proxy that tags what it relays. Prints JSON.
import http from "node:http";

if (typeof Bun === "undefined") { console.log(JSON.stringify({ error: "not-bun" })); process.exit(2); }

const counters = { target: 0, targetViaProxy: 0, proxy: 0 };
const target = http.createServer((req, res) => {
  counters.target++;
  if (req.headers["x-via-proxy"] === "1") counters.targetViaProxy++;
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
let proxyMode = "forward";
const proxy = http.createServer((req, res) => {
  counters.proxy++;
  if (proxyMode === "drop") { req.socket.destroy(); return; }
  const up = http.request(req.url, { method: req.method, headers: { ...req.headers, "x-via-proxy": "1" } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on("error", () => res.destroy());
  req.pipe(up);
});
await new Promise((r) => target.listen(0, "127.0.0.1", r));
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
process.env.OPENCODE_UPSTREAM_URL = `http://127.0.0.1:${target.address().port}/v1/chat/completions`;
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const { handleBridgeRequest } = await import("../../src/bridge/opencode-bridge.js");
const call = (headers) => handleBridgeRequest(new Request("http://localhost/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model: "opencode/free", messages: [{ role: "user", content: "hi" }], stream: true }),
}));
const snap = () => ({ ...counters, direct: counters.target - counters.targetViaProxy });
const out = {};

let res = await call({ "x-zenith-require-proxy": "1", "x-zenith-proxy": proxyUrl });
await res.text();
out.success = { status: res.status, ...snap() };

proxyMode = "drop";
const before = snap();
res = await call({ "x-zenith-require-proxy": "1", "x-zenith-proxy": proxyUrl });
await res.text().catch(() => {});
const after = snap();
out.proxyDown = { status: res.status, proxyDelta: after.proxy - before.proxy, targetDelta: after.target - before.target, directDelta: after.direct - before.direct };

const b2 = snap();
res = await call({ "x-zenith-require-proxy": "1" });
await res.text().catch(() => {});
const a2 = snap();
out.missingProxy = { status: res.status, proxyDelta: a2.proxy - b2.proxy, targetDelta: a2.target - b2.target };

console.log(JSON.stringify(out));
proxy.closeAllConnections(); proxy.close(); target.closeAllConnections(); target.close();
process.exit(0);
