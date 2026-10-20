import test from "node:test";
import vm from "node:vm";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDb } from "../src/db/index.js";
import {
  setUpgradeExec,
  setUpgradeRunner,
  setSelfExit,
  resetUpgradeState,
  getUpgradeCapability,
  backupDatabase,
  runUpgrade,
  setUpgradeDataDir,
} from "../src/services/upgrade.js";
import { setCustomVersionFetcher, resetVersionCache } from "../src/services/version.js";
import { app } from "../src/index.js";

initDb(":memory:");

// Log dan backup default dari runUpgrade masuk ke sini, bukan ke data/ asli.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-upgrade-"));
setUpgradeDataDir(testDataDir);
test.after(() => {
  setUpgradeDataDir(null);
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

/** Rekaman eksekusi git: menjawab perintah sesuai skrip, mencatat urutannya. */
function recorderExec({ inWorkTree = true, clean = true, fetchFails = false, tagMissing = false, checkoutFails = false } = {}) {
  const calls = [];
  const execFn = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    const key = args.join(" ");
    if (key.startsWith("rev-parse --is-inside-work-tree")) {
      if (!inWorkTree) throw new Error("not a git repository");
      return { stdout: "true\n", stderr: "" };
    }
    if (key.startsWith("status --porcelain")) {
      return { stdout: clean ? "" : " M src/index.js\n", stderr: "" };
    }
    if (key.startsWith("fetch")) {
      if (fetchFails) throw new Error("network down");
      return { stdout: "", stderr: "" };
    }
    if (key.startsWith("rev-parse -q --verify")) {
      if (tagMissing) throw new Error("unknown revision");
      return { stdout: "abc\n", stderr: "" };
    }
    if (key.startsWith("rev-parse HEAD")) return { stdout: "abcdef123\n", stderr: "" };
    if (key.startsWith("checkout")) {
      if (checkoutFails) throw new Error("index.lock busy");
      return { stdout: "", stderr: "" };
    }
    throw new Error(`perintah tak dikenal di test: ${cmd} ${key}`);
  };
  execFn.calls = calls;
  return execFn;
}

function tmpBackupDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zenith-backup-"));
}

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

test("upgrade - a git checkout reports auto mode, a plain directory reports notify", async () => {
  resetUpgradeState();
  setUpgradeExec(recorderExec());
  assert.deepStrictEqual(await getUpgradeCapability(), { mode: "auto" });

  resetUpgradeState();
  setUpgradeExec(recorderExec({ inWorkTree: false }));
  const cap = await getUpgradeCapability();
  assert.strictEqual(cap.mode, "notify");
  assert.match(cap.reason, /bukan clone git/);

  resetUpgradeState();
});

test("upgrade - GET /api/version carries the capability", async () => {
  resetUpgradeState();
  resetVersionCache();
  setCustomVersionFetcher(async () => ({ tag_name: "v9.9.9" }));
  setUpgradeExec(recorderExec());

  const data = JSON.parse(await (await app.request("/api/version")).text());
  assert.strictEqual(data.upgrade.mode, "auto");
  assert.strictEqual(data.hasUpdate, true);

  resetUpgradeState();
  resetVersionCache();
  setCustomVersionFetcher(null);
});

test("upgrade - a malformed tag never reaches git", async () => {
  resetUpgradeState();
  const exec = recorderExec();
  const runnerCalls = [];
  setUpgradeExec(exec);
  setUpgradeRunner((...a) => runnerCalls.push(a));

  await assert.rejects(runUpgrade("v1.2.3; rm -rf /"), /format tag/);
  assert.ok(!exec.calls.some((c) => c.includes("rm")), "string bebas tidak pernah dieksekusi");
  assert.strictEqual(runnerCalls.length, 0);

  resetUpgradeState();
});

test("upgrade - a dirty tree refuses before touching anything", async () => {
  resetUpgradeState();
  const exec = recorderExec({ clean: false });
  const runnerCalls = [];
  const exitCalls = [];
  setUpgradeExec(exec);
  setUpgradeRunner((...a) => runnerCalls.push(a));
  setSelfExit((d) => exitCalls.push(d));

  const backupDir = tmpBackupDir();
  await assert.rejects(runUpgrade("v9.9.9", { backupDir }), /working tree kotor/);
  assert.strictEqual(runnerCalls.length, 0, "runner tidak boleh terpanggil");
  assert.strictEqual(exitCalls.length, 0, "proses tidak boleh dijadwalkan keluar");
  assert.strictEqual(fs.readdirSync(backupDir).length, 0, "tidak ada backup saat menolak");
  fs.rmSync(backupDir, { recursive: true, force: true });

  resetUpgradeState();
});

test("upgrade - notify mode never runs the flow", async () => {
  resetUpgradeState();
  setUpgradeExec(recorderExec({ inWorkTree: false }));
  await assert.rejects(runUpgrade("v9.9.9"), /bukan clone git/);
  resetUpgradeState();
});

test("upgrade - an unknown tag stops the flow after fetch", async () => {
  resetUpgradeState();
  const exec = recorderExec({ tagMissing: true });
  setUpgradeExec(exec);
  const runnerCalls = [];
  setUpgradeRunner((...a) => runnerCalls.push(a));

  await assert.rejects(runUpgrade("v9.9.9"), /tidak ditemukan/);
  assert.ok(exec.calls.some((c) => c.includes("fetch")), "fetch dulu sebelum menilai tag");
  assert.strictEqual(runnerCalls.length, 0);
  resetUpgradeState();
});

