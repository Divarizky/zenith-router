import { spawn, exec } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";

/**
 * Runner upgrade yang berjalan detached, jauh dari proses server utama.
 *
 * Urutannya: tunggu port benar-benar tertutup (server lama sudah keluar),
 * jalankan npm ci, nyalakan server baru, lalu pantau /api/version sampai
 * sehat. Bila npm ci gagal, checkout dikembalikan ke versi sebelumnya
 * agar setidaknya versi lama yang kembali berjalan. Semua kejadian ditulis ke
 * data/updater.log karena tidak ada yang bisa lagi melihat stdout-nya.
 *
 * argv: repoDir, tag, port, previousRef
 */
const [repoDir, tag, portArg, previousRef] = process.argv.slice(2);
const port = Number(portArg);
const NPM_CI = "npm ci --omit=dev --no-audit --no-fund";

function log(message) {
  try {
    const file = path.join(repoDir, "data", "updater.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // tanpa log tidak ada yang bisa dilakukan
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** true bila port sudah benar-benar bebas (koneksi ditolak). */
function portClosed(target) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: target, host: "127.0.0.1" });
    const done = (closed) => {
      socket.destroy();
      resolve(closed);
    };
    socket.once("connect", () => done(false));
    socket.once("error", () => done(true));
  });
}

async function waitForPortClose(target, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portClosed(target)) return true;
    await delay(500);
  }
  return false;
}

// /health tidak lewat auth dashboard; /api/version dibalik login sehingga bisa
// menjawab 401 walau server sehat.
function getOnce(target) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${target}/health`, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.once("error", () => resolve(false));
    req.once("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth(target, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await getOnce(target)) return true;
    await delay(1000);
  }
  return false;
}

function run(command, { cwd }) {
  return new Promise((resolve, reject) => {
    // shell:true diperlukan di Windows untuk npm.cmd; perintahnya tetap tetap
    // dan tag sudah divalidasi pola vMAJOR.MINOR.PATCH sebelum sampai sini.
    exec(command, { cwd, timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

async function main() {
  log(`runner start: target ${tag} (sebelumnya ${previousRef})`);

  if (!(await waitForPortClose(port))) {
    log("server lama tidak keluar dalam 30 detik — batal; versi baru sudah ter-checkout, jalankan ulang manual setelah server berhenti");
    process.exit(1);
  }

  // npm ci memasang persis isi package-lock.json dan tidak pernah menulis
  // ulang lockfile. npm install bisa mengubahnya, lalu working tree yang kotor
  // membuat upgrade berikutnya ditolak.
  try {
    await run(NPM_CI, { cwd: repoDir });
    log("npm ci berhasil");
  } catch (err) {
    log(`npm ci gagal: ${err.message}`);
    log(`mengembalikan checkout ke ${previousRef}`);
    try {
      await run(`git checkout -f ${previousRef}`, { cwd: repoDir });
      await run(NPM_CI, { cwd: repoDir });
      log(`rollback selesai, ${previousRef} siap dijalankan ulang`);
    } catch (err2) {
      log(`rollback gagal: ${err2.message} — pulihkan manual dari data/updater.log`);
      process.exit(1);
    }
  }

  const server = spawn(process.execPath, ["src/index.js"], {
    cwd: repoDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, PORT: String(port) },
  });
  server.unref();

  if (await waitForHealth(port)) {
    log(`selesai: ${tag} berjalan di port ${port}`);
    return;
  }

  log(`server baru tidak menjawab /health dalam 45 detik — mengembalikan ke ${previousRef}`);
  const rolledBack = await rollbackTo(previousRef);
  if (!rolledBack) {
    log("rollback gagal — pulihkan manual dari data/updater.log");
    process.exit(1);
  }
  if (await waitForHealth(port)) {
    log(`rollback selesai: ${previousRef} berjalan di port ${port}`);
  } else {
    log(`server ${previousRef} juga tidak menjawab /health — jalankan ulang manual (npm start)`);
    process.exit(1);
  }
}

/** Checkout versi sebelumnya, pasang dependensi, lalu jalankan server lama. */
async function rollbackTo(ref) {
  try {
    await run(`git checkout -f ${ref}`, { cwd: repoDir });
    await run(NPM_CI, { cwd: repoDir });
  } catch (err) {
    log(`rollback checkout gagal: ${err.message}`);
    return false;
  }
  const previous = spawn(process.execPath, ["src/index.js"], {
    cwd: repoDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, PORT: String(port) },
  });
  previous.unref();
  return true;
}

main().catch((err) => {
  log(`runner error: ${err.message}`);
  process.exit(1);
});
