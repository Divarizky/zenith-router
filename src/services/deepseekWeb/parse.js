/**
 * Reply parsing for DeepSeek Web.
 *
 * The consumer chat has no function calling, so tool calls arrive as text in one
 * of several dialects:
 *
 *   1. `<tool_call>{"name": ..., "arguments": {...}}</tool_call>` — what the
 *      preamble asks for. The closing tag is unreliable, and the JSON is often
 *      not valid: quotes inside a command are left unescaped. The object is
 *      found with a balanced-brace scan, and a loose repair is tried before
 *      giving up.
 *   2. DeepSeek's native DSML dialect, `<｜｜DSML｜｜invoke name="...">` with
 *      nested `<｜｜DSML｜｜parameter>` tags. The delimiters are sometimes
 *      damaged in transit (fullwidth pipes turned into U+FFFD runs), hence the
 *      normalisation step before matching. The DSML prefix is optional, so the
 *      same markup without it (`<function_calls><invoke>`) parses too, and a
 *      closing tag is optional when the next tag makes the end obvious.
 *   3. A bare JSON call (optionally fenced) that is the whole reply and names a
 *      tool from the request's catalog.
 *
 * Markup never reaches the visible text. When a call block is present but cannot
 * be parsed, the text from that block onward is dropped and `malformed` is set,
 * so the caller can retry instead of showing a half-written command as an answer.
 */
import { createHash } from "node:crypto";

const PIPE = "\uFF5C"; // ｜ FULLWIDTH VERTICAL LINE, the DSML delimiter
const DSML = `${PIPE}${PIPE}DSML${PIPE}${PIPE}`;
const MOJIBAKE_PIPE = "\u00EF\u00BD\u0153"; // ｜ encoded as UTF-8, decoded as latin-1
const OPTIONAL_DSML = `(?:${DSML}\\s*)?`;

const MAX_TRAILING_CLOSE = 40;
const FENCE_MAX_LINES = 12;
const FENCE_KEEP_LINES = 10;

// Any call-related tag still present after parsing. Fenced code is masked first,
// so a code sample in a visible answer never counts as markup.
const LEFTOVER_MARKUP = new RegExp(`<\\/?\\s*(?:${DSML}|(?:tool_calls?|invoke|parameter|function_calls)\\b)`, "i");

// An invoke must close before its wrapper or the next invoke starts. One that
// runs into the end of the reply was cut off, so it is not a call.
const INVOKE = new RegExp(
  `<${OPTIONAL_DSML}invoke\\s+name=["']([^"']+)["'][^>]*>([\\s\\S]*?)` +
    `(?:<\\/${OPTIONAL_DSML}invoke\\s*>|(?=<\\/?${OPTIONAL_DSML}(?:tool_)?calls\\s*>|<\\/?${OPTIONAL_DSML}function_calls\\s*>|<${OPTIONAL_DSML}invoke\\s))`,
  "g"
);
const PARAMETER = new RegExp(
  `<${OPTIONAL_DSML}parameter\\s+name=["']([^"']+)["'](?:\\s+string=["'](true|false)["'])?[^>]*>([\\s\\S]*?)` +
    `(?:<\\/${OPTIONAL_DSML}parameter\\s*>|(?=<${OPTIONAL_DSML}parameter\\s|<\\/?${OPTIONAL_DSML}invoke\\s*>|$))`,
  "g"
);
const WRAPPER_TAGS = new RegExp(`<\\/?${OPTIONAL_DSML}(?:tool_)?calls\\s*>|<\\/?function_calls\\s*>`, "g");

/** `｜`/mojibake runs next to "DSML" become the canonical double pipe. */
export function normalizeDsml(raw) {
  let text = String(raw ?? "");
  if (text.includes(MOJIBAKE_PIPE)) text = text.split(MOJIBAKE_PIPE).join(PIPE);
  // One to five damaged pipes on either side of "DSML" collapse to two.
  text = text.replace(/[\uFF5C\uFFFD]{1,5}(?=DSML)/g, `${PIPE}${PIPE}`);
  text = text.replace(/(?<=DSML)[\uFF5C\uFFFD]{1,5}/g, `${PIPE}${PIPE}`);
  return text;
}

/**
 * First balanced JSON object in `source`, honouring strings and escapes so
 * nested argument objects are not cut at the first closing brace.
 * Returns `{ json, start, end }` with offsets relative to `source`, or null.
 */
