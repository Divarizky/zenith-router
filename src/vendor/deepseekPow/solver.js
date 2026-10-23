/**
 * DeepSeekHashV1 proof-of-work solver.
 *
 * Adapted from @rezaparsian/deepseek-pow-solver 1.0.1 (MIT,
 * https://github.com/RezaParsian/DeepseekPowsolver), which wraps the
 * wasm-bindgen build of DeepSeek's own solver. The algorithm, memory layout, and
 * return-region reads are unchanged; only the module format moved from CommonJS
 * to ESM so it can be imported without a bundler. The WASM binary is vendored
 * next to this file as deepseek-pow.wasm.
 *
 * The module needs no imports and no native build: Node instantiates it with an
 * empty import object.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_WASM_PATH = fileURLToPath(new URL("./deepseek-pow.wasm", import.meta.url));

function getUint8Memory(wasm, cache) {
  if (cache.uint8 === null || cache.uint8.buffer !== wasm.memory.buffer) {
    cache.uint8 = new Uint8Array(wasm.memory.buffer);
  }
  return cache.uint8;
}

function getDataView(wasm, cache) {
  if (cache.view === null || cache.view.buffer !== wasm.memory.buffer) {
    cache.view = new DataView(wasm.memory.buffer);
  }
  return cache.view;
}

function passStringToWasm(wasm, cache, str) {
  const bytes = new TextEncoder().encode(str);
  const ptr = wasm.__wbindgen_export_0(bytes.length, 1) >>> 0;
  getUint8Memory(wasm, cache).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

function solvePow(wasm, cache, algorithm, challenge, salt, difficulty, expireAt) {
  if (algorithm !== "DeepSeekHashV1") {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }

  const prefix = `${salt}_${expireAt}_`;
  const stackPtr = wasm.__wbindgen_add_to_stack_pointer(-16);

  try {
    const challengePtr = passStringToWasm(wasm, cache, challenge);
    const prefixPtr = passStringToWasm(wasm, cache, prefix);

    wasm.wasm_solve(stackPtr, challengePtr.ptr, challengePtr.len, prefixPtr.ptr, prefixPtr.len, difficulty);

    const status = getDataView(wasm, cache).getInt32(stackPtr + 0, true);
    const answer = getDataView(wasm, cache).getFloat64(stackPtr + 8, true);

    if (status === 0) throw new Error("No solution found (WASM returned 0)");
    return answer;
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
}

export class DeepSeekPowSolver {
  constructor(wasmPath = DEFAULT_WASM_PATH) {
    this.wasmPath = wasmPath;
    this.wasm = null;
    this.cache = { uint8: null, view: null };
  }

  async init() {
    const wasmBuffer = readFileSync(this.wasmPath);
    const { instance } = await WebAssembly.instantiate(wasmBuffer, { wbg: {} });
    this.wasm = instance.exports;
    return this;
  }

  /** Solve one challenge. Returns the f64 answer exactly as the WASM produced it. */
  solve(challengeData) {
    if (!this.wasm) throw new Error("WASM not initialized. Call init() first.");
    return solvePow(
      this.wasm,
      this.cache,
      challengeData.algorithm,
      challengeData.challenge,
      challengeData.salt,
      challengeData.difficulty,
      challengeData.expire_at
    );
  }
}
