import test from "node:test";
import assert from "node:assert";
import { extractJsonObject, normalizeDsml, parseDsml, parseReply, trimCodeBlocks } from "../src/services/deepseekWeb/parse.js";

const PIPE = "\uFF5C";
const DSML = `${PIPE}${PIPE}DSML${PIPE}${PIPE}`;

test("parse - a plain answer stays untouched", () => {
  const raw = "Sudah selesai. Semua tes lulus.";
  assert.deepStrictEqual(parseReply(raw), { text: raw, calls: [], malformed: false });
  assert.deepStrictEqual(parseReply(""), { text: "", calls: [], malformed: false });
  assert.deepStrictEqual(parseReply(null), { text: "", calls: [], malformed: false });
});

test("parse - brace scan ignores nested objects and braces inside strings", () => {
  const raw = 'x <tool_call>{"name":"bash","arguments":{"command":"echo }","nested":{"a":[1,2]}}}</tool_call> y';
  const { json, start, end } = extractJsonObject(raw.slice(raw.indexOf("{")));
  assert.strictEqual(JSON.parse(json).arguments.nested.a[1], 2);
  assert.strictEqual(raw.slice(start + raw.indexOf("{"), end + raw.indexOf("{")), json);
});

test("parse - one tagged call keeps the surrounding text out of content", () => {
  const raw = 'Aku jalankan.\n<tool_call>{"name": "bash", "arguments": {"command": "ls -la"}}</tool_call>\nSelesai.';
  const { text, calls } = parseReply(raw);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].type, "function");
  assert.match(calls[0].id, /^call_[0-9a-f]{12}$/);
  assert.strictEqual(calls[0].function.name, "bash");
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: "ls -la" });
  assert.strictEqual(text, "Aku jalankan.\n\nSelesai.");
});

test("parse - several calls in a row get distinct ids and stay ordered", () => {
  const raw = [
    "<tool_call>{\"name\":\"read\",\"arguments\":{\"path\":\"/a\"}}</tool_call>",
    "<tool_call>{\"name\":\"bash\",\"arguments\":{\"command\":\"cat /a\"}}</tool_call>",
  ].join("\n");
  const { text, calls } = parseReply(raw);

  assert.strictEqual(text, "");
  assert.deepStrictEqual(calls.map((call) => call.function.name), ["read", "bash"]);
  assert.notStrictEqual(calls[0].id, calls[1].id);
});

test("parse - identical calls still receive unique ids", () => {
  const one = '<tool_call>{"name":"bash","arguments":{"command":"pwd"}}</tool_call>';
  const { calls } = parseReply(`${one}\n${one}`);

  assert.strictEqual(calls.length, 2);
  assert.notStrictEqual(calls[1].id, calls[0].id);
  assert.strictEqual(calls[0].function.arguments, calls[1].function.arguments);
});

test("parse - the same call in two turns gets different ids", () => {
  // A content hash made these equal, so the second result matched the first call.
  const one = '<tool_call>{"name":"bash","arguments":{"command":"git status"}}</tool_call>';
  const first = parseReply(one).calls[0].id;
  const second = parseReply(one).calls[0].id;
  assert.notStrictEqual(first, second);
});

test("parse - arguments may be a JSON string or flattened next to name", () => {
  const asString = parseReply('<tool_call>{"name":"bash","arguments":"{\\"command\\":\\"pwd\\"}"}</tool_call>');
  assert.deepStrictEqual(JSON.parse(asString.calls[0].function.arguments), { command: "pwd" });

  const flattened = parseReply('<tool_call>{"name":"bash","command":"pwd","timeout":5}</tool_call>');
  assert.deepStrictEqual(JSON.parse(flattened.calls[0].function.arguments), { command: "pwd", timeout: 5 });

  const bareString = parseReply('<tool_call>{"name":"bash","arguments":"pwd"}</tool_call>');
  assert.deepStrictEqual(JSON.parse(bareString.calls[0].function.arguments), { value: "pwd" });
});

test("parse - a reply without a usable name or JSON is not a tool call", () => {
  // Call block present but unreadable: nothing leaks, and the turn is flagged.
  const noName = parseReply('<tool_call>{"arguments":{"command":"pwd"}}</tool_call>');
  assert.deepStrictEqual(noName.calls, []);
  assert.strictEqual(noName.text, "");
  assert.strictEqual(noName.malformed, true);

  const broken = parseReply('text <tool_call>{"name": broken}</tool_call> tail');
  assert.deepStrictEqual(broken.calls, []);
  assert.strictEqual(broken.text, "text");
  assert.strictEqual(broken.malformed, true);
});

