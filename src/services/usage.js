import { getDb } from "../db/index.js";

/**
 * Record a token usage event in SQLite
 */
export function recordUsage({
  connectionId = null,
  model,
  inputTokens = 0,
  outputTokens = 0,
  durationMs = 0,
  timestamp = Date.now(),
}) {
  try {
    const db = getDb();
    const inTok = Number(inputTokens) || 0;
    const outTok = Number(outputTokens) || 0;
    const totalTok = inTok + outTok;
    const dur = Number(durationMs) || 0;
    const connId = connectionId ? Number(connectionId) : null;

    const stmt = db.prepare(`
      INSERT INTO usage_history (connection_id, model, input_tokens, output_tokens, total_tokens, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(connId, model || "unknown", inTok, outTok, totalTok, dur, timestamp);

    return {
      id: Number(info.lastInsertRowid),
      connection_id: connId,
      model,
      input_tokens: inTok,
      output_tokens: outTok,
      total_tokens: totalTok,
      duration_ms: dur,
      timestamp,
    };
  } catch (err) {
    console.error("[zenroute] Failed to record usage to SQLite:", err.message);
    return null;
  }
}

/**
 * TransformStream tap that extracts token counts from SSE stream and records usage upon completion
 */
export function createUsageTapStream({ connectionId, model, startTime = Date.now() }) {
  let inputTokens = 0;
  let outputTokens = 0;
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
                // OpenAI usage chunk
                if (parsed.usage) {
                  if (typeof parsed.usage.prompt_tokens === "number") inputTokens = parsed.usage.prompt_tokens;
                  if (typeof parsed.usage.completion_tokens === "number") outputTokens = parsed.usage.completion_tokens;
                }
                // Claude usage chunk (message_start & message_delta)
                if (parsed.message?.usage) {
                  if (typeof parsed.message.usage.input_tokens === "number") {
                    inputTokens = parsed.message.usage.input_tokens;
                  }
                }
                if (parsed.usage?.output_tokens) {
                  outputTokens = parsed.usage.output_tokens;
                }
              } catch {}
            }
          }
        }
      } catch {}
    },

    flush() {
      const durationMs = Date.now() - startTime;
      // Record usage asynchronously to avoid blocking stream closure
      queueMicrotask(() => {
        recordUsage({
          connectionId,
          model,
          inputTokens,
          outputTokens,
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
      ROUND(COALESCE(AVG(duration_ms), 0)) AS avg_duration_ms
    FROM usage_history
    WHERE timestamp >= ?
  `);
  const summary = summaryStmt.get(since) || {
    total_requests: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_tokens: 0,
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

  return {
    summary: {
      total_requests: Number(summary.total_requests),
      total_input_tokens: Number(summary.total_input_tokens),
      total_output_tokens: Number(summary.total_output_tokens),
      total_tokens: Number(summary.total_tokens),
      avg_duration_ms: Number(summary.avg_duration_ms),
    },
    by_model: byModel.map((row) => ({
      model: row.model,
      count: Number(row.count),
      total_tokens: Number(row.total_tokens),
    })),
  };
}

/**
 * HTTP Handler for GET /api/usage
 */
export function handleGetUsage(c) {
  const days = Number(c.req.query("days")) || 30;
  const stats = getUsageStats({ days });
  return c.json(stats);
}
