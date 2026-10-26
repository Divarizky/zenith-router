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
import { randomBytes } from "node:crypto";

const PIPE = "\uFF5C"; // ｜ FULLWIDTH VERTICAL LINE, the DSML delimiter
const DSML = `${PIPE}${PIPE}DSML${PIPE}${PIPE}`;
const MOJIBAKE_PIPE = "\u00EF\u00BD\u0153"; // ｜ encoded as UTF-8, decoded as latin-1
const OPTIONAL_DSML = `(?:${DSML}\\s*)?`;

const MAX_TRAILING_CLOSE = 40;
const FENCE_MAX_LINES = 12;
const FENCE_KEEP_LINES = 10;

// Any call-related tag still present after parsing. Fenced code is masked first,
// so a code sample in a visible answer never counts as markup.
// A `<tool_call>` opening tag counts as markup only when a JSON object follows it.
// Prose that merely names the tag ("the <tool_call> format") is not a call block.
const LEFTOVER_MARKUP = new RegExp(
  `<\\/?\\s*(?:${DSML}|(?:tool_calls|invoke|parameter|function_calls)\\b)|<tool_call\\s*>\\s*\\{|<think\\s*>`,
  "i"
);

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

// The id must differ across turns. A hash of the call's content repeats whenever the
// same command runs again, and a repeated id makes tool results match the wrong call.
function makeCall(name, args) {
  return {
    id: `call_${randomBytes(6).toString("hex")}`,
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

// A Windows drive (`C:\`) or a UNC prefix (`\\server`). Inside such a string every
// backslash is literal: JSON.parse reads `\t`, `\n`, `\b`, `\f`, `\r` in
// `C:\temp\new.txt` as control characters and silently corrupts the path.
const PATH_LIKE = /[A-Za-z]:\\|\\\\[A-Za-z]/;
// A backslash followed by anything other than a valid JSON escape start.
const HAS_INVALID_ESCAPE = /\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/;

/**
 * Doubles each backslash that does not start a valid JSON escape, so Windows paths
 * and regex fragments such as `\d` or `\U` survive intact. In a path-like string
 * only an escaped quote and an escaped backslash keep their meaning.
 */
function escapeBackslashes(json) {
  let out = "";
  let index = 0;
  while (index < json.length) {
    const char = json[index];
    if (char !== '"') {
      out += char;
      index += 1;
      continue;
    }
    let close = index + 1;
    while (close < json.length && json[close] !== '"') close += json[close] === "\\" ? 2 : 1;
    const body = json.slice(index + 1, close);
    const pathLike = PATH_LIKE.test(body);
    let fixed = "";
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] !== "\\") {
        fixed += body[i];
        continue;
      }
      const next = body[i + 1] ?? "";
      const standard = pathLike
        ? next === '"' || next === "\\"
        : /["\\\/bfnrt]/.test(next) || (next === "u" && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 2, i + 6)));
      if (standard) {
        fixed += body[i] + next;
        i += 1;
      } else {
        fixed += "\\\\";
      }
    }
    out += '"' + fixed + '"';
    index = close + 1;
  }
  return out;
}