test("parse - the DSML dialect becomes native calls and leaves no markup", () => {
  const raw = [
    "Siap, aku cek dulu.",
    `<${DSML}tool_calls>`,
    `<${DSML}invoke name="bash">`,
    `<${DSML}parameter name="command" string="true">echo hi</${DSML}parameter>`,
    `<${DSML}parameter name="timeout">5</${DSML}parameter>`,
    `<${DSML}parameter name="login" string="false">false</${DSML}parameter>`,
    `</${DSML}invoke>`,
    `</${DSML}tool_calls>`,
  ].join("\n");

  const { text, calls } = parseReply(raw);

  assert.strictEqual(text, "Siap, aku cek dulu.");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].function.name, "bash");
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), {
    command: "echo hi",
    timeout: 5,
    login: false,
  });
});

test("parse - DSML without the calls wrapper and with several invokes", () => {
  const raw = [
    `<${DSML}invoke name="read"><${DSML}parameter name="path">/tmp/a.txt</${DSML}parameter></${DSML}invoke>`,
    `<${DSML}invoke name="bash"><${DSML}parameter name="command" string="true">ls</${DSML}parameter></${DSML}invoke>`,
  ].join("\n");

  const { text, calls } = parseReply(raw);

  assert.strictEqual(text, "");
  assert.deepStrictEqual(calls.map((call) => call.function.name), ["read", "bash"]);
});

test("parse - damaged DSML delimiters are repaired before matching", () => {
  const replacement = "\uFFFD\uFFFD";
  const damaged = `<${replacement}DSML${replacement}invoke name="bash"><${replacement}DSML${replacement}parameter name="command" string="true">pwd</${replacement}DSML${replacement}parameter></${replacement}DSML${replacement}invoke>`;
  const mojibake = "\u00EF\u00BD\u0153\u00EF\u00BD\u0153";

  assert.strictEqual(normalizeDsml(damaged), normalizeDsml(damaged.split(replacement).join(PIPE)));
  const repaired = parseDsml(damaged);
  assert.strictEqual(repaired.calls.length, 1);
  assert.deepStrictEqual(JSON.parse(repaired.calls[0].function.arguments), { command: "pwd" });

  const latin = parseDsml(`<${mojibake}DSML${mojibake}invoke name="bash"><${mojibake}DSML${mojibake}parameter name="command" string="true">pwd</${mojibake}DSML${mojibake}parameter></${mojibake}DSML${mojibake}invoke>`);
  assert.strictEqual(latin.calls.length, 1);
});

test("parse - a fused closing tag from the other dialect is consumed", () => {
  const raw = `<tool_call>{"name":"bash","arguments":{"command":"ls"}}</${DSML}invoke>\n</tool_call>`;
  const { text, calls } = parseReply(raw);

  assert.strictEqual(text, "");
  assert.strictEqual(calls.length, 1);
});

test("parse - leftover markup never reaches the content", () => {
  const raw = `jawaban\n<${DSML}tool_calls>\n</tool_call>\n</${DSML}calls>`;
  const { text, calls } = parseReply(raw);

  assert.strictEqual(text, "jawaban");
  assert.deepStrictEqual(calls, []);
});

test("parse - unescaped quotes inside a tool_call argument are repaired", () => {
  const raw = '<tool_call>{"name": "Bash", "arguments": {"command": "git commit -m "fix parser""}}</tool_call>';
  const { text, calls, malformed } = parseReply(raw);

  assert.strictEqual(malformed, false);
  assert.strictEqual(text, "");
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: 'git commit -m "fix parser"' });
});

test("parse - an escaped newline in a tool_call string stays a newline in the value", () => {
  const raw = '<tool_call>{"name": "Bash", "arguments": {"command": "echo a\\nb"}}</tool_call>';
  const { calls } = parseReply(raw);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: "echo a\nb" });
});

test("parse - a raw line break inside a tool_call string is kept as content", () => {
  const raw = '<tool_call>{"name": "Bash", "arguments": {"command": "echo a\nb"}}</tool_call>';
  const { calls } = parseReply(raw);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: "echo a\nb" });
});

