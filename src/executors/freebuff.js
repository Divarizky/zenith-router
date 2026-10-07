import { randomInt } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";
import { proxyFetch } from "./proxy.js";

const MODEL_TO_AGENT = {
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-pro": "base2-free-deepseek",
  "openai/gpt-5.6-luna": "base2-free-luna",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "mimo/mimo-v2.5": "base2-free-mimo",
  "z-ai/glm-5.2": "base2-free-glm",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "anthropic/claude-fable-5": "base2-free-fable",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};

function generateClientSessionId() {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < 13; i++) {
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

export class FreebuffExecutor extends BaseExecutor {
  constructor(options = {}) {
    super(options);
  }

  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl }) {
    const rawHeaders = headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;
    const authHeader = rawHeaders["Authorization"] || rawHeaders["authorization"] || "";

    if (!authHeader) {
      return new Response(
        JSON.stringify({
          error: { message: "Freebuff Auth Token required", type: "authentication_error" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    let payload = {};
    if (typeof body === "string") {
      try {
        payload = JSON.parse(body);
      } catch {
        payload = {};
      }
    } else if (body && typeof body === "object") {
      payload = body;
    }

    const requestedModel =
      typeof payload.model === "string"
        ? payload.model.replace(/^(fb|freebuff)\//, "")
        : "deepseek/deepseek-v4-flash";
    const agentId = MODEL_TO_AGENT[requestedModel] || "base2-free";

    const fetcher = (targetUrl, init) =>
      proxyUrl ? proxyFetch(targetUrl, init, proxyUrl) : this.fetchFn(targetUrl, init);

    const baseAuthHeaders = {
      Authorization: authHeader,
      "Content-Type": "application/json",
      "User-Agent": "codebuff/0.1.0 (darwin-arm64)",
    };

    let instanceId = "";
    let runId = "";

    // 1. Session acquisition
    try {
      const sessionRes = await fetcher("https://www.codebuff.com/api/v1/freebuff/session", {
        method: "POST",
        headers: {
          ...baseAuthHeaders,
          "x-freebuff-model": requestedModel,
        },
        body: JSON.stringify({}),
        signal,
      });

      if (sessionRes.ok) {
        const data = await sessionRes.json();
        instanceId = data.instanceId || "";
      } else {
        const errText = await sessionRes.text();
        return new Response(
          JSON.stringify({
            error: {
              message: `Freebuff session failed (${sessionRes.status}): ${errText}`,
              type: "upstream_error",
            },
          }),
          { status: sessionRes.status, headers: { "Content-Type": "application/json" } }
        );
      }
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: { message: `Freebuff session network error: ${err.message}`, type: "upstream_error" },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Start agent run
    try {
      const runRes = await fetcher("https://www.codebuff.com/api/v1/agent-runs", {
        method: "POST",
        headers: baseAuthHeaders,
        body: JSON.stringify({ action: "START", agentId }),
        signal,
      });
      if (runRes.ok) {
        const runData = await runRes.json();
        runId = runData.runId || "";
      }
    } catch {}

    // 3. Prepare Chat Payload & Buffy System Prompt
    const incomingMessages = Array.isArray(payload.messages)
      ? payload.messages.filter((m) => m && typeof m === "object")
      : [];
    const firstMessage = incomingMessages[0];
    const hasBuffyPrompt =
      incomingMessages.length > 0 &&
      firstMessage?.role === "system" &&
      typeof firstMessage.content === "string" &&
      firstMessage.content.trim().startsWith("You are Buffy");

    if (!hasBuffyPrompt) {
      incomingMessages.unshift({
        role: "system",
        content: "You are Buffy, the strategic coding assistant.",
      });
    }

    const clientSessionId = generateClientSessionId();
    const existingMetadata =
      payload.codebuff_metadata && typeof payload.codebuff_metadata === "object"
        ? payload.codebuff_metadata
        : {};

    const upstreamBody = {
      ...payload,
      model: requestedModel,
      messages: incomingMessages,
      stream: payload.stream !== false,
      codebuff_metadata: {
        run_id: runId,
        cost_mode: "free",
        client_id: clientSessionId,
        freebuff_instance_id: instanceId,
        ...existingMetadata,
      },
    };

    const completionHeaders = {
      Authorization: authHeader,
      "Content-Type": "application/json",
      "User-Agent": "ai-sdk/openai-compatible/1.0.25/codebuff",
      Accept: "application/json, text/event-stream",
      "x-freebuff-instance-id": instanceId,
      ...(runId ? { "x-codebuff-run-id": runId } : {}),
      "x-codebuff-agent-id": agentId,
    };

    // 4. Chat Completion using BaseExecutor logic
    const completionUrl = "https://www.codebuff.com/api/v1/chat/completions";
    const response = await super.execute({
      url: completionUrl,
      method: "POST",
      headers: completionHeaders,
      body: JSON.stringify(upstreamBody),
      signal,
      timeoutMs,
      proxyUrl,
    });

    // 5. Finish agent run (background cleanup)
    if (runId) {
      fetcher("https://www.codebuff.com/api/v1/agent-runs", {
        method: "POST",
        headers: baseAuthHeaders,
        body: JSON.stringify({
          action: "FINISH",
          runId,
          status: "completed",
          totalSteps: 1,
          directCredits: 0,
          totalCredits: 0,
        }),
      }).catch(() => {});
    }

    return response;
  }
}

export const freebuffExecutorInstance = new FreebuffExecutor();
registerExecutor("freebuff", freebuffExecutorInstance);