/** JSON.parse, then one retry with the loose repair. Null when neither works. */
function parseLooseJson(text) {
  // A path can parse cleanly and still be wrong (see PATH_LIKE), and an invalid
  // escape such as \d only fails later, so the backslash pass runs first whenever
  // the text has either.
  if (PATH_LIKE.test(text) || HAS_INVALID_ESCAPE.test(text)) {
    try {
      return JSON.parse(repairLooseStrings(escapeBackslashes(text)));
    } catch {
      // fall through to the standard attempts below
    }
  }
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

/**
 * Maps a name the model wrote onto the request's catalog. Matching is
 * case-insensitive and returns the catalog spelling. With no catalog (auxiliary
 * calls) the name passes through unchanged.
 */
function canonicalToolName(name, toolNames) {
  if (!toolNames || toolNames.size === 0) return name;
  if (toolNames.has(name)) return name;
  const lower = name.toLowerCase();
  for (const known of toolNames) {
    if (known.toLowerCase() === lower) return known;
  }
  return null;
}

/** Dialect 1: `<tool_call>` blocks located by a brace scan. */
function parseTaggedCalls(raw, toolNames) {
  const calls = [];
  const spans = [];
  let malformedTag = false;
  const fences = fencedRanges(raw);
  const openTag = /<tool_call\s*>/gi;

  for (const match of raw.matchAll(openTag)) {
    const fenced = insideRanges(match.index, fences);
    const segmentStart = match.index + match[0].length;
    const found = extractJsonObject(raw.slice(segmentStart));
    if (!found) continue;

    const source = parseLooseJson(found.json);
    if (!isPlainObject(source)) continue;
    const rawName = typeof source.name === "string" ? source.name.trim() : "";
    if (!rawName) continue;
    // Inside a code fence the same markup is usually a quoted example, so it runs
    // only when its name is a tool from the request. Outside a fence an unknown
    // name is a malformed call, not a tool to run.
    const name = canonicalToolName(rawName, toolNames);
    if (!name) {
      // Outside a fence an unknown tool is a broken call: drop its markup and JSON so
      // nothing leaks, and flag the reply. Inside a fence it is quoted text, kept as is.
      if (!fenced) {
        malformedTag = true;
        const stop = segmentStart + found.end;
        const closing = /^\s*<\/tool_call\s*>/i.exec(raw.slice(stop, stop + MAX_TRAILING_CLOSE));
        spans.push([match.index, stop + (closing ? closing[0].length : 0)]);
      }
      continue;
    }

    const args = normalizeArguments(source.arguments, source);
    calls.push(makeCall(name, args));

    let end = segmentStart + found.end;
    const tail = raw.slice(end, end + MAX_TRAILING_CLOSE);
    const closing = /^\s*<\/tool_call\s*>/i.exec(tail);
    if (closing) end += closing[0].length;
    spans.push([match.index, end]);
  }

  if (spans.length === 0) return { text: raw, calls, malformedTag };
  return { text: removeSpans(raw, spans), calls, malformedTag };
}

// DeepSeek V3's own tool-call sentinels. Each is `｜` + `▁`-joined words + `｜`.
const V3_CALLS_BEGIN = "\uFF5C\u2581calls\u2581begin\uFF5C";
const V3_CALLS_END = "\uFF5C\u2581calls\u2581end\uFF5C";
const V3_CALL_BEGIN = "\uFF5C\u2581call\u2581begin\uFF5C";
const V3_CALL_END = "\uFF5C\u2581call\u2581end\uFF5C";
const V3_SEP = "\uFF5C\u2581sep\uFF5C";
const V3_ANY = /\uFF5C\u2581(?:calls|call)\u2581(?:begin|end)\uFF5C|\uFF5C\u2581sep\uFF5C/g;
// One call: `call begin`, `function`, the separator, the tool name, then the arguments
// up to the call end or the next call. The arguments are usually a json fence.
// Each sentinel sits inside angle brackets in the reply: `<｜▁call▁begin｜>`.
const wrap = (sentinel) => `<?${sentinel}>?`;
const V3_CALL = new RegExp(
  `${wrap(V3_CALL_BEGIN)}\\s*function<?${V3_SEP}>?\\s*([^\\s<]+)([\\s\\S]*?)(?=${wrap(V3_CALL_END)}|${wrap(V3_CALLS_END)}|${wrap(V3_CALL_BEGIN)}|$)`,
  "g"
);

/**
 * Dialect 2a: DeepSeek V3's native sentinel block. The tool name follows the
 * separator and the arguments are a JSON object, usually inside a json fence.
 */
function parseNativeV3(raw, toolNames = null) {
  if (!raw.includes(V3_CALL_BEGIN)) return { text: raw, calls: [], malformed: false };
  const calls = [];
  let malformed = false;
  const fences = fencedRanges(raw);
  for (const match of raw.matchAll(V3_CALL)) {
    // A sentinel block quoted in a code fence is an example, not a call.
    if (insideRanges(match.index, fences)) continue;
    const name = canonicalToolName(match[1].trim(), toolNames);
    if (!name) {
      malformed = true;
      continue;
    }
    const body = match[2].replace(/```[^\n]*\n?|```/g, "").trim();
    const parsed = body ? parseLooseJson(body) : {};
    if (!isPlainObject(parsed)) {
      malformed = true;
      continue;
    }
    calls.push(makeCall(name, parsed));
  }
  // Everything from the block's opening sentinel onward is markup or call body.
  const start = raw.search(new RegExp(`<?(?:${V3_CALLS_BEGIN}|${V3_CALL_BEGIN})`));
  if (start >= 0 && insideRanges(start, fences)) return { text: raw, calls, malformed };
  const text = (start >= 0 ? raw.slice(0, start) : raw).replace(V3_ANY, "");
  return { text: text.trim(), calls, malformed };
}

/** Dialect 2: DSML (or plain) invoke/parameter markup. */
export function parseDsml(raw, toolNames = null) {
  const text = normalizeDsml(raw);
  const calls = [];
  const spans = [];
  let malformedInvoke = false;

  const fences = fencedRanges(text);
  for (const match of text.matchAll(INVOKE)) {
    if (insideRanges(match.index, fences)) continue;
    const name = canonicalToolName(match[1].trim(), toolNames);
    if (!name) {
      // An invoke for a tool the request does not have is a broken call. Drop it so
      // its markup stays out of the answer, and flag the reply.
      malformedInvoke = true;
      spans.push([match.index, match.index + match[0].length]);
      continue;
    }
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
    calls.push(makeCall(name, unwrapArguments(args)));
    spans.push([match.index, match.index + match[0].length]);
  }

  const cleaned = removeSpans(text, spans).replace(WRAPPER_TAGS, "").trim();
  return { text: cleaned, calls, malformedInvoke };
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
    const name = canonicalToolName(item.name.trim(), toolNames);
    if (!name) return null;
    const payload = item.arguments ?? item.parameters ?? item.input;
    const args = typeof payload === "string" ? parseLooseJson(payload) : payload;
    if (!isPlainObject(args)) return null;
    calls.push(makeCall(name, args));
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
// History lines the model sometimes echoes back. They start a line and run to its end.
const HISTORY_ECHO = /^(?:Assistant called tool |Tool result \([^)\n]*\): ).*$/gm;

function sweepMarkup(raw) {
  return raw
    .replace(new RegExp(`<\\/?${DSML}[^>]*>`, "g"), "")
    .replace(/<\/?tool_calls\s*>/gi, "")
    .replace(/<\/tool_call\s*>/gi, "")
    .replace(/<tool_call\s*>(?=\s*\{)/gi, "")
    .replace(/```[^\n]*\n\s*```/g, "")
    .trim();
}

/** Removes a closed <think> block only outside code fences, where it is a real leftover. */
function removeClosedThinks(text) {
  const fences = fencedRanges(text);
  return text.replace(/<think>[\s\S]*?<\/think>/gi, (block, offset) => (insideRanges(offset, fences) ? block : ""));
}

/** Drops echoed history lines that sit outside code fences, where they are not quoted examples. */
function removeHistoryEchoes(text) {
  const fences = fencedRanges(text);
  return text.replace(HISTORY_ECHO, (line, offset) => (insideRanges(offset, fences) ? line : ""));
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
  const native = parseNativeV3(normalized, toolNames);
  const tagged = parseTaggedCalls(native.text, toolNames);
  const dsml = parseDsml(tagged.text, toolNames);

  let calls = makeIdsUnique([...native.calls, ...tagged.calls, ...dsml.calls]);
  let body = dsml.text;
  if (calls.length === 0) {
    const bare = parseBareCalls(body, toolNames);
    if (bare) {
      calls = makeIdsUnique(bare);
      body = "";
    }
  }

  const cut = cutAtLeftoverMarkup(removeClosedThinks(body));
  const malformed = (cut.dangling || native.malformed || tagged.malformedTag || dsml.malformedInvoke) && calls.length === 0;
  let text = sweepMarkup(removeHistoryEchoes(cut.text));
  if (calls.length > 0) text = trimCodeBlocks(text);

  return { text, calls, malformed };
}
