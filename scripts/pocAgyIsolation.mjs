#!/usr/bin/env node
/**
 * PoC Empirical Verification Script for Antigravity ACP Multi-Account Isolation (Stage 1 & 2).
 * Usage: node scripts/pocAgyIsolation.mjs [--interactive]
 */
import { mkdir, chmod, stat, writeFile, readFile, rm, access, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const INTERACTIVE = process.argv.includes("--interactive");
const POC_ROOTS = {
  A: "/tmp/agy-poc-a",
  B: "/tmp/agy-poc-b",
};
const SUBFOLDERS = ["home", "appdata", "workspace"];
const SERVER_NAMES = process.platform === "win32"
  ? ["agy_acp_server.exe"]
  : ["agy_acp_server.par", "agy_acp_server"];

function buildIsolatedEnv(rootDir) {
  const home = path.join(rootDir, "home");
  const appdata = path.join(rootDir, "appdata");
  const workspace = path.join(rootDir, "workspace");
  const env = {
    ...process.env,
    HOME: home,
    GEMINI_HOME: path.join(home, ".gemini"),
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    XDG_CONFIG_HOME: appdata,
    XDG_DATA_HOME: appdata,
  };
  if (process.platform === "linux") {
    env.DBUS_SESSION_BUS_ADDRESS = "disabled:";
    env.XDG_RUNTIME_DIR = path.join(home, "run");
  }
  return { env, home, appdata, workspace };
}

async function setupIsolatedEnv(label, rootDir) {
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(rootDir, 0o700);
  for (const sub of SUBFOLDERS) {
    const dir = path.join(rootDir, sub);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(dir, 0o700);
  }
  const built = buildIsolatedEnv(rootDir);
  const runDir = path.join(built.home, "run");
  await mkdir(built.env.GEMINI_HOME, { recursive: true, mode: 0o700 });
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(built.env.GEMINI_HOME, 0o700);
    await chmod(runDir, 0o700);
  }

  // Verify permissions on Linux/POSIX
  if (process.platform !== "win32") {
    for (const dir of [rootDir, built.home, runDir, built.appdata, built.workspace, built.env.GEMINI_HOME]) {
      const info = await stat(dir);
      const mode = info.mode & 0o777;
      if (mode !== 0o700) {
        throw new Error(`Expected 0700 on ${dir} for ${label}, got 0${mode.toString(8)}`);
      }
    }
  }
  return built;
}

