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
const MANIFEST_URL = (tag) =>
  `https://github.com/Divarizky/zenith-router/releases/download/${tag}/release-manifest.json`;
const MANIFEST_TIMEOUT_MS = 10000;

/**
 * Titik suntik untuk test: eksekusi git/npm, peluncur runner, dan penjadwal
 * exit proses. Produksi memakai implementasi aslinya; test merekam urutannya.
 */
let execFn = defaultExec;
let runnerFn = defaultRunner;
let selfExitFn = defaultSelfExit;
let manifestFn = defaultManifestFetch;
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
export function setUpgradeManifestFetcher(fn) {
  manifestFn = fn || defaultManifestFetch;
}
export function resetUpgradeState() {
  execFn = defaultExec;
  runnerFn = defaultRunner;
  selfExitFn = defaultSelfExit;
  manifestFn = defaultManifestFetch;
  capabilityCache = null;
}

/** Ambil manifest rilis (asset Release) untuk satu tag. Mengembalikan objek JSON. */
async function defaultManifestFetch(tag) {
  const res = await fetch(MANIFEST_URL(tag), {
    redirect: "follow",
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Cocokkan commit yang ditunjuk tag lokal dengan hash di manifest rilis.
 * Gagal tertutup: manifest tak terjangkau, tak valid, atau berbeda = upgrade ditolak.
 * ZENITH_UPGRADE_SKIP_PIN=1 melewati pengecekan ini.
 */
async function verifyTagAgainstManifest(tag) {
  if (process.env.ZENITH_UPGRADE_SKIP_PIN === "1") {
    logLine("ZENITH_UPGRADE_SKIP_PIN=1: verifikasi manifest dilewati");
    return;
  }
  let manifest;
  try {
    manifest = await manifestFn(tag);
  } catch (err) {
    throw new Error(`manifest rilis ${tag} tidak bisa diambil, upgrade dibatalkan: ${err.message}`);
  }
  const expected = String(manifest?.commit || "").toLowerCase();
  if (manifest?.tag !== tag || !/^[0-9a-f]{40}$/.test(expected)) {
    throw new Error(`manifest rilis ${tag} tidak valid, upgrade dibatalkan`);
  }
  const actual = (await git(["rev-parse", `${tag}^{commit}`])).stdout.trim().toLowerCase();
  if (actual !== expected) {
    throw new Error(`commit tag ${tag} (${actual}) tidak sama dengan manifest rilis (${expected}), upgrade dibatalkan`);
  }
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
  // Salinan memuat kredensial yang sama; VACUUM INTO memakai umask default.
  try {
    fs.chmodSync(target, 0o600);
  } catch {}
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
    // Tanpa --force: git menolak tag remote yang berbeda dari tag lokal dengan nama sama.
    await git(["fetch", "--tags", "origin"]);
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
  await verifyTagAgainstManifest(tag);

  const previousRef = (await git(["rev-parse", "HEAD"])).stdout.trim();

  try {
    // Tanpa -f: tree sudah dipastikan bersih di atas, jadi checkout tidak menimpa perubahan lokal.
    await git(["checkout", tag]);
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

/**
 * HTTP handler for POST /api/version/upgrade — transport for this operation
 * only. The reusable part is `runUpgrade` above, which takes no Hono context
 * and is what the test suite drives directly.
 */
export async function handleUpgradeRequest(c) {
  const body = await c.req.parseBody();
  const tag = String(body.version || "").trim();
  try {
    return c.json(await runUpgrade(tag));
  } catch (err) {
    return c.json({ ok: false, error: err.message }, 409);
  }
}
