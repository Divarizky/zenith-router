import { spawn, exec } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import http from "node:http";
import path from "node:path";

/**
 * Runner upgrade yang berjalan detached, jauh dari proses server utama.
 *
 * Urutannya: tunggu port benar-benar tertutup (server lama sudah keluar),
 * jalankan npm install, nyalakan server baru, lalu pantau /api/version sampai
 * sehat. Bila npm install gagal, checkout dikembalikan ke versi sebelumnya
 * agar setidaknya versi lama yang kembali berjalan. Semua kejadian ditulis ke
 * data/updater.log karena tidak ada yang bisa lagi melihat stdout-nya.
 *
 * argv: repoDir, tag, port, previousRef
 */
const [repoDir, tag, portArg, previousRef] = process.argv.slice(2);
const port = Number(portArg);

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

function getOnce(target) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${target}/api/version`, { timeout: 3000 }, (res) => {
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

  try {
    await run("npm install --no-audit --no-fund", { cwd: repoDir });
    log("npm install berhasil");
  } catch (err) {
    log(`npm install gagal: ${err.message}`);
    log(`mengembalikan checkout ke ${previousRef}`);
    try {
      await run(`git checkout -f ${previousRef}`, { cwd: repoDir });
      await run("npm install --no-audit --no-fund", { cwd: repoDir });
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
  } else {
    log(`server baru tidak menjawab /api/version dalam 45 detik — cek log startup dan jalankan ulang manual (npm start)`);
  }
}

main().catch((err) => {
  log(`runner error: ${err.message}`);
  process.exit(1);
});
