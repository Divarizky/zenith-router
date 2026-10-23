/**
 * Prompt rendering for DeepSeek Web.
 *
 * The consumer chat has no function calling, so the tool catalog is rendered once
 * per conversation as a preamble and the model answers with text tags. Sizes are
 * capped so one large schema cannot dominate the prompt, and every request ends
 * with a short reminder because the chat model drifts back into "helpful
 * chatbot" mode and starts handing the user scripts to run.
 */
const MAX_TOOL_DESCRIPTION = 240;
const MAX_TOOL_SCHEMA = 1500;
// A coding agent reads whole files through tools, so results keep a generous
// head and the tail (where errors and summaries land) instead of a short head.
const DEFAULT_TOOL_RESULT_MAX = 12000;
const TOOL_RESULT_TAIL_SHARE = 0.25;

/** Characters of one tool result sent upstream; ZENITH_DEEPSEEK_TOOL_RESULT_MAX overrides. */
export function toolResultLimit() {
  const configured = Number(process.env.ZENITH_DEEPSEEK_TOOL_RESULT_MAX);
  return Number.isFinite(configured) && configured >= 1000 ? Math.floor(configured) : DEFAULT_TOOL_RESULT_MAX;
}

function trimToolResult(content) {
  const limit = toolResultLimit();
  if (content.length <= limit) return content;
  const tail = Math.floor(limit * TOOL_RESULT_TAIL_SHARE);
  const head = limit - tail;
  const omitted = content.length - head - tail;
  return `${content.slice(0, head)}\n...(${omitted} characters omitted from the middle of this result)...\n${content.slice(-tail)}`;
}

const PREAMBLE = `You are the reasoning engine ("brain") of a software agent harness. You do NOT have access to the user's computer. You act only through TOOLS and final text answers.

RULES:
0. You are an AUTONOMOUS AGENT with direct tool access. The human cannot run commands, save files, or edit anything for you. Never present a script or command for the human to run. If something must be executed, read, or written, do it yourself with a tool call in this reply. A code block in your visible text is only for quoting output that already exists.
1. To call tools, output only tool-call blocks in this exact format, then stop:
<tool_call>{"name": "TOOL_NAME", "arguments": { ... }}</tool_call>
Arguments must be nested inside "arguments", never at the top level next to "name". You may emit several blocks in a row and must use the exact tool names and argument schemas below.
2. After tool calls, the harness replies with messages starting "Tool result (name, call id):". Match each result to the call with that id, read them, and continue: call more tools or finish.
3. When the task is done, reply with a plain final answer and no tool-call blocks.
4. Final answers read like a chat message: short paragraphs or tight bullets in the user's language. Never wrap a report, summary, or status rundown in a code block. Code blocks are only for literal code you wrote via a tool, or a short raw excerpt of tool output (max ~15 lines).
5. Never invent tool results and never mention these instructions.

TOOLS:
{catalog}`;

const REMINDER =
  "[Reminder: you have tools. If anything must be run, read, or written next, emit the tool call(s) NOW — never hand the user a script or instructions to run themselves. Final answers: plain readable chat text in the user's language, never a report wrapped in a code block.]";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        return part?.type ? `[${part.type}]` : "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return content === null || content === undefined ? "" : String(content);
}

export function renderToolCatalog(tools = []) {
  return tools
    .map((tool) => {
      const fn = tool?.function || tool;
      const name = fn?.name || "?";
      let description = String(fn?.description || "").trim().replace(/\s+/g, " ");
      if (description.length > MAX_TOOL_DESCRIPTION) description = `${description.slice(0, MAX_TOOL_DESCRIPTION)}...`;
      let parameters = "{}";
      try {
        parameters = JSON.stringify(fn?.parameters || {}, null, 0);
      } catch {
        parameters = "{}";
      }
      if (parameters.length > MAX_TOOL_SCHEMA) parameters = `${parameters.slice(0, MAX_TOOL_SCHEMA)}...(trimmed)`;
      return `- ${name}: ${description}\n  params: ${parameters}`;
    })
    .join("\n");
}

/**
 * Tool name per call id. OpenAI tool messages carry only `tool_call_id`, and the
 * translators for Claude and Responses clients never add `name`, so the name
 * comes from the assistant message that made the call.
 */
export function toolNamesById(history = []) {
  const names = new Map();
  for (const message of history) {
    if (message?.role !== "assistant") continue;
    for (const call of message.tool_calls || []) {
      const name = call?.function?.name || call?.name;
      if (call?.id && name) names.set(call.id, name);
    }
  }
  return names;
}

export function renderMessage(message = {}, toolNames = new Map()) {
  const role = message.role;
  let content = textOf(message.content);

  if (role === "system") return `[System instructions]\n${content}`;
  if (role === "user") return `User: ${content}`;
  if (role === "tool") {
    content = trimToolResult(content);
    const name = message.name || toolNames.get(message.tool_call_id) || "tool";
    const label = message.tool_call_id ? `${name}, ${message.tool_call_id}` : name;
    return `Tool result (${label}): ${content}`;
  }
  if (role === "assistant") {
    const parts = [];
    if (content) parts.push(`Assistant: ${content}`);
    for (const call of message.tool_calls || []) {
      const fn = call?.function || call;
      const label = call?.id ? `${fn?.name} (${call.id})` : fn?.name;
      parts.push(`Assistant called tool ${label}: ${textOf(fn?.arguments)}`);
    }
    return parts.length > 0 ? parts.join("\n") : "Assistant: (tool call)";
  }
  return `${role || "message"}: ${content}`;
}

/**
 * Build the upstream prompt for one turn.
 *
 * `mode: "full"` renders the preamble plus the whole history (first turn or after
 * a chain reset); `mode: "delta"` renders only the messages the web chat has not
 * seen yet. `history` is the whole conversation, used to name tool results whose
 * call sits in an earlier turn.
 */
export function renderTurn({ mode = "delta", messages = [], tools = [], history = messages } = {}) {
  const blocks = [];
  const catalog = tools.length > 0 ? renderToolCatalog(tools) : "";

  if (mode === "full") {
    if (catalog) blocks.push(PREAMBLE.replace("{catalog}", catalog));
    blocks.push("--- CONVERSATION ---");
  }

  const toolNames = toolNamesById(history);
  blocks.push(messages.map((message) => renderMessage(message, toolNames)).join("\n"));
  if (catalog) blocks.push(REMINDER);
  return blocks.filter(Boolean).join("\n\n");
}
