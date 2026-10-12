import test from "node:test";
import assert from "node:assert";
import { initDb } from "../src/db/index.js";
import { setCustomVersionFetcher, resetVersionCache, compareVersions } from "../src/services/version.js";
import { app } from "../src/index.js";
import pkg from "../package.json" with { type: "json" };

initDb(":memory:");

function release(tag) {
  return {
    tag_name: tag,
    html_url: `https://github.com/Divarizky/zenith-router/releases/tag/${tag}`,
    published_at: "2026-10-12T10:00:00Z",
  };
}

test("version - compareVersions orders plain semver numerically", () => {
  assert.strictEqual(compareVersions("0.1.2", "0.1.1"), 1);
  assert.strictEqual(compareVersions("0.1.1", "0.1.2"), -1);
  assert.strictEqual(compareVersions("0.1.2", "0.1.2"), 0);
  assert.strictEqual(compareVersions("v0.10.0", "0.9.9"), 1, "10 > 9 walau teks 9 > 10");
  assert.strictEqual(compareVersions("1.0.0", "0.99.99"), 1);
});

test("version - a newer release turns hasUpdate on", async () => {
  resetVersionCache();
  setCustomVersionFetcher(async () => release("v9.9.9"));

  const data = JSON.parse(await (await app.request("/api/version")).text());
  assert.strictEqual(data.current, pkg.version);
  assert.strictEqual(data.latest, "9.9.9");
  assert.strictEqual(data.tag, "v9.9.9", "tag mentah untuk validasi pola upgrade");
  assert.strictEqual(data.hasUpdate, true);
  assert.strictEqual(data.url, "https://github.com/Divarizky/zenith-router/releases/tag/v9.9.9");
  assert.strictEqual(data.publishedAt, "2026-10-12T10:00:00Z");
});

test("version - the same or an older release never asks for an upgrade", async () => {
  resetVersionCache();
  setCustomVersionFetcher(async () => release(`v${pkg.version}`));
  const same = JSON.parse(await (await app.request("/api/version")).text());
  assert.strictEqual(same.hasUpdate, false);

  resetVersionCache();
  setCustomVersionFetcher(async () => release("0.0.1"));
  const older = JSON.parse(await (await app.request("/api/version")).text());
  assert.strictEqual(older.hasUpdate, false, "rilis lama tidak boleh dianggap pembaruan");
});

test("version - the result is cached for an hour", async () => {
  resetVersionCache();
  let calls = 0;
  setCustomVersionFetcher(async () => {
    calls += 1;
    return release("v9.9.9");
  });

  await app.request("/api/version");
  await app.request("/api/version");
  assert.strictEqual(calls, 1, "fetch GitHub hanya sekali dalam cache hidup");

  resetVersionCache();
  setCustomVersionFetcher(null);
});

test("version - a failing GitHub call degrades to no banner, not an error", async () => {
  resetVersionCache();
  setCustomVersionFetcher(async () => {
    throw new Error("jaringan mati");
  });

  const res = await app.request("/api/version");
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.current, pkg.version);
  assert.strictEqual(data.hasUpdate, false);
  assert.strictEqual(data.latest, null);

  resetVersionCache();
  setCustomVersionFetcher(null);
});

test("version - a malformed release payload is treated as unavailable", async () => {
  resetVersionCache();
  setCustomVersionFetcher(async () => ({ not_a_release: true }));

  const data = JSON.parse(await (await app.request("/api/version")).text());
  assert.strictEqual(data.hasUpdate, false);
  assert.strictEqual(data.latest, null);

  resetVersionCache();
  setCustomVersionFetcher(null);
});
