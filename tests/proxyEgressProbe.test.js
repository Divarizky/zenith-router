import test from "node:test";
import assert from "node:assert/strict";
import { initDb, addProxyPool, updateProxyPool } from "../src/db/index.js";
import {
  probePoolEgressIp,
  getPoolEgressIp,
  setEgressProbeUrl,
  findDuplicateEgressIps,
  parseIpFromBody,
  validateEgressProbeUrl,
  EGRESS_PROBE_TTL_MS,
} from "../src/services/proxyEgressProbe.js";
import { startEgressHarness } from "./fixtures/egressProbe/harness.mjs";

// Setiap tes memakai DB memori baru. Tes tidak mengubah env global; CA lokal
// dikirim lewat opsi tlsCa ke probe.
function freshDb() {
  initDb(":memory:");
}

test("probe reports the exit IP through the pool transport with zero direct hits", async () => {
  freshDb();
  const h = await startEgressHarness({ exitIp: "127.0.0.2" });
  try {
    setEgressProbeUrl(h.originUrl);
    const pool = addProxyPool({ name: "p", url: h.proxyUrl });
    const result = await probePoolEgressIp(pool.id, { tlsCa: h.caPem });
    assert.equal(result.error, null);
    assert.equal(result.ip, "127.0.0.2");
    assert.equal(h.counts.connect, 1, "probe harus lewat proxy tepat sekali");
    assert.equal(h.counts.origin, 1, "origin hanya dihit sekali oleh probe");
    const stored = getPoolEgressIp(pool.id);
    assert.equal(stored.ip, "127.0.0.2");
    assert.equal(stored.stale, false);
  } finally { h.close(); }
});

test("probe through a dead proxy records an error and never reaches origin directly", async () => {
  freshDb();
  const h = await startEgressHarness();
  try {
    setEgressProbeUrl(h.originUrl);
    const pool = addProxyPool({ name: "mati", url: "http://127.0.0.1:1" });
    const result = await probePoolEgressIp(pool.id, { tlsCa: h.caPem });
    assert.equal(result.ip, null);
    assert.ok(result.error);
    assert.equal(h.counts.origin, 0, "tidak boleh ada hit direct ke origin");
    assert.equal(h.counts.connect, 0);
  } finally { h.close(); }
});

test("probe refuses to run for an inactive pool and sends no request", async () => {
  freshDb();
  const h = await startEgressHarness();
  try {
    setEgressProbeUrl(h.originUrl);
    const pool = addProxyPool({ name: "off", url: h.proxyUrl });
    updateProxyPool(pool.id, { is_active: 0 });
    await assert.rejects(() => probePoolEgressIp(pool.id, { tlsCa: h.caPem }), /nonaktif/);
    assert.equal(h.counts.connect, 0);
    assert.equal(h.counts.origin, 0);
  } finally { h.close(); }
});

test("probe result becomes stale after TTL and after pool config changes", async () => {
  freshDb();
  const h = await startEgressHarness({ exitIp: "127.0.0.2" });
  try {
    setEgressProbeUrl(h.originUrl);
    const pool = addProxyPool({ name: "p", url: h.proxyUrl });
    const t0 = 1_000_000;
    await probePoolEgressIp(pool.id, { tlsCa: h.caPem, now: t0 });
    assert.equal(getPoolEgressIp(pool.id, t0 + 1).stale, false);
    assert.equal(getPoolEgressIp(pool.id, t0 + EGRESS_PROBE_TTL_MS + 1).stale, true);

    await probePoolEgressIp(pool.id, { tlsCa: h.caPem, now: t0 });
    updateProxyPool(pool.id, { url: `${h.proxyUrl}/` });
    assert.equal(getPoolEgressIp(pool.id, t0 + 1).stale, true, "ganti URL proxy = data lama tidak berlaku");
  } finally { h.close(); }
});

test("duplicate exit IPs are reported as diagnosis for fresh results only", async () => {
  freshDb();
  const h = await startEgressHarness({ exitIp: "127.0.0.2" });
  try {
    setEgressProbeUrl(h.originUrl);
    const a = addProxyPool({ name: "a", url: h.proxyUrl });
    const b = addProxyPool({ name: "b", url: h.proxyUrl + "/" });
    const t0 = 2_000_000;
    await probePoolEgressIp(a.id, { tlsCa: h.caPem, now: t0 });
    await probePoolEgressIp(b.id, { tlsCa: h.caPem, now: t0 });
    const dup = findDuplicateEgressIps(t0 + 1);
    assert.equal(dup.length, 1);
    assert.equal(dup[0].ip, "127.0.0.2");
    assert.deepEqual(dup[0].poolIds.sort(), [a.id, b.id].sort());
    assert.equal(findDuplicateEgressIps(t0 + EGRESS_PROBE_TTL_MS + 1).length, 0, "hasil basi tidak dihitung");
  } finally { h.close(); }
});

test("probe URL must be https and must not carry credentials", () => {
  assert.match(validateEgressProbeUrl("http://ip.example/ip"), /https/);
  const withUserinfo = new URL("https://ip.example/ip");
  withUserinfo.username = "uji";
  withUserinfo.password = "uji";
  assert.match(validateEgressProbeUrl(withUserinfo.toString()), /kredensial/);
  assert.equal(validateEgressProbeUrl("https://ip.example/ip"), null);
  assert.throws(() => setEgressProbeUrl("http://ip.example"), /https/);
});

test("parseIpFromBody accepts plain or JSON IPs and rejects other bodies", () => {
  assert.equal(parseIpFromBody("203.0.113.7\n"), "203.0.113.7");
  assert.equal(parseIpFromBody('{"ip":"198.51.100.9"}'), "198.51.100.9");
  assert.equal(parseIpFromBody("2001:DB8::1"), "2001:db8::1");
  assert.equal(parseIpFromBody("<html>error</html>"), null);
  assert.equal(parseIpFromBody("999.1.1.1"), null);
});
