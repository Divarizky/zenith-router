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
