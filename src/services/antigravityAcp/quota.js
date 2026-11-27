import { workerIdForAccount } from "./accounts.js";
import { createAntigravityAcpClient } from "./client.js";
import { createAntigravityAcpTransport } from "./transport.js";
import { markAntigravityAcpAccountLimited } from "./profiles.js";

// Port of Troupe's antigravity_quota_message: the agent reports an exhausted quota as plain text.
const QUOTA_TITLE = "Usage Limit Reached";
const QUOTA_BODY = "You have reached your current quota for this period.";
export const DEFAULT_LIMIT_MS = 5 * 3_600_000;
const UNIT_MS = { day: 86_400_000, hour: 3_600_000, hr: 3_600_000, minute: 60_000, min: 60_000, second: 1000, sec: 1000 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function sentence(text) {
  const t = text.trim();
  const m = t.match(/\.(\s|$)/);
  return (m ? t.slice(0, m.index) : t).trim();
}

function relativeReset(text) {
  let total = 0;
  let parts = 0;
  for (const part of text.split(",").flatMap((p) => p.split(" and ")).map((p) => p.trim()).filter(Boolean)) {
    const words = part.split(/\s+/);
    if (words.length !== 2 || !/^\d+$/.test(words[0])) return null;
    const unit = UNIT_MS[words[1].toLowerCase().replace(/s$/, "")];
    if (!unit) return null;
    total += Number(words[0]) * unit;
    parts += 1;
  }
  return parts > 0 && Number.isSafeInteger(total) ? total : null;
}

function absoluteReset(text) {
  const m = text.trim().match(/^(\w{3})\w*\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*UTC$/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  const at = Date.UTC(Number(m[3]), month, Number(m[2]), Number(m[4]), Number(m[5]));
  return Number.isFinite(at) ? at : null;
}

/** Parses date string (e.g. 'Dec 04, 2026, 04:12 UTC' or ISO) into ISO string UTC. */
export function parseResetTimestamp(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  // Match format: Dec 04, 2026, 04:12 UTC or Dec 04, 2026 04:12 UTC
  const m = t.match(/^(\w{3})\w*\s+(\d{1,2}),?\s*(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*UTC$/i);
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase());
    if (month >= 0) {
      const ms = Date.UTC(Number(m[3]), month, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  const parsed = Date.parse(t);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Parses markdown reply from ACP `/usage` command.
 * Adopts Troupe antigravity_agent/usage/report.rs pattern.
 *
 * Looks for `### Quota Limits` section and parses nested markdown list:
 * - Top-level: group (`- **Gemini Models**`)
 * - Sub-item: bucket (`  - **Weekly Limit Remaining:** 100% remaining (resets Dec 04, 2026, 04:12 UTC)`)
 */
export function parseAntigravityAcpUsageReply(text) {
  if (typeof text !== "string") return { windows: [], notes: null };

  const headingIdx = text.search(/^###\s+Quota Limits/m);
  if (headingIdx === -1) {
    const trimmed = text.trim();
    return { windows: [], notes: trimmed.length > 0 ? trimmed : null };
  }

  // Extract from `### Quota Limits` until next `### ` heading or end of string
  const afterHeading = text.slice(headingIdx);
  const nextHeadingIdx = afterHeading.slice(1).search(/^###\s+/m);
  const section = nextHeadingIdx === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIdx + 1);

  const lines = section.split(/\r?\n/);
  const windows = [];
  let currentGroup = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Group line: e.g. "- **Gemini Models**" or "- **Claude and GPT models**"
    const groupMatch = line.match(/^-\s+\*\*([^*]+)\*\*/);
    if (groupMatch) {
      currentGroup = groupMatch[1].trim();
      continue;
    }

    // Skip italic notes e.g. "*(Models within this group: ...)*" or "*Models within..."
    if (/^\s*\*\([^*]+\)\*/.test(line) || /^\s*\*Models within/i.test(line)) {
      continue;
    }

    // Bucket sub-item line: e.g. "  - **Weekly Limit Remaining:** 100% remaining (resets Dec 04, 2026, 04:12 UTC)"
    // or "  - **Five Hour Limit Remaining:** 20% used (resets ...)"
    const itemMatch = line.match(/^\s+-\s+\*\*([^*:]+):?\*\*:?\s*(.*)$/);
    if (itemMatch && currentGroup) {
      let rawBucket = itemMatch[1].trim();
      const rawDetail = itemMatch[2].trim();

      // Clean bucket name (e.g. "Weekly Limit Remaining" -> "Weekly Limit")
      const bucket = rawBucket.replace(/\s+Remaining$/i, "").trim();

      // Extract percentage: "100% remaining" or "20% used" or "80%"
      let remainingPercent = null;
      let usedPercent = null;

      const remMatch = rawDetail.match(/(\d+(?:\.\d+)?)\s*%\s*remaining/i);
      const usedMatch = rawDetail.match(/(\d+(?:\.\d+)?)\s*%\s*used/i);
      const simplePctMatch = rawDetail.match(/(\d+(?:\.\d+)?)\s*%/);

      if (remMatch) {
        remainingPercent = parseFloat(remMatch[1]);
        usedPercent = Math.max(0, 100 - remainingPercent);
      } else if (usedMatch) {
        usedPercent = parseFloat(usedMatch[1]);
        remainingPercent = Math.max(0, 100 - usedPercent);
      } else if (simplePctMatch) {
        remainingPercent = parseFloat(simplePctMatch[1]);
        usedPercent = Math.max(0, 100 - remainingPercent);
      }

      // Extract reset date: "(resets Dec 04, 2026, 04:12 UTC)"
      let resetsAt = null;
      const resetMatch = rawDetail.match(/\(resets?\s+([^)]+)\)/i);
      if (resetMatch) {
        resetsAt = parseResetTimestamp(resetMatch[1]);
      }

      if (remainingPercent !== null) {
        windows.push({
          label: `${currentGroup} · ${bucket}`,
          group: currentGroup,
          bucket,
          remainingPercent,
          usedPercent,
          resetsAt,
        });
      }
    }
  }

  return { windows, notes: null };
}

/** Returns `{ resetAt }` (epoch ms or null when not reported) for a quota message, else null. */
export function parseAntigravityQuotaMessage(text, nowMs = Date.now()) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t.startsWith(QUOTA_TITLE) || !t.includes(QUOTA_BODY)) return null;
  let resetAt = null;
  const rel = t.indexOf("reset in ");
  const abs = t.indexOf("reset on ");
  if (rel >= 0) {
    const ms = relativeReset(sentence(t.slice(rel + 9)));
    resetAt = ms === null ? null : nowMs + ms;
  } else if (abs >= 0) {
    resetAt = absoluteReset(sentence(t.slice(abs + 9)));
  }
  return { resetAt };
}

export const DEFAULT_QUOTA_TTL_MS = 300_000;
export const DEFAULT_QUOTA_TIMEOUT_MS = 10_000;

const quotaCache = new Map();
const inFlightProbes = new Map();

function defaultCreateClient(workerId, options) {
  return createAntigravityAcpClient(workerId, createAntigravityAcpTransport, options);
}

function isQuotaLimitError(err) {
  if (!err) return false;
  const code = err.code ?? err.rpcCode;
  const msg = String(err.message || err || "");
  if (parseAntigravityQuotaMessage(msg)) return true;
  if (code === -32000 && /quota|limit|rate/i.test(msg)) return true;
  return false;
}

export function getAntigravityAcpCachedQuota(accountId, { ttlMs = DEFAULT_QUOTA_TTL_MS, nowMs = Date.now() } = {}) {
  const entry = quotaCache.get(accountId);
  if (!entry) return null;
  if (nowMs - entry.checkedAt >= ttlMs) return null;
  return entry;
}

export function clearAntigravityAcpQuotaCacheForTests() {
  quotaCache.clear();
  inFlightProbes.clear();
}

export async function inspectAntigravityAcpAccountQuota(
  accountId,
  {
    createClient = defaultCreateClient,
    timeoutMs = DEFAULT_QUOTA_TIMEOUT_MS,
    ttlMs = DEFAULT_QUOTA_TTL_MS,
    force = false,
  } = {},
) {
  if (!force) {
    const cached = getAntigravityAcpCachedQuota(accountId, { ttlMs });
    if (cached) return cached;
  }

  if (inFlightProbes.has(accountId)) {
    return inFlightProbes.get(accountId);
  }

  const probePromise = (async () => {
    const controller = new AbortController();
    let client = null;
    let timedOut = false;
    let timer = null;

    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("timeout"));
        resolve({ status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() });
      }, timeoutMs);
    });

    const runProbe = async () => {
      const workerId = workerIdForAccount(accountId);
      client = await createClient(workerId, { signal: controller.signal });
      if (timedOut || controller.signal.aborted) {
        return { status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() };
      }

      // Track usage reply text from client updates
      let usageText = "";
      let availableCommands = null;
      if (typeof client.onUpdate === "function") {
        try {
          client.onUpdate((update) => {
            if (!update || typeof update !== "object") return;
            if (update.type === "available_commands_update") {
              if (Array.isArray(update.availableCommands)) {
                availableCommands = update.availableCommands.map((c) => (typeof c === "string" ? c : c?.name || ""));
              }
            } else if (update.type === "agent_message_chunk") {
              const chunkText = typeof update.content?.text === "string"
                ? update.content.text
                : typeof update.text === "string"
                  ? update.text
                  : "";
              if (chunkText) {
                usageText += chunkText;
              }
            }
          });
        } catch {}
      }

      await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      if (timedOut || controller.signal.aborted) {
        return { status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() };
      }

      const session = await client.newSession({ cwd: client.cwd || process.cwd(), mcpServers: [] });
      if (timedOut || controller.signal.aborted) {
        return { status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() };
      }

      const sessionText = typeof session?.message === "string" ? session.message : "";
      const parsedSession = parseAntigravityQuotaMessage(sessionText);
      if (parsedSession) {
        markAntigravityAcpAccountLimited(accountId, parsedSession.resetAt);
        const result = { status: "limited", resetAt: parsedSession.resetAt, checkedAt: Date.now() };
        quotaCache.set(accountId, result);
        return result;
      }

      // If client supports prompt, send /usage to inspect quota
      if (typeof client.prompt === "function" && session?.sessionId) {
        const canSendUsage = !availableCommands || availableCommands.includes("usage");
        if (canSendUsage) {
          try {
            const promptResp = await client.prompt({
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "/usage" }],
            });
            // If prompt response contains message directly
            const respText = typeof promptResp?.message === "string"
              ? promptResp.message
              : typeof promptResp?.text === "string"
                ? promptResp.text
                : "";
            if (respText) {
              usageText += (usageText ? "\n" : "") + respText;
            }
          } catch (err) {
            if (isQuotaLimitError(err)) {
              const parsed = parseAntigravityQuotaMessage(String(err?.message || ""));
              const resetAt = parsed?.resetAt ?? null;
              markAntigravityAcpAccountLimited(accountId, resetAt);
              const result = { status: "limited", resetAt, checkedAt: Date.now() };
              quotaCache.set(accountId, result);
              return result;
            }
          }
        }
      }

      const planType = session?._meta?.antigravity?.tier?.name || null;

      // Parse usage output if present
      if (usageText && usageText.includes("### Quota Limits")) {
        const { windows } = parseAntigravityAcpUsageReply(usageText);
        if (windows.length > 0) {
          const quotas = {};
          let hasLimitedWindow = false;
          let earliestResetAt = null;

          for (const [idx, w] of windows.entries()) {
            const key = `window_${idx}_${w.group}_${w.bucket}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
            quotas[key] = {
              displayName: w.label,
              used: Math.round(w.usedPercent),
              total: 100,
              remaining: Math.round(w.remainingPercent),
              remainingPercentage: w.remainingPercent,
              usedLabel: `${Math.round(w.usedPercent)}% used`,
              resetAt: w.resetsAt || null,
            };

            if (w.remainingPercent <= 0) {
              hasLimitedWindow = true;
            }
            if (w.resetsAt) {
              const resetMs = Date.parse(w.resetsAt);
              if (!Number.isNaN(resetMs)) {
                if (earliestResetAt === null || resetMs < earliestResetAt) {
                  earliestResetAt = resetMs;
                }
              }
            }
          }

          const status = hasLimitedWindow ? "limited" : "ready";
          const resetAt = earliestResetAt;
          if (hasLimitedWindow) {
            markAntigravityAcpAccountLimited(accountId, resetAt);
          }

          const result = {
            status,
            resetAt,
            planType,
            windows,
            quotas,
            checkedAt: Date.now(),
          };
          quotaCache.set(accountId, result);
          return result;
        }
      }

      const result = { status: "ready", resetAt: null, windows: [], checkedAt: Date.now() };
      quotaCache.set(accountId, result);
      return result;
    };

    try {
      return await Promise.race([runProbe(), timeoutPromise]);
    } catch (err) {
      if (timedOut || controller.signal.aborted) {
        return { status: "unknown", reason: "timeout", resetAt: null, checkedAt: Date.now() };
      }
      if (isQuotaLimitError(err)) {
        const parsed = parseAntigravityQuotaMessage(String(err?.message || ""));
        const resetAt = parsed?.resetAt ?? null;
        markAntigravityAcpAccountLimited(accountId, resetAt);
        const result = { status: "limited", resetAt, checkedAt: Date.now() };
        quotaCache.set(accountId, result);
        return result;
      }
      return { status: "unknown", resetAt: null, checkedAt: Date.now() };
    } finally {
      if (timer) clearTimeout(timer);
      if (client && typeof client.close === "function") {
        try { await client.close(); } catch {}
      }
      inFlightProbes.delete(accountId);
    }
  })();

  inFlightProbes.set(accountId, probePromise);
  return probePromise;
}
