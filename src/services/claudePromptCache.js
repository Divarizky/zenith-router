/**
 * Prompt caching for Claude upstream requests.
 *
 * Anthropic reuses a cached prefix only up to a block marked with
 * cache_control. Requests that reach Claude through the OpenAI chat format
 * carry no markers, so every turn is billed as fresh input. This marks the
 * stable prefix (tools, system) and the end of the conversation.
 *
 * If the body already carries a marker, the client placed its own breakpoints
 * (Claude Code does), so the body is returned untouched.
 */

const EPHEMERAL = { type: "ephemeral" };

// Anthropic rejects a request with more than four cache breakpoints.
const MAX_BREAKPOINTS = 4;

// Blocks Anthropic accepts a cache_control marker on. Thinking blocks are
// excluded, and empty text is rejected upstream.
function isCacheableBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (block.type === "text") return typeof block.text === "string" && block.text.trim() !== "";
  return block.type === "tool_result" || block.type === "tool_use" || block.type === "image";
}

function lastIndexWhere(list, predicate) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (predicate(list[i])) return i;
  }
  return -1;
}

function hasMarkerInContent(content) {
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    if (block.cache_control) return true;
    return block.type === "tool_result" && hasMarkerInContent(block.content);
  });
}

function hasAnyCacheControl(body) {
  if (Array.isArray(body.tools) && body.tools.some((t) => t?.cache_control)) return true;
  if (Array.isArray(body.system) && body.system.some((b) => b?.cache_control)) return true;
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((m) => hasMarkerInContent(m?.content));
}

function systemWithBreakpoint(system) {
  if (typeof system === "string") {
    if (system.trim() === "") return null;
    return [{ type: "text", text: system, cache_control: EPHEMERAL }];
  }
  if (!Array.isArray(system)) return null;
  const idx = lastIndexWhere(system, isCacheableBlock);
  if (idx < 0) return null;
  const blocks = system.slice();
  blocks[idx] = { ...blocks[idx], cache_control: EPHEMERAL };
  return blocks;
}

function messagesWithBreakpoint(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") continue;
    let content = null;
    if (typeof msg.content === "string") {
      if (msg.content.trim() !== "") {
        content = [{ type: "text", text: msg.content, cache_control: EPHEMERAL }];
      }
    } else if (Array.isArray(msg.content)) {
      const idx = lastIndexWhere(msg.content, isCacheableBlock);
      if (idx >= 0) {
        content = msg.content.slice();
        content[idx] = { ...content[idx], cache_control: EPHEMERAL };
      }
    }
    if (content) {
      const next = messages.slice();
      next[i] = { ...msg, content };
      return next;
    }
  }
  return null;
}

// Every place a cache_control marker can sit, in request order: tools, system,
// then message content (including tool_result content). Returns the owning
// object and key so a marker can be removed without rebuilding the tree.
function markerSlots(body) {
  const slots = [];
  const scanBlocks = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.cache_control) slots.push({ obj: block });
      if (block.type === "tool_result") scanBlocks(block.content);
    }
  };
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) if (tool?.cache_control) slots.push({ obj: tool });
  }
  if (Array.isArray(body.system)) scanBlocks(body.system);
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg && typeof msg === "object") scanBlocks(msg.content);
    }
  }
  return slots;
}

// Keep the last MAX_BREAKPOINTS markers and drop earlier ones. Mutates the
// body, so callers must pass a copy they own.
function capMarkers(body) {
  const slots = markerSlots(body);
  const excess = slots.length - MAX_BREAKPOINTS;
  for (let i = 0; i < excess; i++) delete slots[i].obj.cache_control;
  return body;
}

/**
 * Add ephemeral breakpoints to a Claude-format request body: the last tool, the
 * last system block, and the last cacheable block of the last message that has
 * one. Markers the client already placed are kept, and the total is capped at
 * MAX_BREAKPOINTS by dropping the earliest ones.
 */
export function applyClaudePromptCache(body) {
  if (!body || typeof body !== "object") return body;
  if (hasAnyCacheControl(body)) return capMarkers(structuredClone(body));

  const out = { ...body };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = body.tools.slice();
    const last = tools.length - 1;
    tools[last] = { ...tools[last], cache_control: EPHEMERAL };
    out.tools = tools;
  }

  const system = systemWithBreakpoint(body.system);
  if (system) out.system = system;

  if (Array.isArray(body.messages)) {
    const messages = messagesWithBreakpoint(body.messages);
    if (messages) out.messages = messages;
  }

  return out;
}
