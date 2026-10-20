import test from "node:test";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { app } from "../src/index.js";
import {
  initDb,
  closeDb,
  addConnection,
  deleteConnection,
  moveConnection,
  getConnections,
} from "../src/db/index.js";
import { getSetting, setSetting } from "../src/services/settings.js";

const order = (provider) => getConnections(provider).map((c) => [c.name, c.priority]);

function form(fields) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
  return body;
}

test("Account priority - an upgraded database numbers each provider in creation order", () => {
  const tmp = join(tmpdir(), `zenith-priority-${process.pid}-${Math.floor(process.uptime() * 1000)}.db`);
  try {
    const legacy = new DatabaseSync(tmp);
    legacy.exec(`
      CREATE TABLE connections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'apikey',
        credentials TEXT NOT NULL DEFAULT '{}',
        proxy_url TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        last_used_at INTEGER DEFAULT 0,
        cooldown_until INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO connections (provider, name, created_at) VALUES ('antigravity', 'AG Lama', 1);
      INSERT INTO connections (provider, name, created_at) VALUES ('glm', 'GLM Lama', 2);
      INSERT INTO connections (provider, name, created_at) VALUES ('antigravity', 'AG Baru', 3);
    `);
    legacy.close();

    initDb(tmp);
    assert.deepStrictEqual(order("antigravity"), [["AG Lama", 1], ["AG Baru", 2]]);
    assert.deepStrictEqual(order("glm"), [["GLM Lama", 1]], "nomor dihitung per provider");

    // A second start must keep a user-chosen order instead of renumbering by id.
    moveConnection(getConnections("antigravity")[1].id, "up");
    initDb(tmp);
    assert.deepStrictEqual(order("antigravity"), [["AG Baru", 1], ["AG Lama", 2]]);
  } finally {
    closeDb();
    try { rmSync(tmp, { force: true }); } catch {}
  }
});

test("Account priority - new accounts join the bottom of their own provider", () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "G1", credentials: { api_key: "1" } });
  addConnection({ provider: "mistral", name: "M1", credentials: { api_key: "m" } });
  addConnection({ provider: "glm", name: "G2", credentials: { api_key: "2" } });
  const g3 = addConnection({ provider: "glm", name: "G3", credentials: { api_key: "3" } });

  assert.strictEqual(g3.priority, 3);
  assert.deepStrictEqual(order("glm"), [["G1", 1], ["G2", 2], ["G3", 3]]);
  assert.deepStrictEqual(order("mistral"), [["M1", 1]]);
});

test("Account priority - deleting an account closes the gap and keeps the order", () => {
  initDb(":memory:");
  const g1 = addConnection({ provider: "glm", name: "G1", credentials: { api_key: "1" } });
  const g2 = addConnection({ provider: "glm", name: "G2", credentials: { api_key: "2" } });
  addConnection({ provider: "glm", name: "G3", credentials: { api_key: "3" } });
  addConnection({ provider: "mistral", name: "M1", credentials: { api_key: "m" } });
  moveConnection(g2.id, "up"); // G2, G1, G3

  assert.strictEqual(deleteConnection(g1.id), true);
  assert.deepStrictEqual(order("glm"), [["G2", 1], ["G3", 2]]);
  assert.deepStrictEqual(order("mistral"), [["M1", 1]], "provider lain tidak tersentuh");

  const g4 = addConnection({ provider: "glm", name: "G4", credentials: { api_key: "4" } });
  assert.strictEqual(g4.priority, 3, "akun baru tetap di bawah setelah penghapusan");
});

test("Account priority - move swaps neighbours and refuses to pass either end", () => {
  initDb(":memory:");
  const g1 = addConnection({ provider: "glm", name: "G1", credentials: { api_key: "1" } });
  const g2 = addConnection({ provider: "glm", name: "G2", credentials: { api_key: "2" } });
  const g3 = addConnection({ provider: "glm", name: "G3", credentials: { api_key: "3" } });
  const m1 = addConnection({ provider: "mistral", name: "M1", credentials: { api_key: "m" } });

  assert.strictEqual(moveConnection(g3.id, "up"), true);
  assert.deepStrictEqual(order("glm"), [["G1", 1], ["G3", 2], ["G2", 3]]);
  assert.strictEqual(moveConnection(g1.id, "down"), true);
  assert.deepStrictEqual(order("glm"), [["G3", 1], ["G1", 2], ["G2", 3]]);

  assert.strictEqual(moveConnection(g3.id, "up"), false, "#1 tidak bisa naik");
  assert.strictEqual(moveConnection(g2.id, "down"), false, "nomor terakhir tidak bisa turun");
  assert.strictEqual(moveConnection(m1.id, "up"), false, "akun tunggal tidak punya tetangga");
  assert.strictEqual(moveConnection(g1.id, "sideways"), false);
  assert.strictEqual(moveConnection(9999, "up"), false);
  assert.deepStrictEqual(order("glm"), [["G3", 1], ["G1", 2], ["G2", 3]], "langkah yang ditolak tidak mengubah apa pun");
  assert.deepStrictEqual(order("mistral"), [["M1", 1]]);
});

