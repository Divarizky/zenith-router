#!/usr/bin/env node
/**
 * Capture DeepSeek Web traffic into fixtures.
 *
 * The transport implementation depends on the real shape of the challenge,
 * completion stream, and history payloads. Guessing them produces a parser that
 * only agrees with itself, so this script records one real turn from an account
 * you own and writes sanitized fixtures.
 *
 * It never prints or writes the session token or cookies. Output defaults to
 * tests/fixtures/deepseekWeb/private/, which is gitignored.
 *
 * Usage:
 *   CHATBRAIN_SESSION=./.websession.json node scripts/captureDeepSeekWebFixtures.js --prompt "halo"
 *   DEEPSEEK_TOKEN=... DEEPSEEK_COOKIES='a=1; b=2' node scripts/captureDeepSeekWebFixtures.js
 *   node scripts/captureDeepSeekWebFixtures.js --dry-run
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodePowHeader, solvePowChallenge } from "../src/services/deepseekWeb/pow.js";

const BASE = "https://chat.deepseek.com";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:158.0) Gecko/20100101 Firefox/158.0";
const TARGET_PATH = "/api/v0/chat/completion";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: node scripts/captureDeepSeekWebFixtures.js [options]",
    "",
    "Options:",
    "  --session <file>   JSON file with { token, cookies } (default: $CHATBRAIN_SESSION)",
    "  --prompt <text>    Prompt to send (default: \"halo\")",
    "  --out <dir>        Output directory (default: tests/fixtures/deepseekWeb/private)",
    "  --dry-run          Print the request plan without touching the network",
    "  --help             Show this text",
    "",
    "Environment:",
    "  DEEPSEEK_TOKEN, DEEPSEEK_COOKIES   Used when no session file is given.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { prompt: "halo", out: null, session: process.env.CHATBRAIN_SESSION || null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (arg === "--session" || arg === "--prompt" || arg === "--out") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      args[arg.slice(2)] = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function loadSession(sessionFile) {
  let token = process.env.DEEPSEEK_TOKEN || "";
  let cookies = process.env.DEEPSEEK_COOKIES || "";

  if (sessionFile) {
    const path = resolve(sessionFile);
    if (!existsSync(path)) throw new Error(`Session file not found: ${path}`);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    token = raw.token || raw.userToken || token;
    cookies = typeof raw.cookies === "string" ? raw.cookies : cookies;
    if (!cookies && raw.cookies && typeof raw.cookies === "object") {
      cookies = Object.entries(raw.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    }
  }

  if (!token) {
    throw new Error(
      "No session token. Log in at chat.deepseek.com, then pass --session <file> with { token, cookies } or set DEEPSEEK_TOKEN."
    );
  }
  return { token, cookies };
}

function headers(session) {
  const base = {
    Authorization: `Bearer ${session.token}`,
    "User-Agent": USER_AGENT,
    Origin: BASE,
    Referer: `${BASE}/`,
    Accept: "*/*",
  };
  if (session.cookies) base.Cookie = session.cookies;
  return base;
}

async function call(session, path, { method = "POST", body, extra = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...headers(session),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} failed with HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return { status: res.status, text };
}

function parseJson(kind, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${kind} did not return JSON: ${text.slice(0, 200)}`);
  }
}

function challengeFrom(payload) {
  const challenge = payload?.data?.biz_data?.challenge;
  if (!challenge || typeof challenge !== "object") {
    throw new Error("create_pow_challenge response has no data.biz_data.challenge");
  }
  return challenge;
}

function sessionIdFrom(payload) {
  const id = payload?.data?.biz_data?.chat_session?.id;
  if (!id) throw new Error("chat_session/create response has no data.biz_data.chat_session.id");
  return id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const outDir = resolve(args.out || join(PROJECT_ROOT, "tests/fixtures/deepseekWeb/private"));
  if (args.dryRun) {
    console.log(`DRY RUN — no network calls`);
    console.log(`POST ${BASE}/api/v0/chat/create_pow_challenge  {"target_path":"${TARGET_PATH}"}`);
    console.log(`POST ${BASE}/api/v0/chat_session/create  {}`);
    console.log(`POST ${BASE}${TARGET_PATH}  completion for prompt (${args.prompt.length} chars)`);
    console.log(`GET  ${BASE}/api/v0/chat/history_messages?chat_session_id=<id>`);
    console.log(`Output: ${outDir}`);
    return;
  }

  const session = loadSession(args.session);
  mkdirSync(outDir, { recursive: true });
  const capturedAt = new Date().toISOString();
  const steps = [];

  const pow = await call(session, "/api/v0/chat/create_pow_challenge", {
    body: { target_path: TARGET_PATH },
  });
  const challenge = challengeFrom(parseJson("create_pow_challenge", pow.text));
  steps.push({ step: "create_pow_challenge", status: pow.status });

  const solveStarted = process.hrtime.bigint();
  const solution = await solvePowChallenge(challenge);
  const solveMs = Number(process.hrtime.bigint() - solveStarted) / 1e6;
  const header = encodePowHeader(solution);

  const created = await call(session, "/api/v0/chat_session/create", { body: {} });
  const chatSessionId = sessionIdFrom(parseJson("chat_session/create", created.text));
  steps.push({ step: "chat_session/create", status: created.status });

  const completion = await call(session, TARGET_PATH, {
    body: {
      chat_session_id: chatSessionId,
      parent_message_id: null,
      prompt: args.prompt,
      ref_file_ids: [],
      thinking_enabled: false,
      search_enabled: false,
    },
    extra: { "x-ds-pow-response": header },
  });
  steps.push({ step: "chat/completion", status: completion.status });

  const history = await call(
    session,
    `/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(chatSessionId)}`,
    { method: "GET" }
  );
  steps.push({ step: "chat/history_messages", status: history.status });

  writeFileSync(
    join(outDir, "challenge.json"),
    JSON.stringify(
      {
        _synthetic: false,
        capturedAt,
        httpStatus: pow.status,
        targetPath: TARGET_PATH,
        solveMs: Math.round(solveMs * 10) / 10,
        challenge,
      },
      null,
      2
    )
  );
  writeFileSync(join(outDir, "completion.sse.txt"), completion.text);
  writeFileSync(join(outDir, "history.json"), history.text);
  writeFileSync(
    join(outDir, "metadata.json"),
    JSON.stringify(
      {
        capturedAt,
        base: BASE,
        promptChars: args.prompt.length,
        sseBytes: Buffer.byteLength(completion.text, "utf8"),
        solveMs: Math.round(solveMs * 10) / 10,
        steps,
        notes: [
          "Token, cookies, and chat/message ids are not written to this metadata.",
          "history.json contains the prompt and the model reply; review before sharing.",
        ],
      },
      null,
      2
    )
  );

  console.log(`Saved fixtures to ${outDir}`);
  console.log(`PoW difficulty=${challenge.difficulty} solved in ${Math.round(solveMs)}ms`);
  console.log(`SSE bytes=${Buffer.byteLength(completion.text, "utf8")} prompts=${args.prompt.length} chars`);
}

main().catch((err) => {
  console.error(`capture failed: ${err.message}`);
  process.exit(1);
});