test("parse - a truncated DSML call drops the command text and is flagged", () => {
  const raw = `Saya commit sekarang.\n<${DSML}calls>\n<${DSML}invoke name="Bash">\n<${DSML}parameter name="command" string="true">git commit -m "x"`;
  const { text, calls, malformed } = parseReply(raw);

  assert.deepStrictEqual(calls, []);
  assert.strictEqual(text, "Saya commit sekarang.");
  assert.strictEqual(malformed, true);
});

test("parse - a parameter without its closing tag keeps its value", () => {
  const raw = `<${DSML}calls><${DSML}invoke name="Bash"><${DSML}parameter name="command" string="true">git add -A</${DSML}invoke></${DSML}calls>`;
  const { calls, malformed } = parseReply(raw);

  assert.strictEqual(malformed, false);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: "git add -A" });
});

test("parse - the invoke dialect without the DSML prefix parses", () => {
  const raw = '<function_calls>\n<invoke name="Bash">\n<parameter name="command">git status</parameter>\n</invoke>\n</function_calls>';
  const { text, calls, malformed } = parseReply(raw);

  assert.strictEqual(malformed, false);
  assert.strictEqual(text, "");
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: "git status" });
});

test("parse - a bare JSON call is read only when the name is in the catalog", () => {
  const toolNames = new Set(["Bash"]);
  const call = parseReply('```json\n{"name": "Bash", "arguments": {"command": "git push"}}\n```', { toolNames });
  assert.strictEqual(call.calls.length, 1);
  assert.deepStrictEqual(JSON.parse(call.calls[0].function.arguments), { command: "git push" });

  const example = parseReply('{"name": "Deploy", "arguments": {"env": "prod"}}', { toolNames });
  assert.deepStrictEqual(example.calls, []);
  assert.strictEqual(example.malformed, false);
  assert.strictEqual(example.text, '{"name": "Deploy", "arguments": {"env": "prod"}}');
});

test("parse - markup inside a code fence in an answer is not a call", () => {
  const raw = 'Contoh format XML:\n```xml\n<invoke name="x"><parameter name="y">z</parameter></invoke>\n```';
  const { text, calls, malformed } = parseReply(raw);

  assert.deepStrictEqual(calls, []);
  assert.strictEqual(malformed, false);
  assert.strictEqual(text, raw);
});

test("parse - code fences are capped only when a tool call accompanies them", () => {
  const code = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
  const fenced = `Ini hasilnya:\n\`\`\`bash\n${code}\n\`\`\``;

  const trimmed = trimCodeBlocks(fenced);
  assert.match(trimmed, /line 9/);
  assert.doesNotMatch(trimmed, /line 10/);
  assert.match(trimmed, /… \(trimmed — the full version ran as a tool call\)/);

  assert.strictEqual(trimCodeBlocks("```bash\none\ntwo\n```"), "```bash\none\ntwo\n```");
  assert.strictEqual(parseReply(fenced).text, fenced, "no calls, no trimming");
});

test("parse - DSML accepts single-quoted names", () => {
  const raw = `<${DSML}invoke name='read'><${DSML}parameter name='path' string='true'>/tmp/a</${DSML}parameter></${DSML}invoke>`;
  const { text, calls } = parseReply(raw);

  assert.strictEqual(text, "");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].function.name, "read");
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { path: "/tmp/a" });
});

test("parse - tags tolerate whitespace and case", () => {
  const raw = '<TOOL_CALL >{"name":"bash","arguments":{"command":"pwd"}}</TOOL_CALL >';
  const { text, calls } = parseReply(raw);

  assert.strictEqual(text, "");
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: "pwd" });
});

test("parse - a DSML parameter named arguments is unwrapped into the call arguments", () => {
  const D = "\uFF5C\uFF5CDSML\uFF5C\uFF5C";
  // Captured live: the whole argument object arrives as one non-string parameter.
  const raw =
    `<${D} calls>\n<${D} invoke name="Bash">\n` +
    `<${D} parameter name="arguments" string="false">{"command": "git status", "description": "status"}</${D} parameter>\n` +
    `</${D} invoke>\n</${D} calls>`;
  const { calls } = parseReply(raw);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: "git status", description: "status" });
});

test("parse - a Windows path with an invalid escape or a valid one in its name keeps every character", () => {
  // Written as raw text so the test string itself carries single backslashes.
  const raw = String.raw`<tool_call>{"name":"Read","arguments":{"file_path":"C:\Users\diva\f.txt"}}</tool_call>`;
  const { calls, malformed } = parseReply(raw, { toolNames: new Set(["Read"]) });

  assert.strictEqual(malformed, false);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { file_path: String.raw`C:\Users\diva\f.txt` });
});

