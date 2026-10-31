import test from "node:test";
import assert from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../src/updater/runner.js", import.meta.url));

// Stub server: v1 sehat dan menjawab /health, v2 gagal start (tidak listen).
const HEALTHY_STUB = `
import http from "node:http";
const port = Number(process.env.PORT);
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, {"Content-Type":"application/json"}); res.end("{\\"status\\":\\"ok\\"}"); return; }
  res.writeHead(401); res.end();
}).listen(port, "127.0.0.1");
`;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" });
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zr-rollback-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@t"]);
  git(dir, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", private: true }));
  fs.writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, requires: true, packages: { "": { name: "x", version: "1.0.0" } } }));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.js"), HEALTHY_STUB);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "v1"]);
  git(dir, ["tag", "v1.0.0"]);
  // v2: server tidak pernah listen, jadi health check harus gagal.
  fs.writeFileSync(path.join(dir, "src", "index.js"), "process.exit(1);\n");
  git(dir, ["commit", "-aqm", "v2"]);
  git(dir, ["tag", "v2.0.0"]);
  return dir;
}

function waitForChildExit(child) {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

test("F-08 updater: health gagal memicu rollback ke versi sebelumnya dan server lama hidup", async (t) => {
  const repo = makeRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  // Versi lama sengaja dibuat sehat; runner dijalankan dengan port tertutup.
  const port = await freePort();

  // Checkout v2 dulu (seperti setelah upgrade), lalu jalankan runner dengan previousRef v1.
  git(repo, ["checkout", "-q", "v2.0.0"]);
  const child = spawn(process.execPath, [RUNNER, repo, "v2.0.0", String(port), "v1.0.0"], {
    stdio: "ignore",
    detached: false,
  });
  // Runner menunggu health 45 dtk; tes menunggu sampai proses selesai (maks 150 dtk).
  const code = await Promise.race([
    waitForChildExit(child),
    new Promise((r) => setTimeout(() => r("timeout"), 150000)),
  ]);
  child.kill();

  const log = fs.readFileSync(path.join(repo, "data", "updater.log"), "utf-8");
  assert.match(log, /\/health/, "health check memakai /health");
  assert.doesNotMatch(log, /\/api\/version/, "health check tidak lagi memakai /api/version");
  assert.match(log, /mengembalikan ke v1\.0\.0/, "rollback dipicu saat health gagal");
  assert.strictEqual(git(repo, ["describe", "--tags", "--exact-match"]).trim(), "v1.0.0", "checkout kembali ke v1");
  assert.ok(code !== "timeout", "runner selesai");
});
