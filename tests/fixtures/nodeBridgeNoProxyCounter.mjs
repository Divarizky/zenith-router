// Node transport (default proxyFetch, no injected fetch) behind the real bridge handler.
import http from "node:http";

const counters = { target: 0, viaProxy: 0, proxy: 0 };
const target = http.createServer((req, res) => {
  counters.target++;
  if (req.headers["x-via-proxy"] === "1") counters.viaProxy++;
  req.resume();
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
let mode = "forward";
const proxy = http.createServer((req, res) => {
  counters.proxy++;
  if (mode === "drop") { req.socket.destroy(); return; }
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
}), { useBunProxy: false });
const snap = () => ({ ...counters, direct: counters.target - counters.viaProxy });
const out = {};

let res = await call({ "x-zenith-require-proxy": "1", "x-zenith-proxy": proxyUrl });
await res.text();
out.success = { status: res.status, ...snap() };

mode = "drop";
const b = snap();
res = await call({ "x-zenith-require-proxy": "1", "x-zenith-proxy": proxyUrl });
await res.text().catch(() => {});
const a = snap();
out.proxyDown = { status: res.status, proxyDelta: a.proxy - b.proxy, targetDelta: a.target - b.target, directDelta: a.direct - b.direct };

console.log(JSON.stringify(out));
proxy.closeAllConnections(); proxy.close(); target.closeAllConnections(); target.close();
process.exit(0);