test("parse - a path such as C:\temp\new.txt is not read as a tab and a line break", () => {
  const raw = String.raw`<tool_call>{"name":"Read","arguments":{"file_path":"C:\temp\new.txt"}}</tool_call>`;
  const { calls } = parseReply(raw, { toolNames: new Set(["Read"]) });

  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { file_path: String.raw`C:\temp\new.txt` });
});

test("parse - an invalid escape in a regex argument is kept as a literal backslash", () => {
  const raw = String.raw`<tool_call>{"name":"Bash","arguments":{"command":"grep -E \"\d+\" a.txt"}}</tool_call>`;
  const { calls, malformed } = parseReply(raw, { toolNames: new Set(["Bash"]) });

  assert.strictEqual(malformed, false);
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: String.raw`grep -E "\d+" a.txt` });
});

test("parse - valid JSON escapes in an ordinary string keep their meaning", () => {
  const raw = String.raw`<tool_call>{"name":"Bash","arguments":{"command":"echo a\nb \"q\" \u0041"}}</tool_call>`;
  const { calls } = parseReply(raw, { toolNames: new Set(["Bash"]) });

  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: 'echo a\nb "q" A' });
});

test("parse - a tool name is checked against the catalog in every dialect", () => {
  const toolNames = new Set(["Bash"]);

  const dsmlUnknown = parseReply(`<${DSML}calls><${DSML}invoke name="Deploy"><${DSML}parameter name="env" string="true">prod</${DSML}parameter></${DSML}invoke></${DSML}calls>`, { toolNames });
  assert.deepStrictEqual(dsmlUnknown.calls, []);
  assert.strictEqual(dsmlUnknown.malformed, true);
  assert.strictEqual(dsmlUnknown.text, "");

  const dsmlCase = parseReply(`<${DSML}calls><${DSML}invoke name="bash"><${DSML}parameter name="command" string="true">pwd</${DSML}parameter></${DSML}invoke></${DSML}calls>`, { toolNames });
  assert.strictEqual(dsmlCase.calls[0].function.name, "Bash");

  const bareCase = parseReply('{"name":"bash","arguments":{"command":"pwd"}}', { toolNames });
  assert.strictEqual(bareCase.calls[0].function.name, "Bash");
});

test("parse - an unknown tool name in a tagged call is not run and does not leak", () => {
  const { calls, text, malformed } = parseReply('Oke.\n<tool_call>{"name":"Deploy","arguments":{"env":"prod"}}</tool_call>\nlanjut', { toolNames: new Set(["Bash"]) });

  assert.deepStrictEqual(calls, []);
  assert.strictEqual(malformed, true);
  assert.doesNotMatch(text, /Deploy|tool_call|prod/);
});

test("parse - a tool_call inside a fence runs only when its name is in the catalog", () => {
  const toolNames = new Set(["Bash"]);
  const known = parseReply('Ini:\n```\n<tool_call>{"name":"Bash","arguments":{"command":"ls"}}</tool_call>\n```\nselesai', { toolNames });
  assert.strictEqual(known.calls.length, 1);
  assert.strictEqual(known.text, "Ini:\n\nselesai");

  const example = parseReply('Contoh:\n```\n<tool_call>{"name":"Deploy","arguments":{"env":"prod"}}</tool_call>\n```\nselesai', { toolNames });
  assert.deepStrictEqual(example.calls, []);
  assert.strictEqual(example.malformed, false);
  assert.match(example.text, /Deploy/);
});

test("parse - prose that names the tag is not flagged as a broken call", () => {
  const raw = "Format call adalah <tool_call> dan itu JSON di dalamnya.";
  const { calls, malformed, text } = parseReply(raw, { toolNames: new Set(["Bash"]) });

  assert.deepStrictEqual(calls, []);
  assert.strictEqual(malformed, false);
  assert.strictEqual(text, raw);
});

