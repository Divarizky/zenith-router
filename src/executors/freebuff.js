import { randomInt } from "node:crypto";
import { BaseExecutor, registerExecutor } from "./base.js";
import { proxyFetch } from "./proxy.js";
import { getSetting } from "../services/settings.js";

// Verbatim from upstream FREEBUFF_ROOT_AGENT_ID_BY_MODEL
// (CodebuffAI/freebuff common/src/constants/free-agents.ts).
const STATIC_MODEL_TO_AGENT = {
  "mimo/mimo-v2.5": "base2-free-mimo",
  "mimo/mimo-v2.6-pro": "base2-free-mimo-2-6-pro",
  "minimax/minimax-m3": "base2-free-minimax-m3",
  "openai/gpt-6-luna": "base2-free-luna-6",
  "openai/gpt-6.1-sol": "base2-free-gpt-6-1-sol",
  "upstage/solar-pro4": "base2-free-solar-pro4",
  "upstage/solar-mini4": "base2-free-solar-mini4",
  "deepseek/deepseek-v4-flash": "base2-free-deepseek-flash",
  "deepseek/deepseek-v4-flash-fast": "base2-free-deepseek-flash-fast",
  "z-ai/glm-5.3-flash": "base2-free-glm-5-3-flash",
  "crof/kimi-k3-eco": "base2-free-kimi-k3-eco",
  "anthropic/claude-fable-5.1": "base2-free-fable",
  "meta/muse-spark-1.2-contributor": "base2-free-muse-spark",
};

export function resolveFreebuffAgent(modelId) {
  try {
    const raw = getSetting("freebuff_agent_map", "");
    if (raw) {
      const dynamicMap = JSON.parse(raw);
      if (dynamicMap && dynamicMap[modelId]) return dynamicMap[modelId];
    }
  } catch {}
  return STATIC_MODEL_TO_AGENT[modelId] || "base2-free";
}

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
    const agentId = resolveFreebuffAgent(requestedModel);

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
        const status = sessionRes.status;

        // Detect quota exceeded / rate limit
        if (status === 429 || errText.toLowerCase().includes("quota") || errText.toLowerCase().includes("rate limit") || errText.toLowerCase().includes("exceeded")) {
          const now = new Date();
          const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
          const hoursLeft = Math.ceil((utcMidnight - now) / (1000 * 60 * 60));

          return new Response(
            JSON.stringify({
              error: {
                message: `Sesi harian Freebuff sudah habis untuk model ${requestedModel}. Reset dalam ~${hoursLeft} jam (pukul 00:00 UTC).`,
                type: "quota_exceeded",
                provider: "freebuff",
                model: requestedModel,
                reset_at: utcMidnight.toISOString(),
                hours_until_reset: hoursLeft,
              },
            }),
            { status: 429, headers: { "Content-Type": "application/json" } }
          );
        }

        // Generic error
        return new Response(
          JSON.stringify({
            error: {
              message: `Freebuff session failed (${status}): ${errText}`,
              type: "upstream_error",
            },
          }),
          { status, headers: { "Content-Type": "application/json" } }
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

    // Check for quota exceeded in chat completion response
    if (response.status === 429 || response.status === 402) {
      try {
        const errBody = await response.clone().text();
        if (errBody.toLowerCase().includes("quota") || errBody.toLowerCase().includes("rate limit") || errBody.toLowerCase().includes("exceeded")) {
          const now = new Date();
          const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
          const hoursLeft = Math.ceil((utcMidnight - now) / (1000 * 60 * 60));

          return new Response(
            JSON.stringify({
              error: {
                message: `Sesi harian Freebuff sudah habis untuk model ${requestedModel}. Reset dalam ~${hoursLeft} jam (pukul 00:00 UTC).`,
                type: "quota_exceeded",
                provider: "freebuff",
                model: requestedModel,
                reset_at: utcMidnight.toISOString(),
                hours_until_reset: hoursLeft,
              },
            }),
            { status: 429, headers: { "Content-Type": "application/json" } }
          );
        }
      } catch {}
    }

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