export function extractJsonObject(source) {
  const text = String(source ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { json: text.slice(start, index + 1), start, end: index + 1 };
    }
  }
  return null;
}

function hashOf(value) {
  return createHash("md5").update(value).digest("hex").slice(0, 10);
}

function makeCall(name, args, idSeed) {
  return {
    id: `call_${hashOf(idSeed)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Escapes the quotes a model leaves unescaped inside a string value, and the raw
 * line breaks. A quote closes a string only when the next non-space character
 * could follow a value (`,` `}` `]` `:`). Everything else is treated as content.
 */
function repairLooseStrings(json) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < json.length; index += 1) {
    const char = json[index];
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += char;
    } else if (char === "\\") {
      escaped = true;
      out += char;
    } else if (char === "\n" || char === "\r" || char === "\t") {
      out += { "\n": "\\n", "\r": "\\r", "\t": "\\t" }[char];
    } else if (char === '"') {
      let next = index + 1;
      while (next < json.length && /\s/.test(json[next])) next += 1;
      const closes = next >= json.length || ",}]:".includes(json[next]);
      if (closes) inString = false;
      out += closes ? char : '\\"';
    } else {
      out += char;
    }
  }
  return out;
}

/** JSON.parse, then one retry with the loose repair. Null when neither works. */
function parseLooseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(repairLooseStrings(text));
    } catch {
      return null;
    }
  }
}

function normalizeArguments(raw, source) {
  let args = raw;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = { value: args };
    }
  }
  if (!isPlainObject(args) || Object.keys(args).length === 0) {
    // Flattened dialect: the top-level keys next to "name" ARE the arguments.
    const flat = {};
    for (const [key, value] of Object.entries(source)) {
      if (key === "name" || key === "arguments") continue;
      flat[key] = value;
    }
    args = flat;
  }
  return args;
}

/**
 * DeepSeek sometimes puts the whole argument object into one DSML parameter
 * named `arguments` (seen live: `parameter name="arguments" string="false"`).
 * Passed through as is, the client gets `{"arguments":{"command":...}}` and
 * the tool rejects the call for a missing `command`.
 */
const WRAPPER_KEYS = new Set(["arguments", "parameters", "input"]);

function unwrapArguments(args) {
  const keys = Object.keys(args);
  if (keys.length !== 1 || !WRAPPER_KEYS.has(keys[0])) return args;
  const inner = args[keys[0]];
  return isPlainObject(inner) ? inner : args;
}

function removeSpans(text, spans) {
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    out += text.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return out + text.slice(cursor);
}

/** Ranges of fenced code. Markup inside a fence is quoted text, not a call. */
function fencedRanges(text) {
  return [...text.matchAll(/```[\s\S]*?```/g)].map((m) => [m.index, m.index + m[0].length]);
}

function insideRanges(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** Dialect 1: `<tool_call>` blocks located by a brace scan. */
function parseTaggedCalls(raw) {
  const calls = [];
  const spans = [];
  const fences = fencedRanges(raw);
  const openTag = /<tool_call\s*>/gi;

  for (const match of raw.matchAll(openTag)) {
    if (insideRanges(match.index, fences)) continue;
    const segmentStart = match.index + match[0].length;
    const found = extractJsonObject(raw.slice(segmentStart));
    if (!found) continue;

    const source = parseLooseJson(found.json);
    if (!isPlainObject(source)) continue;
    const name = typeof source.name === "string" ? source.name.trim() : "";
    if (!name) continue;

    const args = normalizeArguments(source.arguments, source);
    calls.push(makeCall(name, args, found.json));

    let end = segmentStart + found.end;
    const tail = raw.slice(end, end + MAX_TRAILING_CLOSE);
    const closing = /^\s*<\/tool_call\s*>/i.exec(tail);
    if (closing) end += closing[0].length;
    spans.push([match.index, end]);
  }

  if (spans.length === 0) return { text: raw, calls };
  return { text: removeSpans(raw, spans), calls };
}

/** Dialect 2: DSML (or plain) invoke/parameter markup. */
export function parseDsml(raw) {
  const text = normalizeDsml(raw);
  const calls = [];
  const spans = [];

  const fences = fencedRanges(text);
  for (const match of text.matchAll(INVOKE)) {
    if (insideRanges(match.index, fences)) continue;
    const name = match[1].trim();
    const args = {};
    for (const param of match[2].matchAll(PARAMETER)) {
      const key = param[1];
      const value = param[3].trim();
      if (param[2] === "true") {
        args[key] = value;
      } else {
        try {
          args[key] = JSON.parse(value);
        } catch {
          args[key] = value;
        }
      }
    }
    if (name) calls.push(makeCall(name, unwrapArguments(args), match[0]));
    spans.push([match.index, match.index + match[0].length]);
  }

  const cleaned = removeSpans(text, spans).replace(WRAPPER_TAGS, "").trim();
  return { text: cleaned, calls };
}

/**
 * Dialect 3: the whole reply is one bare JSON call (optionally inside a json
 * fence) or an array of them, and every name is a tool from the request.
 * Anything looser stays text, so a JSON example in an answer is not run.
 */
function parseBareCalls(raw, toolNames) {
  if (!toolNames || toolNames.size === 0) return null;
  let body = raw.trim();
  const fence = /^```(?:json)?[^\n]*\n([\s\S]*?)\n?```$/i.exec(body);
  if (fence) body = fence[1].trim();
  if (!body.startsWith("{") && !body.startsWith("[")) return null;

  const parsed = parseLooseJson(body);
  if (parsed === null) return null;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) return null;

  const calls = [];
  for (const item of items) {
    if (!isPlainObject(item) || typeof item.name !== "string") return null;
    const name = item.name.trim();
    if (!toolNames.has(name)) return null;
    const payload = item.arguments ?? item.parameters ?? item.input;
    const args = typeof payload === "string" ? parseLooseJson(payload) : payload;
    if (!isPlainObject(args)) return null;
    calls.push(makeCall(name, args, JSON.stringify(item)));
  }
  return calls;
}

/**
 * Caps fenced code blocks in the text that accompanies tool calls. The chat
 * model likes to paste the whole script it just ran into its visible message,
 * which renders as a wall of code; the full text already lives in the call.
 */
export function trimCodeBlocks(raw) {
  const text = String(raw ?? "");
  if (!text.includes("```")) return text;
  return text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (block, lang, code) => {
    const lines = code.replace(/^\n+|\n+$/g, "").split("\n");
    if (lines.length <= FENCE_MAX_LINES) return block;
    const kept = lines.slice(0, FENCE_KEEP_LINES).join("\n");
    return `\`\`\`${lang}\n${kept}\n… (trimmed — the full version ran as a tool call)\n\`\`\``;
  });
}

