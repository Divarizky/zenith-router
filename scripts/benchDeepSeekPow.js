#!/usr/bin/env node
/**
 * Measure how long the vendored PoW solver blocks the event loop.
 *
 * The solver runs synchronously inside the WASM call, so this is the number that
 * decides whether TASK-75 needs a worker thread. The fixture uses the vendor
 * README challenge (difficulty 144000), which matches what the web client asks
 * for in practice.
 *
 * Usage: node scripts/benchDeepSeekPow.js [runs]
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { solvePowChallenge } from "../src/services/deepseekWeb/pow.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(readFileSync(join(root, "tests/fixtures/deepseekWeb/pow-challenge.json"), "utf8"));
const runs = Math.max(1, Number.parseInt(process.argv[2] || "20", 10) || 20);

const samples = [];
for (let i = 0; i < runs; i++) {
  const started = process.hrtime.bigint();
  await solvePowChallenge(fixture);
  samples.push(Number(process.hrtime.bigint() - started) / 1e6);
}

samples.sort((a, b) => a - b);
const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
const fmt = (ms) => `${ms.toFixed(1)}ms`;

console.log(`difficulty=${fixture.difficulty} runs=${runs} node=${process.version}`);
console.log(`min=${fmt(samples[0])} p50=${fmt(at(0.5))} p95=${fmt(at(0.95))} max=${fmt(samples.at(-1))}`);
console.log("Jalankan di worker thread bila p95 mendekati atau melewati 50ms.");
