// OpenCode Zen /responses hardening. The upstream rejects
// tool names outside [a-zA-Z0-9_-], function calls without a matching output,
// and out-of-range output budgets. Names are rewritten for the upstream and
// restored on the way back, so the client still sees the tools it declared.

const MAX_TOOL_NAME_LEN = 128;
export const MIN_OUTPUT_TOKENS = 16;
export const MAX_OUTPUT_TOKENS = 65536;

export function sanitizeResponsesToolName(name) {
  if (typeof name !== "string" || !name.trim()) return "tool";
  return name.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME_LEN);
}

/**
 * Builds a per-request renamer. Two different names that sanitize to the same
 * string get distinct suffixes, so the reverse map stays unambiguous.
 */
function createToolRenamer() {
  const toUpstream = new Map();
  const toClient = new Map();
  function rename(original) {
    if (typeof original !== "string") return original;
    if (toUpstream.has(original)) return toUpstream.get(original);
    const base = sanitizeResponsesToolName(original);
    let candidate = base;
    for (let n = 2; toClient.has(candidate) && toClient.get(candidate) !== original; n++) {
      const suffix = `_${n}`;
      candidate = base.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix;
    }
    toUpstream.set(original, candidate);
    toClient.set(candidate, original);
    return candidate;
  }
  return { rename, toClient };
}

/**
 * Drops outputs whose call never happened and gives every unanswered call a
 * synthetic empty output right after it (left behind by /compact or an
 * interrupted tool).
 */
export function pairOrphanToolCalls(input) {
  if (!Array.isArray(input)) return input;
  const callIds = new Set(input.filter((x) => x?.type === "function_call").map((x) => x.call_id));
  const kept = input.filter((x) => x?.type !== "function_call_output" || callIds.has(x.call_id));
  const answered = new Set(kept.filter((x) => x?.type === "function_call_output").map((x) => x.call_id));
  const paired = [];
  for (const item of kept) {
    paired.push(item);
    if (item?.type === "function_call" && !answered.has(item.call_id)) {
      paired.push({ type: "function_call_output", call_id: item.call_id, output: "{}" });
      answered.add(item.call_id);
    }
  }
  return paired;
}

export function clampOutputTokens(value) {
  return Math.min(Math.max(value, MIN_OUTPUT_TOKENS), MAX_OUTPUT_TOKENS);
}

/**
 * Mutates a /responses body in place and returns the upstream→client name map
 * (only names that actually changed).
 */
export function prepareResponsesBody(body) {
  const { rename, toClient } = createToolRenamer();
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object") continue;
      if (typeof tool.name === "string") tool.name = rename(tool.name);
      else if (typeof tool.function?.name === "string") tool.function.name = rename(tool.function.name);
    }
  }
  if (body.tool_choice && typeof body.tool_choice === "object" && typeof body.tool_choice.name === "string") {
    body.tool_choice.name = rename(body.tool_choice.name);
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === "function_call" && typeof item.name === "string") item.name = rename(item.name);
    }
    body.input = pairOrphanToolCalls(body.input);
  }
  if (typeof body.max_output_tokens === "number" && !Number.isNaN(body.max_output_tokens)) {
    body.max_output_tokens = clampOutputTokens(body.max_output_tokens);
  }
  for (const [upstream, client] of toClient) {
    if (upstream === client) toClient.delete(upstream);
  }
  return toClient;
}

function restoreNames(node, nameMap) {
  if (Array.isArray(node)) {
    for (const item of node) restoreNames(item, nameMap);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.name === "string" && nameMap.has(node.name)) {
    node.name = nameMap.get(node.name);
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") restoreNames(value, nameMap);
  }
}

function normalizeReasoning(node) {
  if (Array.isArray(node)) {
    for (const item of node) normalizeReasoning(item);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (node.delta && typeof node.delta === "object") {
    if (node.delta.reasoning && !node.delta.reasoning_content) {
      node.delta.reasoning_content = node.delta.reasoning;
    }
  }
  if (node.message && typeof node.message === "object") {
    if (node.message.reasoning && !node.message.reasoning_content) {
      node.message.reasoning_content = node.message.reasoning;
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") normalizeReasoning(value);
  }
}

function restoreLine(line, nameMap) {
  const match = /^(\s*data:\s?)(.*)$/.exec(line);
  if (!match) return line;
  const payload = match[2].replace(/\r$/, "");
  if (!payload || payload === "[DONE]") return line;
  try {
    const parsed = JSON.parse(payload);
    if (nameMap && nameMap.size > 0) restoreNames(parsed, nameMap);
    normalizeReasoning(parsed);
    return `${match[1]}${JSON.stringify(parsed)}${line.endsWith("\r") ? "\r" : ""}`;
  } catch {
    return line;
  }
}

/**
 * Wraps the upstream response so every function call carries the client's
 * original tool name again. A response with nothing renamed passes through.
 */
export async function restoreResponsesToolNames(res, nameMap) {
  if (!res || !res.body) return res;
  const hasAliases = Boolean(nameMap && nameMap.size > 0);
  const headers = new Headers(res.headers);
  const contentType = headers.get("content-type") || "";

  if (!hasAliases && !contentType.includes("text/event-stream") && !contentType.includes("application/json")) {
    return res;
  }
  headers.delete("content-length");

  if (contentType.includes("application/json")) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      if (hasAliases) restoreNames(parsed, nameMap);
      normalizeReasoning(parsed);
      return new Response(JSON.stringify(parsed), { status: res.status, statusText: res.statusText, headers });
    } catch {
      return new Response(text, { status: res.status, statusText: res.statusText, headers });
    }
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const restored = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) controller.enqueue(encoder.encode(`${restoreLine(line, nameMap)}\n`));
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(restoreLine(buffer, nameMap)));
      },
    })
  );
  return new Response(restored, { status: res.status, statusText: res.statusText, headers });
}
