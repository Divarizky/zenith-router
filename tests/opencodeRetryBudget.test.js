import test from "node:test";
import assert from "node:assert";
import {
  OpencodeExecutor,
  resetOpencodeProtocolLanes,
  getOpencodeProtocolLane,
  PROTOCOL_LANE_TTL_MS,
} from "../src/executors/opencode.js";

function protocol400() {
  return new Response(
    JSON.stringify({ error: { type: "ModelProtocolUnsupported", message: "Model does not support this protocol" } }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

test("Retry 400 - token budget tidak dihitung ulang (tanpa inflasi)", async () => {
  resetOpencodeProtocolLanes();
  const calls = [];
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.includes("/chat/completions")) return protocol400();
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "hi" }], max_tokens: 50 }),
  });

  assert.strictEqual(calls[0].body.max_tokens, 5120, "pass pertama: max(50,1024)+4096");
  assert.strictEqual(calls[1].body.max_output_tokens, 5120, "retry: budget dibawa apa adanya, bukan 9216");
  assert.strictEqual(calls[1].body.max_tokens, undefined, "field chat tidak bocor ke lane responses");
});

test("Retry 400 chat->responses - payload dikonversi ke bentuk Responses", async () => {
  resetOpencodeProtocolLanes();
  const calls = [];
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.includes("/chat/completions")) return protocol400();
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({
      model: "big-pickle",
      messages: [{ role: "system", content: "Jawab singkat." }, { role: "user", content: "hi" }],
      max_tokens: 2048,
    }),
  });

  const retryBody = calls[1].body;
  assert.strictEqual(calls[1].url, "https://opencode.ai/inference/v1/responses");
  assert.ok(Array.isArray(retryBody.input), "conversation dikonversi ke input");
  assert.strictEqual("messages" in retryBody, false, "field chat tidak dibawa ke /responses");
  assert.ok(String(retryBody.instructions).includes("Jawab singkat."), "system message jadi instructions");
  assert.strictEqual(retryBody.max_output_tokens, 2048 + 4096, "budget ikut pindah lane tanpa dihitung ulang");
});

test("Retry 400 responses->chat - payload dikonversi ke bentuk chat", async () => {
  resetOpencodeProtocolLanes();
  const calls = [];
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.includes("/responses")) return protocol400();
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/responses",
    method: "POST",
    targetModel: "muse-spark-1.2-contributor-free",
    targetFormat: "openai-responses",
    body: JSON.stringify({
      model: "muse-spark-1.2-contributor-free",
      input: "halo",
      instructions: "Jawab singkat.",
      max_output_tokens: 5000,
    }),
  });

  const retryBody = calls[1].body;
  assert.strictEqual(calls[1].url, "https://opencode.ai/inference/v1/chat/completions");
  assert.ok(Array.isArray(retryBody.messages), "input dikonversi ke messages");
  assert.strictEqual("input" in retryBody, false, "field responses tidak dibawa ke /chat/completions");
  assert.strictEqual(retryBody.messages[0].role, "system");
  assert.ok(retryBody.messages[0].content.includes("Jawab singkat."));
  assert.strictEqual(retryBody.max_tokens, 9096, "max(5000,1024)+4096, sekali hitung");
  assert.strictEqual(retryBody.max_output_tokens, undefined);
});

test("Retry 400 - nama tool alias tetap direstorasi ke klien", async () => {
  resetOpencodeProtocolLanes();
  const executor = new OpencodeExecutor({
    fetchFn: async (url) => {
      if (url.includes("/chat/completions")) return protocol400();
      return new Response(
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "read_client", arguments: "{}" } }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const res = await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "read", description: "custom", parameters: { type: "object", properties: {} } } }],
    }),
  });

  const json = await res.json();
  assert.strictEqual(
    json.choices[0].message.tool_calls[0].function.name,
    "read",
    "alias dari pass pertama tidak boleh hilang saat retry"
  );
});

test("Retry 400 - jalur /messages tidak diflip (bentuk Claude tidak punya lane kembar)", async () => {
  resetOpencodeProtocolLanes();
  const calls = [];
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ error: { type: "ModelProtocolUnsupported", message: "does not support this protocol" } }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const res = await executor.execute({
    url: "https://opencode.ai/inference/v1/messages",
    method: "POST",
    targetModel: "union-alpha",
    targetFormat: "claude",
    body: JSON.stringify({
      model: "union-alpha",
      system: "sys",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }),
  });

  assert.strictEqual(res.status, 400, "400 diteruskan apa adanya");
  assert.strictEqual(calls.length, 1, "tidak ada retry dari jalur /messages");
  assert.strictEqual(getOpencodeProtocolLane("union-alpha"), null, "lane tidak dicatat");
});

