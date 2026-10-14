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

// Dari proxy referensi freebuff (dinarw88/freebuff-proxy): backend Codebuff
// mem-fingerprint traffic CLI resmi dan menolak panggilan langsung dengan
// 403 free_mode_cli_required, jadi tiap request memakai salah satu UA mirip
// CLI resmi secara acak. Versi CLI berubah-ubah sehingga daftar diputar,
// bukan ditiru satu versi.
export const FREEBUFF_USER_AGENTS = [
  "codebuff-cli/1.0.0 (Windows; Node.js v22.3.0)",
  "codebuff-cli/1.1.2 (darwin; Node.js v22.5.1)",
  "freebuff/0.2.4 (linux; Node.js v20.11.1)",
  "ai-sdk/openai-compatible/1.0.25/codebuff",
];

export function randomFreebuffUA() {
  return FREEBUFF_USER_AGENTS[randomInt(FREEBUFF_USER_AGENTS.length)];
}

function getLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Cache pasangan session+run per identitas klien supaya request berurutan
// dalam satu percakapan tidak terlihat seperti session baru setiap kali.
// Pola sama seperti cache sesi OpenCode (TTL 30 menit, 1000 LRU).
const freebuffSessions = new Map();
export const MAX_FREEBUFF_SESSIONS = 1000;
export const FREEBUFF_SESSION_TTL_MS = 1800000; // 30 menit

export function resetFreebuffSessionCache() {
  freebuffSessions.clear();
}

export function getFreebuffSessionCacheSize() {
  return freebuffSessions.size;
}

export function lookupFreebuffSession(key, opts = {}) {
  const trimmed = typeof key === "string" ? key.trim() : "";
  const cacheKey = `freebuff:run:${trimmed || "default"}`;
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? FREEBUFF_SESSION_TTL_MS;
  const existing = freebuffSessions.get(cacheKey);
  if (!existing) return null;
  if (now - existing.lastUsed > ttlMs) {
    freebuffSessions.delete(cacheKey);
    return null;
  }
  existing.lastUsed = now;
  freebuffSessions.delete(cacheKey);
  freebuffSessions.set(cacheKey, existing);
  return existing;
}

export function storeFreebuffSession(key, session, opts = {}) {
  const trimmed = typeof key === "string" ? key.trim() : "";
  const cacheKey = `freebuff:run:${trimmed || "default"}`;
  const now = opts.now ?? Date.now();
  const maxSessions = opts.maxSessions ?? MAX_FREEBUFF_SESSIONS;
  if (freebuffSessions.size >= maxSessions && !freebuffSessions.has(cacheKey)) {
    const oldestKey = freebuffSessions.keys().next().value;
    if (oldestKey !== undefined) freebuffSessions.delete(oldestKey);
  }
  freebuffSessions.set(cacheKey, { ...session, lastUsed: now });
}

export function dropFreebuffSession(key) {
  const trimmed = typeof key === "string" ? key.trim() : "";
  freebuffSessions.delete(`freebuff:run:${trimmed || "default"}`);
}

export class FreebuffExecutor extends BaseExecutor {
  constructor(options = {}) {
    super(options);
  }

  async execute({ url, method = "POST", headers = {}, body, signal, timeoutMs, proxyUrl, sessionKey = null }) {
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

    const timezone = getLocalTimezone();

    // Satu UA per request (bukan per panggilan) supaya session, run, dan
    // chat terlihat datang dari satu klien CLI yang sama.
    const requestUA = randomFreebuffUA();
    const baseAuthHeaders = {
      Authorization: authHeader,
      "Content-Type": "application/json",
      "User-Agent": requestUA,
      "x-freebuff-client": "cli",
      "x-fb-timezone": timezone,
    };

    let instanceId = "";
    let runId = "";
    // Session terikat ke model (header x-freebuff-model + agentId), jadi
    // kunci cache mencakup model yang diminta.
    const sessionCacheKey = `${sessionKey || "default"}::${requestedModel}`;
    const cached = lookupFreebuffSession(sessionCacheKey);
    if (cached) {
      instanceId = cached.instanceId;
      runId = cached.runId;
    }

    if (!cached) {
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
    } // end if (!cached)

    // Simpan pasangan baru ke cache; entri lama yang kedaluwarsa di
    // tengah jalan dibuang supaya request berikutnya membuat yang baru.
    if (!cached && instanceId && runId) {
      storeFreebuffSession(sessionCacheKey, { instanceId, runId });
    }

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

    // Dari proxy referensi: CLI resmi selalu mengirim penanda penolakan
    // pengumpulan data dan sentinel stop cb_easp. Klien yang mengirim stop
    // sendiri tidak diubah.
    const upstreamBody = {
      ...payload,
      model: requestedModel,
      messages: incomingMessages,
      // Lapis kedua di samping forceStream registry: CLI resmi selalu stream.
      stream: true,
      provider: { data_collection: "deny" },
      ...("stop" in payload ? {} : { stop: ["cb_easp"] }),
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
      "User-Agent": requestUA,
      Accept: "application/json, text/event-stream",
      "x-freebuff-instance-id": instanceId,
      "x-freebuff-client": "cli",
      "x-fb-timezone": timezone,
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

    // Session yang dipakai ulang tidak di-FINISH — run tetap hidup untuk
    // request berikutnya, seperti CLI resmi. Hanya run yang baru dibuat
    // (atau yang gagal sehingga tidak di-cache) yang dibersihkan.
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      dropFreebuffSession(sessionCacheKey);
    }

    // 5. Finish agent run (background cleanup)
    if (runId && !cached) {
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
