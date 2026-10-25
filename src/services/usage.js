import { getDb } from "../db/index.js";
import { captureLine } from "./logger.js";

const positive = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Normalize a usage object from any client protocol (OpenAI chat, Claude,
 * Responses) into one shape. inputTokens always includes cached tokens, as in
 * OpenAI; Claude reports cache reads/writes outside input_tokens, so they are
 * added back here, otherwise the cache-hit ratio would be skewed.
 */
export function normalizeUsage(usage) {
  const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  if (!usage || typeof usage !== "object") return out;

  if (typeof usage.prompt_tokens === "number" || typeof usage.completion_tokens === "number") {
    out.inputTokens = positive(usage.prompt_tokens);
    out.outputTokens = positive(usage.completion_tokens);
    out.cacheReadTokens = positive(usage.prompt_tokens_details?.cached_tokens);
    out.cacheWriteTokens = positive(usage.prompt_tokens_details?.cache_write_tokens);
    out.reasoningTokens = positive(usage.completion_tokens_details?.reasoning_tokens);
    return out;
  }

  if (usage.input_tokens_details || usage.output_tokens_details) {
    // Responses: input_tokens already includes the cached part.
    out.inputTokens = positive(usage.input_tokens);
    out.outputTokens = positive(usage.output_tokens);
    out.cacheReadTokens = positive(usage.input_tokens_details?.cached_tokens);
    out.reasoningTokens = positive(usage.output_tokens_details?.reasoning_tokens);
    return out;
  }

  out.cacheReadTokens = positive(usage.cache_read_input_tokens);
  out.cacheWriteTokens = positive(usage.cache_creation_input_tokens);
  out.inputTokens = positive(usage.input_tokens) + out.cacheReadTokens + out.cacheWriteTokens;
  out.outputTokens = positive(usage.output_tokens);
  return out;
}

/**
 * Record a token usage event in SQLite
 */