test("Account priority - an inactive account keeps its number", () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "G1", credentials: { api_key: "1" } });
  const g2 = addConnection({ provider: "glm", name: "G2", credentials: { api_key: "2" }, is_active: 0 });
  addConnection({ provider: "glm", name: "G3", credentials: { api_key: "3" } });

  assert.deepStrictEqual(order("glm"), [["G1", 1], ["G2", 2], ["G3", 3]]);
  assert.strictEqual(moveConnection(g2.id, "up"), true, "akun nonaktif tetap bisa diurutkan");
  assert.deepStrictEqual(order("glm"), [["G2", 1], ["G1", 2], ["G3", 3]]);
});

test("Provider detail - account table shows #n with up/down disabled at the ends", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Satu", credentials: { api_key: "1" } });
  const g2 = addConnection({ provider: "glm", name: "GLM Dua", credentials: { api_key: "2" } });
  moveConnection(g2.id, "up");

  const html = await (await app.request("/dashboard/providers/glm")).text();
  assert.ok(html.includes(">Urutan</th>"));
  assert.ok(html.indexOf("GLM Dua") < html.indexOf("GLM Satu"), "tabel terurut berdasarkan prioritas");
  assert.strictEqual((html.match(/action="\/dashboard\/providers\/accounts\/move"/g) || []).length, 2);
  assert.match(html, /title="Prioritas #1">1</);
  assert.match(html, /title="Prioritas #2">2</);
  assert.match(html, /value="up" class="btn btn-ghost" title="Naikkan prioritas" disabled/, "#1 tidak bisa naik");
  assert.match(html, /value="down" class="btn btn-ghost" title="Turunkan prioritas" disabled/, "#2 tidak bisa turun");
});

test("Provider detail - a lone account shows its number without move controls", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Tunggal", credentials: { api_key: "1" } });

  const html = await (await app.request("/dashboard/providers/glm")).text();
  assert.match(html, /title="Prioritas #1">1</);
  assert.ok(!html.includes('action="/dashboard/providers/accounts/move"'));
});

test("POST /dashboard/providers/accounts/move - reorders and redirects to the account's provider", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "G1", credentials: { api_key: "1" } });
  const g2 = addConnection({ provider: "glm", name: "G2", credentials: { api_key: "2" } });

  // The provider field is a hint only; the redirect follows the account itself.
  const res = await app.request("/dashboard/providers/accounts/move", {
    method: "POST",
    body: form({ id: g2.id, provider: "mistral", direction: "up" }),
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/glm?notice=account_moved");
  assert.deepStrictEqual(order("glm"), [["G2", 1], ["G1", 2]]);

  const page = await (await app.request(res.headers.get("location"))).text();
  assert.ok(page.includes("Urutan akun diperbarui."));

  const refused = await app.request("/dashboard/providers/accounts/move", {
    method: "POST",
    body: form({ id: g2.id, provider: "glm", direction: "up" }),
  });
  assert.strictEqual(refused.headers.get("location"), "/dashboard/providers/glm", "langkah ditolak tanpa notice");

  const unknown = await app.request("/dashboard/providers/accounts/move", {
    method: "POST",
    body: form({ id: 9999, provider: "glm", direction: "up" }),
  });
  assert.strictEqual(unknown.status, 302);
  assert.deepStrictEqual(order("glm"), [["G2", 1], ["G1", 2]]);
});

test("Settings - account rotation is gone from the page and from saving", async () => {
  initDb(":memory:");
  setSetting("account_rotation", "sticky");

  const html = await (await app.request("/dashboard/settings")).text();
  assert.ok(!html.includes("account_rotation"));
  assert.ok(!html.includes("Strategi Rotasi Akun"));
  assert.ok(html.includes("combo_round_robin_count"), "kartu Account Selection tetap memuat batas giliran combo");

  const res = await app.request("/dashboard/settings", {
    method: "POST",
    body: form({ account_rotation: "lru", combo_round_robin_count: 2 }),
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(getSetting("account_rotation"), "sticky", "nilai lama dibiarkan, tidak ditulis ulang");
  assert.strictEqual(getSetting("combo_round_robin_count"), "2");
});
