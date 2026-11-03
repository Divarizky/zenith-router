import { OPENCODE_BASELINE_SYSTEM_PROMPT, DEFAULT_TOOLS, DEFAULT_TOOL_READ } from "./prompt.js";

export const DEFAULT_BRIDGE_PORT = 20129;
export const DEFAULT_BRIDGE_HOST = "127.0.0.1";
export const DEFAULT_BRIDGE_URL = `http://${DEFAULT_BRIDGE_HOST}:${DEFAULT_BRIDGE_PORT}`;
export const OPENCODE_UPSTREAM_URL = "https://opencode.ai/inference/openai/v1/chat/completions";
export const OPENCODE_USER_AGENT = "opencode/latest/2.2.5/cli";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Official OpenCode Session ID generator:
 * "ses_" + 12 hex chars of bitwise NOT timestamp (~(Date.now() * 4096 + 1)) + 14 random base62 chars.
 */
export function generateOpencodeSessionId(now = Date.now()) {
  const r = BigInt(now) * 0x1000n + 1n;
  const a = ~r;
  const hex = Array.from({ length: 6 }, (_, i) =>
    Number((a >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")
  ).join("");
  const randBytes = crypto.getRandomValues(new Uint8Array(14));
  let rand = "";
  for (let i = 0; i < 14; i++) {
    rand += BASE62[randBytes[i] % 62];
  }
  return "ses_" + hex + rand;
}

/**
 * Prepares the OpenAI-compatible chat payload:
 * 1. Combines client system prompt with baseline OpenCode CLI template.
 * 2. Ensures at least 1 tool definition is present.
 */
export function prepareOpenCodePayload(body = {}) {
  const model = body.model || "glm-5.3-flash-free";
  const baseline = OPENCODE_BASELINE_SYSTEM_PROMPT.replace("{{MODEL_NAME}}", model);

  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const systemMessages = rawMessages.filter((m) => m && m.role === "system");
  const otherMessages = rawMessages.filter((m) => m && m.role !== "system");

  let mergedSystemContent = baseline;
  if (systemMessages.length > 0) {
    const clientInstructions = systemMessages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .filter(Boolean)
      .join("\n\n");

    if (clientInstructions && !clientInstructions.includes("You are an AI agent running in OpenCode")) {
      mergedSystemContent = `${baseline}\n\n# User Instructions & Guidelines\n${clientInstructions}`;
    } else if (clientInstructions) {
      mergedSystemContent = clientInstructions;
    }
  }

  const messages = [
    { role: "system", content: mergedSystemContent },
    ...otherMessages,
  ];

  let tools = Array.isArray(body.tools) && body.tools.length > 0 ? [...body.tools] : [...DEFAULT_TOOLS];
  const hasReadTool = tools.some((t) => (t?.function?.name || t?.name) === "read");
  if (!hasReadTool) {
    tools.unshift(DEFAULT_TOOL_READ);
  }

  const payload = {
    ...body,
    model,
    messages,
    tools,
    stream: body.stream !== undefined ? Boolean(body.stream) : true,
  };

  // Remove trace/unneeded fields that could interfere
  delete payload.b3;
  delete payload.traceparent;

  return payload;
}

/**
 * Builds standard upstream headers required by OpenCode Cloudflare / JA4 gates.
 */
export function buildOpenCodeHeaders(incomingHeaders = {}, sessionId = null) {
  const sid = sessionId || generateOpencodeSessionId();
  const auth =
    (typeof incomingHeaders.get === "function" ? incomingHeaders.get("authorization") : incomingHeaders.authorization) ||
    "Bearer public";

  return {
    "Content-Type": "application/json",
    "User-Agent": OPENCODE_USER_AGENT,
    "Authorization": auth,
    "x-opencode-client": "cli",
    "x-opencode-session-id": sid,
    "x-opencode-session": sid,
    "x-session-affinity": sid,
    "x-session-id": sid,
  };
}

/**
 * Request handler for the bridge server.
 */
export async function handleBridgeRequest(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;

  if (req.method === "GET" && (path === "/health" || path === "/")) {
    return new Response(JSON.stringify({ status: "ok", bridge: "opencode-bun", version: "2.2.5" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const isChatCompletions =
    path === "/inference/openai/v1/chat/completions" ||
    path === "/v1/chat/completions" ||
    path === "/chat/completions";

  if (req.method === "POST" && isChatCompletions) {
    let rawBody;
    try {
      rawBody = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const payload = prepareOpenCodePayload(rawBody);
    const headers = buildOpenCodeHeaders(req.headers);
    const upstreamUrl = process.env.OPENCODE_UPSTREAM_URL || OPENCODE_UPSTREAM_URL;

    try {
      const upstreamRes = await fetch(upstreamUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const responseHeaders = new Headers();
      const passHeaders = ["content-type", "retry-after", "x-opencode-log-id", "cache-control"];
      for (const h of passHeaders) {
        const val = upstreamRes.headers.get(h);
        if (val) responseHeaders.set(h, val);
      }
      if (!responseHeaders.has("content-type")) {
        responseHeaders.set("content-type", "text/event-stream; charset=utf-8");
      }

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: { message: `Upstream fetch failed: ${err.message}`, type: "upstream_error" } }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  return new Response(JSON.stringify({ error: { message: `Path ${path} not found`, type: "not_found" } }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

// Start standalone server when executed directly
const isDirectEntry =
  (typeof process !== "undefined" && process.argv && process.argv[1] && process.argv[1].endsWith("opencode-bridge.js")) ||
  (typeof import.meta !== "undefined" && import.meta.main);

if (isDirectEntry) {
  const port = Number(process.env.ZENITH_OPENCODE_BRIDGE_PORT || process.env.PORT || DEFAULT_BRIDGE_PORT);
  const host = process.env.ZENITH_OPENCODE_BRIDGE_HOST || process.env.HOST || DEFAULT_BRIDGE_HOST;

  if (typeof Bun !== "undefined") {
    Bun.serve({
      port,
      hostname: host,
      fetch: handleBridgeRequest,
    });
    console.log(`[opencode-bridge] Bun bridge running on http://${host}:${port}`);
  } else {
    // Node.js fallback server
    import("node:http").then(({ createServer }) => {
      const server = createServer(async (nodeReq, nodeRes) => {
        const url = `http://${nodeReq.headers.host || `${host}:${port}`}${nodeReq.url}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(nodeReq.headers)) {
          if (Array.isArray(v)) {
            for (const item of v) headers.append(k, item);
          } else if (v !== undefined) {
            headers.set(k, v);
          }
        }

        const bodyChunks = [];
        nodeReq.on("data", (chunk) => bodyChunks.push(chunk));
        nodeReq.on("end", async () => {
          const body = ["GET", "HEAD"].includes(nodeReq.method) ? undefined : Buffer.concat(bodyChunks);
          const req = new Request(url, {
            method: nodeReq.method,
            headers,
            body,
          });

          const res = await handleBridgeRequest(req);
          nodeRes.writeHead(res.status, Object.fromEntries(res.headers.entries()));
          if (res.body) {
            const reader = res.body.getReader();
            const pump = async () => {
              const { done, value } = await reader.read();
              if (done) {
                nodeRes.end();
                return;
              }
              nodeRes.write(value);
              await pump();
            };
            pump().catch(() => nodeRes.end());
          } else {
            nodeRes.end();
          }
        });
      });

      server.listen(port, host, () => {
        console.log(`[opencode-bridge] Node bridge running on http://${host}:${port}`);
      });
    });
  }
}