test("upgrade - happy path: backup, fetch, checkout, runner, exit — in that order", async () => {
  resetUpgradeState();
  const exec = recorderExec();
  const events = [];
  setUpgradeExec(exec);
  setUpgradeRunner(() => events.push("runner"));
  setSelfExit((d) => events.push(`exit:${d}`));

  const backupDir = tmpBackupDir();
  const result = await runUpgrade("v9.9.9", { backupDir });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.restarting, true);
  const backups = fs.readdirSync(backupDir);
  assert.strictEqual(backups.length, 1, "satu file backup terbuat");
  assert.match(backups[0], /^zenith-.*\.db$/);
  fs.rmSync(backupDir, { recursive: true, force: true });

  const order = exec.calls.map((c) => c.split(" ").slice(1).join(" "));
  const idx = (frag) => order.findIndex((c) => c.startsWith(frag));
  assert.ok(idx("status --porcelain") >= 0 && idx("fetch") > idx("status --porcelain"), "status dulu");
  assert.ok(idx("checkout") > idx("fetch"), "fetch dulu baru checkout");
  assert.ok(events[0] === "runner", "runner terpanggil setelah checkout");
  assert.strictEqual(events[1], "exit:700", "proses keluar 700ms setelah respons");
  resetUpgradeState();
});

test("upgrade - a failed fetch still proceeds when the tag exists locally", async () => {
  resetUpgradeState();
  const exec = recorderExec({ fetchFails: true });
  const events = [];
  setUpgradeExec(exec);
  setUpgradeRunner(() => events.push("runner"));
  setSelfExit((d) => events.push(`exit:${d}`));

  const backupDir = tmpBackupDir();
  const result = await runUpgrade("v9.9.9", { backupDir });
  assert.strictEqual(result.ok, true);
  assert.ok(events.includes("runner"));
  fs.rmSync(backupDir, { recursive: true, force: true });
  resetUpgradeState();
});

test("upgrade - a checkout failure never spawns the runner", async () => {
  resetUpgradeState();
  setUpgradeExec(recorderExec({ checkoutFails: true }));
  const runnerCalls = [];
  const exitCalls = [];
  setUpgradeRunner((...a) => runnerCalls.push(a));
  setSelfExit((d) => exitCalls.push(d));

  await assert.rejects(runUpgrade("v9.9.9"), /checkout gagal/);
  assert.strictEqual(runnerCalls.length, 0);
  assert.strictEqual(exitCalls.length, 0);
  resetUpgradeState();
});

test("POST /api/version/upgrade - a refusal comes back as JSON, not a crash", async () => {
  resetUpgradeState();
  setUpgradeExec(recorderExec({ clean: false }));

  const res = await app.request("/api/version/upgrade", {
    method: "POST",
    body: form({ version: "v9.9.9" }),
  });
  assert.strictEqual(res.status, 409);
  const data = await res.json();
  assert.strictEqual(data.ok, false);
  assert.match(data.error, /working tree kotor/);
  resetUpgradeState();
});

test("GET /dashboard - the sidebar carries the update badge slot", async () => {
  const html = await (await app.request("/dashboard")).text();
  assert.ok(html.includes('id="update-badge"'), "slot badge versi ada di sidebar");
  assert.ok(html.includes('fetch("/api/version"'), "sidebar memeriksa versi sendiri");
});

function fakeEl(extra = {}) {
  let children = [];
  return {
    children,
    handlers: {},
    className: "",
    textContent: "",
    appendChild(child) {
      children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      this.handlers[type] = fn;
    },
    ...extra,
  };
}

test("GET /dashboard - a new release renders the badge with its upgrade button", async () => {
  const html = await (await app.request("/dashboard")).text();
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1])
    .find((s) => s.includes("update-badge"));
  assert.ok(script, "script badge ada di halaman");

  const badge = fakeEl({ id: "update-badge" });
  const timers = [];
  const win = { addEventListener() {}, confirm: () => true, alert() {}, location: { search: "", reload() {} } };
  const sandbox = {
    window: win,
    document: {
      getElementById: (id) => (id === "update-badge" ? badge : null),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: (tag) => fakeEl({ tag }),
      body: fakeEl(),
    },
    location: { reload() {} },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        current: "0.1.1",
        latest: "0.1.2",
        tag: "v0.1.2",
        hasUpdate: true,
        url: "https://github.com/Divarizky/zenith-router/releases/tag/v0.1.2",
        upgrade: { mode: "auto" },
      }),
    }),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return {};
    },
  };
  vm.runInNewContext(script, sandbox);

  const boot = timers.find((t) => t.ms === 2500);
  assert.ok(boot, "pemeriksaan versi tertunda 2,5 detik setelah load");
  boot.fn();
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(badge.children.length, 1, "satu banner terpasang");
  const banner = badge.children[0];
  assert.strictEqual(banner.className, "update-banner");
  const label = banner.children.find((c) => c.textContent === "v0.1.2 tersedia");
  assert.ok(label, "banner menyebut versi terbaru");
  const button = banner.children.find((c) => c.tag === "button" && c.textContent === "Upgrade");
  assert.ok(button, "tombol Upgrade tersedia pada mode auto");
});