test("parse - DeepSeek V3 native sentinel block becomes a call and leaves no markup", () => {
  const BEGIN = "\uFF5C\u2581calls\u2581begin\uFF5C";
  const CALL_BEGIN = "\uFF5C\u2581call\u2581begin\uFF5C";
  const SEP = "\uFF5C\u2581sep\uFF5C";
  const CALL_END = "\uFF5C\u2581call\u2581end\uFF5C";
  const CALLS_END = "\uFF5C\u2581calls\u2581end\uFF5C";
  const raw = `ok <${BEGIN}><${CALL_BEGIN}>function<${SEP}>Bash\n\`\`\`json\n{"command":"ls"}\n\`\`\`<${CALL_END}><${CALLS_END}>`;

  const { text, calls, malformed } = parseReply(raw, { toolNames: new Set(["Bash"]) });
  assert.strictEqual(malformed, false);
  assert.strictEqual(text, "ok");
  assert.strictEqual(calls[0].function.name, "Bash");
  assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { command: "ls" });
});

test("parse - a V3 block naming an unknown tool is dropped and flagged", () => {
  const BEGIN = "\uFF5C\u2581calls\u2581begin\uFF5C";
  const CALL_BEGIN = "\uFF5C\u2581call\u2581begin\uFF5C";
  const SEP = "\uFF5C\u2581sep\uFF5C";
  const CALLS_END = "\uFF5C\u2581calls\u2581end\uFF5C";
  const raw = `<${BEGIN}><${CALL_BEGIN}>function<${SEP}>Deploy\n\`\`\`json\n{"env":"prod"}\n\`\`\`<${CALLS_END}>`;

  const { text, calls, malformed } = parseReply(raw, { toolNames: new Set(["Bash"]) });
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(malformed, true);
  assert.strictEqual(text, "");
});

test("parse - echoed history lines and a closed think block never reach the answer", () => {
  const echoed = parseReply('Assistant called tool Bash (call_1): {"command":"ls"}\nTool result (Bash, call_1): a b\nselesai');
  assert.strictEqual(echoed.text, "selesai");
  assert.strictEqual(echoed.malformed, false);

  const thought = parseReply("<think>rencana</think>Jawab");
  assert.strictEqual(thought.text, "Jawab");
  assert.strictEqual(thought.malformed, false);
});

test("parse - an unclosed think tag cuts the answer and counts as malformed", () => {
  const { text, malformed } = parseReply("Jawab dulu <think>masih mikir");
  assert.strictEqual(text, "Jawab dulu");
  assert.strictEqual(malformed, true);
});

test("parse - prose that mentions a tool result mid-sentence is kept", () => {
  const raw = "Hasil dari Tool result (bash) tadi sudah jelas.";
  assert.strictEqual(parseReply(raw).text, raw);
});

test("parse - an escaped backslash in a non-path argument survives one level, not two", () => {
  // Triggers the repair path (\d is an invalid escape). The valid \\ must stay one backslash.
  const raw = String.raw`<tool_call>{"name":"Bash","arguments":{"command":"grep \d x \\ y"}}</tool_call>`;
  const { calls } = parseReply(raw, { toolNames: new Set(["Bash"]) });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(JSON.parse(calls[0].function.arguments).command, "grep \\d x \\ y");
});

test("parse - a history-looking line inside a code fence is kept as an example", () => {
  const raw = "Contoh log:\n```\nTool result (bash, call_1): a b\n```\nselesai";
  const { text, malformed } = parseReply(raw);
  assert.match(text, /Tool result \(bash, call_1\): a b/);
  assert.strictEqual(malformed, false);
});

test("parse - a V3 sentinel block quoted in a code fence is an example, not a call", () => {
  const BEGIN = "\uFF5C\u2581calls\u2581begin\uFF5C";
  const CALL_BEGIN = "\uFF5C\u2581call\u2581begin\uFF5C";
  const SEP = "\uFF5C\u2581sep\uFF5C";
  const CALLS_END = "\uFF5C\u2581calls\u2581end\uFF5C";
  const raw = `Contoh:\n\`\`\`\n<${BEGIN}><${CALL_BEGIN}>function<${SEP}>Bash\n\`\`\`json\n{"command":"ls"}\n\`\`\`<${CALLS_END}>\n\`\`\`\nselesai`;
  const { calls, malformed } = parseReply(raw, { toolNames: new Set(["Bash"]) });
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(malformed, false);
});

test("parse - a closed think block inside a code fence is kept as an example", () => {
  const raw = "Contoh:\n```\n<think>rencana</think>\n```\nselesai";
  assert.match(parseReply(raw).text, /<think>rencana<\/think>/);
});

test("parse - prose that starts with Tool result is not treated as history", () => {
  const raw = "Tool result (hasil tes) menunjukkan semuanya lulus.";
  assert.strictEqual(parseReply(raw).text, raw);
});