/** Strips leftover markup that survived both dialects. */
function sweepMarkup(raw) {
  return raw
    .replace(new RegExp(`<\\/?${DSML}[^>]*>`, "g"), "")
    .replace(/<\/?tool_calls?\s*>/gi, "")
    .trim();
}

/**
 * Cuts the text at the first call-related tag outside a code fence. Whatever
 * follows is a call block that could not be parsed; its command text must not
 * be shown as the answer.
 */
function cutAtLeftoverMarkup(text) {
  const masked = text.replace(/```[\s\S]*?```/g, (block) => " ".repeat(block.length));
  const hit = LEFTOVER_MARKUP.exec(masked);
  return hit ? { text: text.slice(0, hit.index), dangling: true } : { text, dangling: false };
}

/** Two identical tool calls in one reply must still get distinct ids. */
function makeIdsUnique(calls) {
  const seen = new Map();
  for (const call of calls) {
    const base = call.id;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    if (count > 1) call.id = `${base}_${count}`;
  }
  return calls;
}

/**
 * Parse one assistant reply into visible text plus OpenAI `tool_calls`.
 *
 * `toolNames` is the set of tool names from the request; it enables the bare
 * JSON dialect. Returns `{ text, calls, malformed }`:
 *   - `text` never contains tool markup.
 *   - `calls` is empty for a normal answer.
 *   - `malformed` is true when a call block was present but no call could be
 *     read from it and no call was returned. The caller should retry the turn.
 */
export function parseReply(raw, { toolNames = null } = {}) {
  const normalized = normalizeDsml(raw);
  const tagged = parseTaggedCalls(normalized);
  const dsml = parseDsml(tagged.text);

  let calls = makeIdsUnique([...tagged.calls, ...dsml.calls]);
  let body = dsml.text;
  if (calls.length === 0) {
    const bare = parseBareCalls(body, toolNames);
    if (bare) {
      calls = makeIdsUnique(bare);
      body = "";
    }
  }

  const cut = cutAtLeftoverMarkup(body);
  const malformed = cut.dangling && calls.length === 0;
  let text = sweepMarkup(cut.text);
  if (calls.length > 0) text = trimCodeBlocks(text);

  return { text, calls, malformed };
}