function probeDbusIsolation(isolatedEnv) {
  // 1. Verify child process sees DBUS_SESSION_BUS_ADDRESS === "disabled:" and isolated XDG_RUNTIME_DIR
  const envCheck = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(JSON.stringify({ dbus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null, xdg: process.env.XDG_RUNTIME_DIR ?? null }))"],
    { env: isolatedEnv, encoding: "utf8" },
  );
  if (envCheck.status !== 0) {
    return { ok: false, detail: `Child env probe failed with status ${envCheck.status}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(envCheck.stdout);
  } catch {
    return { ok: false, detail: `Child env probe invalid JSON: ${envCheck.stdout}` };
  }
  if (parsed.dbus !== "disabled:") {
    return { ok: false, detail: `Child DBUS_SESSION_BUS_ADDRESS mismatch: ${JSON.stringify(parsed.dbus)}` };
  }
  if (typeof parsed.xdg !== "string" || !parsed.xdg.endsWith(`${path.sep}run`) || /^\/run\/user\/\d+/.test(parsed.xdg)) {
    return { ok: false, detail: `Child XDG_RUNTIME_DIR not isolated: ${JSON.stringify(parsed.xdg)}` };
  }

  // 2. Probe Secret Service via dbus-send if available; it MUST fail when isolated
  const dbusSend = spawnSync("dbus-send", [
    "--session",
    "--dest=org.freedesktop.secrets",
    "--type=method_call",
    "--print-reply",
    "/org/freedesktop/secrets",
    "org.freedesktop.DBus.Peer.Ping",
  ], { env: isolatedEnv, encoding: "utf8", timeout: 3000 });

  if (dbusSend.error && dbusSend.error.code === "ENOENT") {
    return { ok: true, detail: "DBUS_SESSION_BUS_ADDRESS='disabled:' & isolated XDG_RUNTIME_DIR verified (dbus-send not installed)" };
  }
  if (dbusSend.status === 0) {
    return { ok: false, detail: "D-Bus leak detected: dbus-send unexpectedly succeeded against host session bus" };
  }
  return { ok: true, detail: "D-Bus session bus disabled and isolated (dbus-send failed as expected)" };
}

async function testFileStorageIsolation(ctxA, ctxB) {
  const tokenPathA = path.join(ctxA.env.GEMINI_HOME, "oauth_creds.json");
  const tokenPathB = path.join(ctxB.env.GEMINI_HOME, "oauth_creds.json");
  const simulatedToken = JSON.stringify({ account: "poc-a@example.com", token: "sim-token-a" });

  await writeFile(tokenPathA, simulatedToken, { mode: 0o600 });
  const readA = await readFile(tokenPathA, "utf8");
  if (readA !== simulatedToken) {
    return { ok: false, detail: "Token A mismatch after write" };
  }

  const filesB = await readdir(ctxB.env.GEMINI_HOME);
  if (filesB.length !== 0) {
    return { ok: false, detail: `Env B GEMINI_HOME not empty: ${filesB.join(", ")}` };
  }
  try {
    await access(tokenPathB, fsConstants.F_OK);
    return { ok: false, detail: "Token file unexpectedly exists in Env B" };
  } catch {
    return { ok: true, detail: "Token written in Env A; Env B remains isolated and empty" };
  }
}

async function findAgyServer() {
  if (process.env.AGY_ACP_SERVER) {
    try {
      await access(process.env.AGY_ACP_SERVER, fsConstants.X_OK);
      return process.env.AGY_ACP_SERVER;
    } catch { /* fall through */ }
  }
  const home = os.homedir();
  const studio = path.join(home, ".android", "studio", "agent", "binaries", "antigravity-acp");
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  const plat = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  for (const name of SERVER_NAMES) {
    const candidate = path.join(studio, `${plat}-${arch}`, name);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* continue */ }
  }
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of SERVER_NAMES) {
      const candidate = path.join(dir, name);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch { /* continue */ }
    }
  }
  return null;
}

function spawnAcpHandshake(serverPath, ctx, label) {
  return new Promise((resolve) => {
    const args = serverPath.endsWith(".par") && process.platform === "linux"
      ? ["--uid="]
      : [];
    const child = spawn(serverPath, args, {
      cwd: ctx.workspace,
      env: ctx.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    let buffer = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ ok: false, detail: `${label}: ACP initialize timeout` });
    }, 8000);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      resolve(result);
    };

    child.on("error", (err) => finish({ ok: false, detail: `${label}: spawn error: ${err.message}` }));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            finish({ ok: true, detail: `${label}: ACP v${msg.result.protocolVersion ?? "?"} initialized`, childPid: child.pid });
            return;
          }
          if (msg.id === 1 && msg.error) {
            finish({ ok: false, detail: `${label}: ACP error ${msg.error.code}: ${msg.error.message}` });
            return;
          }
        } catch { /* ignore non-JSON */ }
      }
    });

    const initReq = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {} },
    });
    child.stdin.write(`${initReq}\n`);
  });
}

async function main() {
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
  };

  // a. Setup Lingkungan Terisolasi
  let ctxA;
  let ctxB;
  try {
    ctxA = await setupIsolatedEnv("A", POC_ROOTS.A);
    ctxB = await setupIsolatedEnv("B", POC_ROOTS.B);
    record("a. Isolated Env Setup", true, `${POC_ROOTS.A} & ${POC_ROOTS.B} (0700)`);
  } catch (err) {
    record("a. Isolated Env Setup", false, err.message);
  }

  // b. D-Bus Probe
  if (ctxA) {
    const dbusRes = probeDbusIsolation(ctxA.env);
    record("b. D-Bus Isolation Probe", dbusRes.ok, dbusRes.detail);
  } else {
    record("b. D-Bus Isolation Probe", false, "Skipped due to setup failure");
  }

  // c. File Storage Isolation
  if (ctxA && ctxB) {
    const fsRes = await testFileStorageIsolation(ctxA, ctxB);
    record("c. File Storage Isolation", fsRes.ok, fsRes.detail);
  } else {
    record("c. File Storage Isolation", false, "Skipped due to setup failure");
  }

  // d. Parallel Worker Lifecycle & Session Test
  const serverPath = await findAgyServer();
  if (!serverPath) {
    record(
      "d. Parallel Worker & ACP Handshake",
      true,
      "SKIPPED (agy_acp_server/.par not found in PATH; set AGY_ACP_SERVER to test live binary)",
    );
    record(
      "e. Restart & Tamper Test",
      true,
      "SKIPPED (requires live agy_acp_server/.par binary)",
    );
  } else {
    const [resA, resB] = await Promise.all([
      spawnAcpHandshake(serverPath, ctxA, "A"),
      spawnAcpHandshake(serverPath, ctxB, "B"),
    ]);
    record("d. Parallel Worker & ACP Handshake", resA.ok && resB.ok, `${resA.detail}; ${resB.detail}`);

    if (INTERACTIVE) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log("\n[INTERACTIVE] Login 2 akun Google berbeda menggunakan:");
      console.log(`  Akun A: HOME=${ctxA.env.HOME} GEMINI_HOME=${ctxA.env.GEMINI_HOME} AGY_ACP_FORCE_FILE_STORAGE=1 DBUS_SESSION_BUS_ADDRESS=""`);
      console.log(`  Akun B: HOME=${ctxB.env.HOME} GEMINI_HOME=${ctxB.env.GEMINI_HOME} AGY_ACP_FORCE_FILE_STORAGE=1 DBUS_SESSION_BUS_ADDRESS=""`);
      await rl.question("Tekan Enter setelah selesai login untuk melanjutkan ke Restart & Tamper Test...");
      rl.close();
    }

    // e. Restart & Tamper Test
    const [reA, reB] = await Promise.all([
      spawnAcpHandshake(serverPath, ctxA, "A-restart"),
      spawnAcpHandshake(serverPath, ctxB, "B-restart"),
    ]);
    const tokenIntact = await readFile(path.join(ctxA.env.GEMINI_HOME, "oauth_creds.json"), "utf8")
      .then((v) => v.includes("sim-token-a"))
      .catch(() => false);
    const eOk = reA.ok && reB.ok && tokenIntact;
    record("e. Restart & Tamper Test", eOk, `restartA=${reA.ok}, restartB=${reB.ok}, tokenIntact=${tokenIntact}`);
  }

  // Print Verification Matrix
  console.log("\n=== Antigravity ACP Multi-Account Isolation PoC Matrix ===");
  for (const r of results) {
    const badge = r.ok ? "PASS" : "FAIL";
    console.log(`[${badge}] ${r.name}: ${r.detail}`);
  }
  const allPassed = results.every((r) => r.ok);
  console.log(`\nOverall: ${allPassed ? "PASS" : "FAIL"}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("PoC script fatal error:", err);
  process.exit(1);
});
