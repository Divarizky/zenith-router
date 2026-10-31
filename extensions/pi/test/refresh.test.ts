import test from "node:test";
import assert from "node:assert/strict";
import { createModelRefresher } from "../src/refresh.ts";

function harness(overrides: Partial<Parameters<typeof createModelRefresher>[0]> = {}) {
  let clock = 1_000_000;
  let fetches = 0;
  const writes: string[][] = [];
  let cache: string[] = [];
  let fetchImpl: () => Promise<string[]> = async () => ["live-a"];
  const keysSeen: (string | undefined)[] = [];
  const refresher = createModelRefresher({
    fetchIds: ({ apiKey }) => {
      fetches++;
      keysSeen.push(apiKey);
      return fetchImpl();
    },
    readCache: () => cache,
    writeCache: (ids) => {
      writes.push([...ids]);
      cache = [...ids];
    },
    now: () => clock,
    intervalMs: 60_000,
    ...overrides,
  });
  return {
    refresher,
    fetches: () => fetches,
    keysSeen,
    writes,
    advance: (ms: number) => { clock += ms; },
    setFetch: (fn: () => Promise<string[]>) => { fetchImpl = fn; },
    setCache: (ids: string[]) => { cache = ids; },
  };
}

const online = { allowNetwork: true } as const;

test("gateway hidup: daftar live dipakai dan disimpan ke cache", async () => {
  const h = harness();
  const result = await h.refresher.refresh(online);
  assert.deepEqual(result, { source: "live", ids: ["live-a"] });
  assert.deepEqual(h.writes, [["live-a"]]);
});

test("gateway mati: jatuh ke cache terakhir tanpa melempar error", async () => {
  const h = harness();
  h.setCache(["kemarin-a"]);
  h.setFetch(async () => { throw new Error("connection refused"); });
  const result = await h.refresher.refresh(online);
  assert.deepEqual(result, { source: "cache", ids: ["kemarin-a"] });
  assert.deepEqual(h.writes, [], "kegagalan tidak boleh menimpa cache");
});

test("gateway mati dan belum pernah ada cache: jatuh ke fallback", async () => {
  const h = harness();
  h.setFetch(async () => { throw new Error("timeout"); });
  const result = await h.refresher.refresh(online);
  assert.equal(result.source, "fallback");
  assert.ok(result.ids.length > 0, "fallback harus berisi minimal satu model");
});

test("permintaan bersamaan berbagi satu fetch ke gateway", async () => {
  const h = harness();
  let release: () => void = () => {};
  h.setFetch(() => new Promise<string[]>((resolve) => { release = () => resolve(["live-a"]); }));
  const first = h.refresher.refresh(online);
  const second = h.refresher.refresh(online);
  release();
  await Promise.all([first, second]);
  assert.equal(h.fetches(), 1, "dua pemanggilan serentak harus memicu satu request");
});

test("refresh dalam interval tidak menyentuh gateway, sedangkan force selalu mengambil ulang", async () => {
  const h = harness();
  await h.refresher.refresh(online);
  await h.refresher.refresh(online);
  assert.equal(h.fetches(), 1, "masih dalam interval, harus memakai hasil terakhir");

  h.advance(60_001);
  await h.refresher.refresh(online);
  assert.equal(h.fetches(), 2, "setelah interval, fetch harus berjalan lagi");

  await h.refresher.refresh({ allowNetwork: true, force: true });
  assert.equal(h.fetches(), 3, "force harus melewati pembatas interval");
});

test("tanpa izin jaringan (startup offline) tidak ada request sama sekali", async () => {
  const h = harness();
  h.setCache(["cache-a"]);
  const result = await h.refresher.refresh({ allowNetwork: false });
  assert.deepEqual(result, { source: "cache", ids: ["cache-a"] });
  assert.equal(h.fetches(), 0);
});

test("current() memberi hasil cache sebelum refresh pertama, untuk pendaftaran awal", () => {
  const h = harness();
  h.setCache(["cache-a"]);
  assert.deepEqual(h.refresher.current(), { source: "cache", ids: ["cache-a"] });
});

test("API key dari Pi diteruskan ke fetch gateway, dan refresh tanpa key tidak membawa key", async () => {
  const h = harness();
  await h.refresher.refresh({ allowNetwork: true, apiKey: "zr_contoh", force: true });
  await h.refresher.refresh({ allowNetwork: true, force: true });
  assert.deepEqual(h.keysSeen, ["zr_contoh", undefined]);
});