test("Retry 400 gagal - lane tidak dicache bila respons retry bukan ok", async () => {
  resetOpencodeProtocolLanes();
  const executor = new OpencodeExecutor({
    fetchFn: async (url) => {
      if (url.includes("/chat/completions")) return protocol400();
      return new Response("Internal Server Error", { status: 500, headers: { "Content-Type": "text/plain" } });
    },
  });

  const res = await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({ model: "retry-fail-model", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.strictEqual(res.status, 500);
  assert.strictEqual(getOpencodeProtocolLane("retry-fail-model"), null, "lane tidak boleh dicache bila retry gagal");
});

test("Lane cache - aktif dalam TTL dan kedaluwarsa setelah TTL lewat", async () => {
  resetOpencodeProtocolLanes();
  const executor = new OpencodeExecutor({
    fetchFn: async (url) => {
      if (url.includes("/chat/completions")) return protocol400();
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({ model: "lane-ttl-model", messages: [{ role: "user", content: "hi" }] }),
  });

  // Masih dalam TTL
  assert.strictEqual(getOpencodeProtocolLane("lane-ttl-model"), "responses");

  // Melewati TTL 1 jam
  const expiredTime = Date.now() + PROTOCOL_LANE_TTL_MS + 1000;
  assert.strictEqual(
    getOpencodeProtocolLane("lane-ttl-model", { now: expiredTime }),
    null,
    "harus kedaluwarsa setelah TTL lewat"
  );
  // Pastikan sudah dihapus dari cache
  assert.strictEqual(getOpencodeProtocolLane("lane-ttl-model"), null);
});

test("Lane cache - resetOpencodeProtocolLanes membersihkan cache", async () => {
  resetOpencodeProtocolLanes();
  const executor = new OpencodeExecutor({
    fetchFn: async (url) => {
      if (url.includes("/chat/completions")) return protocol400();
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({ model: "lane-reset-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.strictEqual(getOpencodeProtocolLane("lane-reset-model"), "responses");
  resetOpencodeProtocolLanes();
  assert.strictEqual(getOpencodeProtocolLane("lane-reset-model"), null);
});

test("Default budget - saat klien tidak mengirim max_tokens, chat lane diinjeksi 131072", async () => {
  resetOpencodeProtocolLanes();
  let capturedBody = null;
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      capturedBody = JSON.parse(init.body);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.strictEqual(capturedBody.max_tokens, 131072, "default max_tokens harus 131072 saat klien tidak kirim");
});

test("Default budget - saat klien tidak mengirim max_output_tokens, responses lane diinjeksi 65536", async () => {
  resetOpencodeProtocolLanes();
  let capturedBody = null;
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      capturedBody = JSON.parse(init.body);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/responses",
    method: "POST",
    targetModel: "big-pickle",
    targetFormat: "openai-responses",
    body: JSON.stringify({ model: "big-pickle", input: [{ type: "message", role: "user", content: "hi" }] }),
  });

  assert.strictEqual(capturedBody.max_output_tokens, 65536, "default max_output_tokens harus 65536 saat klien tidak kirim");
});

test("Default budget - jalur /messages tanpa max_tokens tidak diinjeksi", async () => {
  resetOpencodeProtocolLanes();
  let captured = null;
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      captured = JSON.parse(init.body);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/messages",
    method: "POST",
    targetModel: "big-pickle",
    targetFormat: "claude",
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.strictEqual(captured.max_tokens, undefined);
  assert.strictEqual(captured.max_output_tokens, undefined);
});

test("Default budget - model non-reasoning tanpa max_tokens mendapat batas lane penuh", async () => {
  resetOpencodeProtocolLanes();
  let captured = null;
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      captured = JSON.parse(init.body);
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({ model: "gpt-5-nano", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.strictEqual(captured.max_tokens, 131072);
});

test("Retry 400 - nilai klien di atas ceiling responses di-clamp ke 65536 saat flip", async () => {
  resetOpencodeProtocolLanes();
  const calls = [];
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.includes("/chat/completions")) return protocol400();
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({ model: "gpt-5-nano", messages: [{ role: "user", content: "hi" }], max_tokens: 100000 }),
  });

  assert.strictEqual(calls[0].body.max_tokens, 100000);
  assert.strictEqual(calls[1].body.max_output_tokens, 65536);
  assert.strictEqual(calls[1].body.max_tokens, undefined);
});

test("Default budget - retry flip dari chat ke responses mencap default 131072 ke 65536", async () => {
  resetOpencodeProtocolLanes();
  const calls = [];
  const executor = new OpencodeExecutor({
    fetchFn: async (url, init = {}) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (url.includes("/chat/completions")) return protocol400();
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  await executor.execute({
    url: "https://opencode.ai/inference/v1/chat/completions",
    method: "POST",
    body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "hi" }] }),
  });

  assert.strictEqual(calls[0].body.max_tokens, 131072, "pass-1 chat dapat default 131072");
  assert.strictEqual(calls[1].body.max_output_tokens, 65536, "retry responses di-clamp ke 65536");
  assert.strictEqual(calls[1].body.max_tokens, undefined, "max_tokens dihapus pada lane responses");
});
