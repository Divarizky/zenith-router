/**
 * Claude Messages API requires strict tool pairing: every tool_result must
 * answer a tool_use in the assistant message right before it, and every
 * tool_use must be answered in the user message right after it. Histories that
 * break this (client auto-compact or resume, a turn cut by max_tokens, lossy
 * pivot translation) are rejected upstream with HTTP 400.
 *
 * Repair steps, applied to the Claude-format `messages` array:
 * 0. Null or non-object entries, null content blocks, and user messages left
 *    without content are removed, so pairing is judged on the real turns.
 * 1. Consecutive user messages are merged when any of them carries a
 *    tool_result (Anthropic treats them as one turn anyway), with tool_result
 *    blocks first.
 * 2. A tool_result that does not answer the previous assistant turn, or that
 *    repeats an id, is dropped. A user message left empty is removed.
 * 3. A tool_use with no result in the next user message gets a synthetic
 *    error tool_result.
 *
 * The input is never mutated. The same array is returned when nothing needed
 * repair, so well-formed requests pass through untouched.
 */

const MISSING_RESULT_TEXT = "[tool result unavailable: the result was lost from the conversation history]";

const isToolResult = (b) => b && typeof b === "object" && b.type === "tool_result";

function asBlocks(content) {
  if (Array.isArray(content)) return content;
  if (typeof content === "string" && content !== "") return [{ type: "text", text: content }];
  return [];
}

function hasToolResult(msg) {
  return msg?.role === "user" && Array.isArray(msg.content) && msg.content.some(isToolResult);
}

// Duplicate tool_use ids in one turn are already invalid upstream; keeping one
// id per turn stops the repair from emitting duplicate tool_result blocks.
function toolUseIds(msg) {
  if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return [];
  const ids = msg.content
    .filter((b) => b && b.type === "tool_use" && typeof b.id === "string")
    .map((b) => b.id);
  return [...new Set(ids)];
}

// Step 0: strip nullish values. Left in place, an `undefined` between an
// assistant turn and its answer would make the real tool_result look orphaned.
function stripNullish(messages, stats) {
  let changed = false;
  const out = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      stats.removedEntries++;
      changed = true;
      continue;
    }
    if (!Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const content = msg.content.filter((b) => b != null);
    if (content.length === msg.content.length) {
      out.push(msg);
      continue;
    }
    changed = true;
    stats.removedEntries += msg.content.length - content.length;
    if (content.length === 0) {
      stats.removedEntries++;
      continue;
    }
    out.push({ ...msg, content });
  }
  return changed ? out : messages;
}

export function repairClaudeToolPairing(messages) {
  const stats = { removedEntries: 0, droppedResults: 0, addedResults: 0, mergedMessages: 0, droppedMessages: 0 };
  if (!Array.isArray(messages)) return { messages, ...stats };

  const cleaned = stripNullish(messages, stats);

  // Step 1: merge consecutive user turns that involve tool results.
  const merged = [];
  for (const msg of cleaned) {
    const prev = merged[merged.length - 1];
    if (prev?.role === "user" && msg?.role === "user" && (hasToolResult(prev) || hasToolResult(msg))) {
      const blocks = [...asBlocks(prev.content), ...asBlocks(msg.content)];
      merged[merged.length - 1] = {
        ...prev,
        content: [...blocks.filter(isToolResult), ...blocks.filter((b) => !isToolResult(b))],
      };
      stats.mergedMessages++;
    } else {
      merged.push(msg);
    }
  }

  // Step 2: drop tool_results that answer nothing in the previous assistant turn.
  const kept = [];
  for (const msg of merged) {
    if (!hasToolResult(msg)) {
      kept.push(msg);
      continue;
    }
    const open = new Set(toolUseIds(kept[kept.length - 1]));
    const content = msg.content.filter((b) => {
      if (!isToolResult(b)) return true;
      if (open.has(b.tool_use_id)) {
        open.delete(b.tool_use_id);
        return true;
      }
      stats.droppedResults++;
      return false;
    });
    if (content.length === msg.content.length) {
      kept.push(msg);
    } else if (content.length > 0) {
      kept.push({ ...msg, content });
    } else {
      stats.droppedMessages++;
    }
  }

  // Step 3: answer tool_uses that have no result in the next user message.
  const out = kept.slice();
  for (let i = 0; i < out.length; i++) {
    const ids = toolUseIds(out[i]);
    // A trailing tool_use (no following turn) is left alone: it may be a prefill.
    if (ids.length === 0 || i + 1 >= out.length) continue;
    // Step 2 can drop the user turn that answered this call; insert an empty one
    // so the missing results still have a place to go.
    if (out[i + 1]?.role !== "user") out.splice(i + 1, 0, { role: "user", content: [] });
    const next = out[i + 1];

    const blocks = asBlocks(next.content);
    const answered = new Set(blocks.filter(isToolResult).map((b) => b.tool_use_id));
    const missing = ids.filter((id) => !answered.has(id));
    if (missing.length === 0) continue;

    const byId = new Map(blocks.filter(isToolResult).map((b) => [b.tool_use_id, b]));
    for (const id of missing) {
      byId.set(id, { type: "tool_result", tool_use_id: id, is_error: true, content: MISSING_RESULT_TEXT });
    }
    // tool_result blocks lead the user content, in the order of their tool_use.
    out[i + 1] = {
      ...next,
      content: [...ids.map((id) => byId.get(id)), ...blocks.filter((b) => !isToolResult(b))],
    };
    stats.addedResults += missing.length;
  }

  const hasRepairs =
    stats.removedEntries > 0 ||
    stats.mergedMessages > 0 ||
    stats.droppedResults > 0 ||
    stats.droppedMessages > 0 ||
    stats.addedResults > 0;
  return { messages: hasRepairs ? out : messages, ...stats };
}