export function recordUsage({
  connectionId = null,
  apiKeyId = null,
  provider = null,
  comboName = null,
  fallbackFrom = null,
  model,
  inputTokens = 0,
  outputTokens = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  reasoningTokens = 0,
  durationMs = 0,
  timestamp = Date.now(),
}) {
  try {
    const db = getDb();
    const inTok = Number(inputTokens) || 0;
    const outTok = Number(outputTokens) || 0;
    const totalTok = inTok + outTok;
    const cacheRead = Number(cacheReadTokens) || 0;
    const cacheWrite = Number(cacheWriteTokens) || 0;
    const reasoning = Number(reasoningTokens) || 0;
    const dur = Number(durationMs) || 0;
    const connId = connectionId ? Number(connectionId) : null;
    const keyId = apiKeyId ? Number(apiKeyId) : null;
    const providerId = provider ? String(provider) : null;

    const stmt = db.prepare(`
      INSERT INTO usage_history (connection_id, api_key_id, provider, model, combo_name, fallback_from, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      connId,
      keyId,
      providerId,
      model || "unknown",
      comboName || null,
      fallbackFrom || null,
      inTok,
      outTok,
      totalTok,
      cacheRead,
      cacheWrite,
      reasoning,
      dur,
      timestamp
    );

    let connName = null;
    if (connId) {
      try {
        const cRow = db.prepare("SELECT name FROM connections WHERE id = ?").get(connId);
        connName = cRow?.name || null;
      } catch {}
    }

    captureLine(
      `[USAGE] model=${model || "unknown"} | in=${inTok} out=${outTok} total=${totalTok}${
        cacheRead || cacheWrite ? ` cache_read=${cacheRead} cache_write=${cacheWrite}` : ""
      } | ${dur}ms${
        connName ? ` | account="${connName}"` : connId ? ` | conn#${connId}` : providerId ? ` | provider=${providerId}` : ""
      }`
    );

    return {
      id: Number(info.lastInsertRowid),
      connection_id: connId,
      api_key_id: keyId,
      provider: providerId,
      model,
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: totalTok,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      reasoning_tokens: reasoning,
      duration_ms: dur,
      timestamp,
    };
  } catch (err) {
    console.error("[zenith] Failed to record usage to SQLite:", err.message);
    return null;
  }
}

export function estimateTokens(textOrMessages) {
  if (!textOrMessages) return 0;
  if (typeof textOrMessages === "string") return Math.max(1, Math.ceil(textOrMessages.length / 4));
  if (Array.isArray(textOrMessages)) {
    let chars = 0;
    for (const m of textOrMessages) {
      if (!m) continue;
      if (typeof m.content === "string") chars += m.content.length;
      else if (Array.isArray(m.content)) {
        for (const c of m.content) chars += (c.text?.length || (typeof c === "string" ? c.length : 0));
      }
    }
    return Math.max(1, Math.ceil(chars / 4));
  }
  return 0;
}

/**
 * Rough input-token estimate for a Responses API body (instructions + input
 * items + text summaries). Only used when the upstream omits usage.
 */
export function estimateResponsesInputTokens(body) {
  if (!body || typeof body !== "object") return 0;
  let chars = typeof body.instructions === "string" ? body.instructions.length : 0;
  const items = typeof body.input === "string" ? [body.input] : Array.isArray(body.input) ? body.input : [];
  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      chars += item.length;
      continue;
    }
    if (typeof item.content === "string") chars += item.content.length;
    else if (Array.isArray(item.content)) {
      for (const c of item.content) {
        chars += typeof c === "string" ? c.length : (c.text?.length || c.input_text?.length || 0);
      }
    }
    if (typeof item.summary === "string") chars += item.summary.length;
    else if (Array.isArray(item.summary)) {
      for (const s of item.summary) chars += (s.text?.length || 0);
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * TransformStream tap that extracts token counts from SSE stream and records usage upon completion
 */
export function createUsageTapStream({ connectionId, apiKeyId = null, provider = null, comboName = null, fallbackFrom = null, model, startTime = Date.now(), estimatedInputTokens = 0 }) {
  // Last usage object seen in the client protocol. Claude splits usage over
  // message_start and message_delta, so its fields are merged.
  let lastUsage = null;
  let claudeUsage = null;
  let streamedTextLength = 0;

  const mergeClaudeUsage = (u) => {
    claudeUsage = { ...(claudeUsage || {}) };
    for (const [k, v] of Object.entries(u)) {
      // A later zero must not wipe a count reported earlier.
      if (typeof v === "number" && (v > 0 || !(k in claudeUsage))) claudeUsage[k] = v;
    }
    lastUsage = claudeUsage;
  };
  let buffer = "";
  const textDecoder = new TextDecoder();

  return new TransformStream({
    transform(chunk, controller) {
      // Immediate passthrough to ensure zero latency for the client
      controller.enqueue(chunk);

      try {
        buffer += textDecoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            const dataStr = trimmed.slice(5).trim();
            if (dataStr && dataStr !== "[DONE]") {
              try {
                const parsed = JSON.parse(dataStr);
                if (parsed.usage && typeof parsed.usage === "object") {
                  if (typeof parsed.usage.prompt_tokens === "number" || typeof parsed.usage.completion_tokens === "number") {
                    // OpenAI usage chunk
                    lastUsage = parsed.usage;
                  } else {
                    // Claude message_delta
                    mergeClaudeUsage(parsed.usage);
                  }
                }
                // Claude message_start
                if (parsed.message?.usage && typeof parsed.message.usage === "object") {
                  mergeClaudeUsage(parsed.message.usage);
                }
                // Responses usage (response.completed); response.created carries
                // a response object without usage, so the guard stays on .usage.
                if (parsed.response?.usage && typeof parsed.response.usage === "object") {
                  lastUsage = parsed.response.usage;
                }
                // Heuristic text accumulator in case provider omits usage
                const deltaContent = parsed.choices?.[0]?.delta?.content;
                if (typeof deltaContent === "string") {
                  streamedTextLength += deltaContent.length;
                }
                const claudeDeltaText = parsed.delta?.text;
                if (typeof claudeDeltaText === "string") {
                  streamedTextLength += claudeDeltaText.length;
                }
                if (parsed.type === "response.output_text.delta" && typeof parsed.delta === "string") {
                  streamedTextLength += parsed.delta.length;
                }
              } catch {}
            }
          }
        }
      } catch {}
    },

    flush() {
      const durationMs = Date.now() - startTime;
      const { cacheReadTokens, cacheWriteTokens, reasoningTokens, ...counts } = normalizeUsage(lastUsage);
      let { inputTokens, outputTokens } = counts;
      if (inputTokens === 0 && estimatedInputTokens > 0) {
        inputTokens = estimatedInputTokens;
      }
      if (outputTokens === 0 && streamedTextLength > 0) {
        outputTokens = Math.max(1, Math.ceil(streamedTextLength / 4));
      }

      // Record usage asynchronously to avoid blocking stream closure
      queueMicrotask(() => {
        recordUsage({
          connectionId,
          apiKeyId,
          provider,
          comboName,
          fallbackFrom,
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          reasoningTokens,
          durationMs,
        });
      });
    },
  });
}

/**
 * Get aggregated token usage statistics
 */
export function getUsageStats(options = {}) {
  const db = getDb();
  const days = Number(options.days) || 30;
  const since = Date.now() - days * 86400 * 1000;

  // Aggregate summary
  const summaryStmt = db.prepare(`
    SELECT
      COUNT(*) AS total_requests,
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
      COALESCE(SUM(cache_write_tokens), 0) AS total_cache_write_tokens,
      COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning_tokens,
      ROUND(COALESCE(AVG(duration_ms), 0)) AS avg_duration_ms
    FROM usage_history
    WHERE timestamp >= ?
  `);
  const summary = summaryStmt.get(since) || {
    total_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_reasoning_tokens: 0,
    avg_duration_ms: 0,
  };

  // Breakdown by model
  const modelStmt = db.prepare(`
    SELECT
      model,
      COUNT(*) AS count,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM usage_history
    WHERE timestamp >= ?
    GROUP BY model
    ORDER BY total_tokens DESC
  `);
  const byModel = modelStmt.all(since) || [];

  // Breakdown by api_key
  const keyStmt = db.prepare(`
    SELECT
      u.api_key_id,
      COALESCE(k.name, 'anonymous') AS api_key_name,
      COUNT(*) AS count,
      COALESCE(SUM(u.total_tokens), 0) AS total_tokens
    FROM usage_history u
    LEFT JOIN api_keys k ON u.api_key_id = k.id
    WHERE u.timestamp >= ?
    GROUP BY u.api_key_id
    ORDER BY total_tokens DESC
  `);
  const byApiKey = keyStmt.all(since) || [];

  // Breakdown by provider (via connection -> connections table)
  const providerStmt = db.prepare(`
    SELECT
      COALESCE(c.provider, 'unknown') AS provider,
      COUNT(*) AS count,
      COALESCE(SUM(u.total_tokens), 0) AS total_tokens
    FROM usage_history u
    LEFT JOIN connections c ON u.connection_id = c.id
    WHERE u.timestamp >= ?
    GROUP BY c.provider
    ORDER BY total_tokens DESC
  `);
  const byProvider = providerStmt.all(since) || [];

  // Breakdown by account/connection
  const accountStmt = db.prepare(`
    SELECT
      u.connection_id,
      COALESCE(c.name, c.provider, 'direct') AS connection_name,
      COALESCE(c.provider, u.provider, 'unknown') AS provider,
      COUNT(*) AS count,
      COALESCE(SUM(u.total_tokens), 0) AS total_tokens
    FROM usage_history u
    LEFT JOIN connections c ON u.connection_id = c.id
    WHERE u.timestamp >= ?
    GROUP BY u.connection_id
    ORDER BY total_tokens DESC
  `);
  const byAccount = accountStmt.all(since) || [];

  return {
    summary: {
      total_requests: Number(summary.total_requests),
      total_input_tokens: Number(summary.total_input_tokens),
      total_output_tokens: Number(summary.total_output_tokens),
      total_tokens: Number(summary.total_tokens),
      total_cache_read_tokens: Number(summary.total_cache_read_tokens),
      total_cache_write_tokens: Number(summary.total_cache_write_tokens),
      total_reasoning_tokens: Number(summary.total_reasoning_tokens),
      avg_duration_ms: Number(summary.avg_duration_ms),
    },
    by_model: byModel.map((row) => ({
      model: row.model,
      count: Number(row.count),
      total_tokens: Number(row.total_tokens),
    })),
    by_account: byAccount.map((row) => ({
      connection_id: row.connection_id,
      name: row.connection_name,
      provider: row.provider,
      count: Number(row.count),
      total_tokens: Number(row.total_tokens),
    })),
    by_api_key: byApiKey.map((row) => ({
      api_key_id: row.api_key_id,
      name: row.api_key_name,
      count: Number(row.count),
      total_tokens: Number(row.total_tokens),
    })),
    by_provider: byProvider.map((row) => ({
      provider: row.provider,
      count: Number(row.count),
      total_tokens: Number(row.total_tokens),
    })),
  };
}

/**
 * Latest usage rows for the Recent Requests panel (newest first).
 */
export function getRecentUsage(limit = 10) {
  try {
    const db = getDb();
    return (
      db
        .prepare(
          `SELECT u.model, u.combo_name, u.fallback_from, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.duration_ms, u.timestamp,
                  c.name AS connection_name
           FROM usage_history u
           LEFT JOIN connections c ON u.connection_id = c.id
           ORDER BY u.timestamp DESC, u.id DESC
           LIMIT ?`
        )
        .all(Number(limit) || 10) || []
    );
  } catch {
    return [];
  }
}

/**
 * Provider of the most recent usage record, or "" when none.
 */
export function getLastProvider() {
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT COALESCE(u.provider, c.provider) AS provider
         FROM usage_history u
         LEFT JOIN connections c ON u.connection_id = c.id
         WHERE COALESCE(u.provider, c.provider) IS NOT NULL
         ORDER BY u.timestamp DESC, u.id DESC
         LIMIT 1`
      )
      .get();
    return row?.provider ? String(row.provider).toLowerCase() : "";
  } catch {
    return "";
  }
}

/**
 * HTTP Handler for GET /api/usage. Transport for this operation only; the
 * reusable part is `getUsageStats` above, which takes no Hono context.
 */
export function handleGetUsage(c) {
  const days = Number(c.req.query("days")) || 30;
  const stats = getUsageStats({ days });
  return c.json(stats);
}
