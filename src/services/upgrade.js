import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };
import { getDb } from "../db/index.js";

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
const PORT = Number(process.env.PORT || 20120);

/**
 * Titik suntik untuk test: eksekusi git/npm, peluncur runner, dan penjadwal
 * exit proses. Produksi memakai implementasi aslinya; test merekam urutannya.
 */
let execFn = defaultExec;
let runnerFn = defaultRunner;
let selfExitFn = defaultSelfExit;
let capabilityCache = null;
// Folder log dan backup default. Test mengarahkannya ke folder sementara agar
// tidak pernah menulis ke data/ milik instalasi yang sedang dipakai.
let dataDir = path.join(PROJECT_ROOT, "data");

export function setUpgradeDataDir(dir) {
  dataDir = dir || path.join(PROJECT_ROOT, "data");
}

export function setUpgradeExec(fn) {
  execFn = fn || defaultExec;
  capabilityCache = null;
}
export function setUpgradeRunner(fn) {
  runnerFn = fn || defaultRunner;
}
export function setSelfExit(fn) {
  selfExitFn = fn || defaultSelfExit;
}
export function resetUpgradeState() {
  execFn = defaultExec;
  runnerFn = defaultRunner;
  selfExitFn = defaultSelfExit;
  capabilityCache = null;
}

async function defaultExec(cmd, args) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    timeout: 120000,
    encoding: "utf-8",
  });
  return { stdout, stderr };
}

function git(args) {
  return execFn("git", args);
}

function defaultRunner(repoDir, tag, port, previousRef) {
  const runnerPath = fileURLToPath(new URL("../updater/runner.js", import.meta.url));
  const child = spawn(process.execPath, [runnerPath, repoDir, tag, String(port), previousRef], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function defaultSelfExit(delayMs) {
  setTimeout(() => process.exit(0), delayMs).unref();
}

function logLine(message) {
  const file = path.join(dataDir, "updater.log");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // Log terbaik-saat-bisa; kegagalan menulis tidak boleh menggagalkan upgrade.
  }
}

/**
 * Mode upgrade halaman ini: "auto" bila direktori kerja adalah clone git
 * (bisa checkout tag sendiri), "notify" untuk instalasi lain (mis. ekstrak
 * zip rilis) yang hanya bisa menunjuk tautan unduhan.
 * Hasil disimpan sekali per proses; kemampuan ini tidak berubah selama hidup.
 */
export async function getUpgradeCapability() {
  if (capabilityCache) return capabilityCache;
  let inWorkTree = false;
  try {
    const { stdout } = await git(["rev-parse", "--is-inside-work-tree"]);
    inWorkTree = stdout.trim() === "true";
  } catch {
    inWorkTree = false;
  }
  capabilityCache = inWorkTree ? { mode: "auto" } : { mode: "notify", reason: "bukan clone git" };
  return capabilityCache;
}

async function isTreeClean() {
  const { stdout } = await git(["status", "--porcelain"]);
  return stdout.trim() === "";
}

async function tagExists(tag) {
  try {
    await git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Snapshot konsisten database lewat VACUUM INTO — aman walau koneksi masih
 * terbuka, dan menghasilkan file tunggal tanpa WAL yang menggantung.
 */
export function backupDatabase(fromVersion, backupDir = path.join(dataDir, "backups")) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(backupDir, `zenith-${fromVersion}-${stamp}.db`);
  const sqlPath = target.split(path.sep).join("/").replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${sqlPath}'`);
  return target;
}

/**
 * Jalankan upgrade penuh ke tag target: backup database, ambil tag terbaru,
 * checkout, lalu serahkan relaunch ke runner detached yang menunggu proses ini
 * keluar. Setiap kegagalan sebelum checkout berhenti tanpa mengubah apa pun;
 * kegagalan setelah checkout diusahakan dibalik oleh runner.
 *
 * Tag divalidasi ketat (hanya vMAJOR.MINOR.PATCH) — string dari body request
 * tidak pernah diteruskan apa adanya ke git.
 */
export async function runUpgrade(tag, { backupDir } = {}) {
  const capability = await getUpgradeCapability();
  if (capability.mode !== "auto") {
    throw new Error("bukan clone git — upgrade otomatis tidak tersedia di instalasi ini");
  }
  if (!TAG_PATTERN.test(String(tag || ""))) {
    throw new Error(`format tag "${tag}" tidak dikenal; gunakan bentuk vMAJOR.MINOR.PATCH`);
  }
  if (!(await isTreeClean())) {
    throw new Error("working tree kotor — commit atau stash dulu sebelum upgrade");
  }

  const backup = backupDatabase(pkg.version, backupDir);
  logLine(`backup dibuat: ${backup}`);

  try {
    await git(["fetch", "--tags", "--force", "origin"]);
  } catch (err) {
    if (!(await tagExists(tag))) {
      throw new Error(`fetch gagal dan tag ${tag} tidak ada di lokal: ${err.message}`);
    }
    // Tag sudah dikenal lokal: upgrade tetap jalan meski jaringan putus.
    logLine(`fetch gagal, memakai tag lokal ${tag}: ${err.message}`);
  }
  if (!(await tagExists(tag))) {
    throw new Error(`tag ${tag} tidak ditemukan di repo`);
  }

  const previousRef = (await git(["rev-parse", "HEAD"])).stdout.trim();

  try {
    await git(["checkout", "-f", tag]);
  } catch (err) {
    throw new Error(`checkout gagal, versi lama tetap berjalan: ${err.message}`);
  }
  logLine(`checkout ${tag} (sebelumnya ${previousRef})`);

  try {
    runnerFn(PROJECT_ROOT, tag, PORT, previousRef);
  } catch (err) {
    try {
      await git(["checkout", "-f", previousRef]);
      logLine(`runner gagal, checkout dikembalikan ke ${previousRef}: ${err.message}`);
    } catch {
      logLine(`runner gagal dan rollback checkout ikut gagal: ${err.message}`);
    }
    throw new Error(`runner gagal dijalankan: ${err.message}`);
  }

  logLine(`runner berjalan, server akan restart ke ${tag}`);
  selfExitFn(700);
  return { ok: true, restarting: true, tag, backup };
}

export async function handleUpgradeRequest(c) {
  const body = await c.req.parseBody();
  const tag = String(body.version || "").trim();
  try {
    return c.json(await runUpgrade(tag));
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 409);
  }
}
