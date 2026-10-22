import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, getConnections, getModelLockUntil } from "../src/db/index.js";
import { setCustomExecutor } from "../src/executors/base.js";

const TRANSIENT_404_BODY = {
  error: {
    code: 404,
    message:
      "models/skimaki-agy-cheap is not found for API version v1main, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.",
    status: "NOT_FOUND",
  },
};

function transientNotFound() {
  return new Response(JSON.stringify(TRANSIENT_404_BODY), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function okResponse(text = "ok") {
  // The Antigravity provider speaks the Gemini format upstream.
  return new Response(
    JSON.stringify({
      response: {
        candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function chat(model) {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

test("Transient 404 - upstream 404 model not found untuk API version dipindah ke akun lain", async () => {
  initDb(":memory:");
  addConnection({ provider: "antigravity", name: "acc-1", credentials: { api_key: "key-1" } });
  addConnection({ provider: "antigravity", name: "acc-2", credentials: { api_key: "key-2" } });

  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      const auth = headers.Authorization || headers.authorization;
      attempts.push(auth);
      return auth === "Bearer key-1" ? transientNotFound() : okResponse("from acc 2");
    },
  });

  try {
    const res = await chat("antigravity/gemini-3.8-flash");
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).choices[0].message.content, "from acc 2");
    assert.deepStrictEqual(attempts, ["Bearer key-1", "Bearer key-2"]);

    const acc1 = getConnections("antigravity").find((c) => c.name === "acc-1");
    assert.strictEqual(getModelLockUntil(acc1.id, "gemini-3.8-flash"), null, "model tidak dikunci");
    assert.strictEqual(acc1.cooldown_until, 0, "akun tidak dik cooldown");
  } finally {
    setCustomExecutor(null);
  }
});

test("Transient 404 - hanya satu akun, diulang ke akun yang sama lalu berhasil", async () => {
  initDb(":memory:");
  addConnection({ provider: "antigravity", name: "acc-1", credentials: { api_key: "key-1" } });

  let calls = 0;
  setCustomExecutor({
    async execute() {
      calls++;
      return calls === 1 ? transientNotFound() : okResponse("retry ok");
    },
  });

  try {
    const res = await chat("antigravity/gemini-3.8-flash");
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).choices[0].message.content, "retry ok");
    assert.strictEqual(calls, 2, "satu retry ke akun yang sama");
  } finally {
    setCustomExecutor(null);
  }
});

test("Transient 404 - tetap dikembalikan setelah batas retry dan akun lain habis", async () => {
  initDb(":memory:");
  addConnection({ provider: "antigravity", name: "acc-1", credentials: { api_key: "key-1" } });

  let calls = 0;
  setCustomExecutor({
    async execute() {
      calls++;
      return transientNotFound();
    },
  });

  try {
    const res = await chat("antigravity/gemini-3.8-flash");
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.match(body.error.message, /skimaki-agy-cheap/);
    assert.strictEqual(calls, 2, "satu percobaan awal plus satu retry");
  } finally {
    setCustomExecutor(null);
  }
});

test("Transient 404 - 404 biasa bukan transient, tidak ada failover", async () => {
  initDb(":memory:");
  addConnection({ provider: "antigravity", name: "acc-1", credentials: { api_key: "key-1" } });
  addConnection({ provider: "antigravity", name: "acc-2", credentials: { api_key: "key-2" } });

  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      attempts.push(headers.Authorization || headers.authorization);
      return new Response(JSON.stringify({ error: { code: 404, message: "Not Found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    const res = await chat("antigravity/gemini-3.8-flash");
    assert.strictEqual(res.status, 404);
    assert.strictEqual(attempts.length, 1, "tidak pindah akun");
  } finally {
    setCustomExecutor(null);
  }
});

test("Transient 404 - status selain 404 dengan pesan yang sama bukan transient", async () => {
  initDb(":memory:");
  addConnection({ provider: "antigravity", name: "acc-1", credentials: { api_key: "key-1" } });
  addConnection({ provider: "antigravity", name: "acc-2", credentials: { api_key: "key-2" } });

  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      attempts.push(headers.Authorization || headers.authorization);
      // The same body, but a 500: a server error, not a missing model.
      return new Response(JSON.stringify(TRANSIENT_404_BODY), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    const res = await chat("antigravity/gemini-3.8-flash");
    assert.strictEqual(res.status, 500);
    assert.strictEqual(attempts.length, 2, "5xx tetap memakai jalur cooldown, bukan jalur transient 404");
  } finally {
    setCustomExecutor(null);
  }
});

test("Transient 404 - provider selain Cloud Code tidak memakai jalur transient", async () => {
  initDb(":memory:");
  addConnection({ provider: "openrouter", name: "acc-1", credentials: { api_key: "key-1" } });
  addConnection({ provider: "openrouter", name: "acc-2", credentials: { api_key: "key-2" } });

  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      attempts.push(headers.Authorization || headers.authorization);
      // The same Google wording, but a provider that does not speak it: the
      // 404 belongs to the request and must be reported as is.
      return new Response(JSON.stringify(TRANSIENT_404_BODY), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  try {
    const res = await chat("openrouter/some/model");
    assert.strictEqual(res.status, 404);
    assert.strictEqual(attempts.length, 1, "tidak pindah akun dan tidak retry");
  } finally {
    setCustomExecutor(null);
  }
});

test("Transient 404 - 404 yang menyebut model yang kita kirim bukan transient", async () => {
  initDb(":memory:");
  addConnection({ provider: "antigravity", name: "acc-1", credentials: { api_key: "key-1" } });
  addConnection({ provider: "antigravity", name: "acc-2", credentials: { api_key: "key-2" } });

  const attempts = [];
  setCustomExecutor({
    async execute({ headers }) {
      attempts.push(headers.Authorization || headers.authorization);
      return new Response(
        JSON.stringify({
          error: {
            code: 404,
            message:
              "models/gemini-3.8-flash is not found for API version v1main, or is not supported for generateContent.",
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  try {
    const res = await chat("antigravity/gemini-3.8-flash");
    assert.strictEqual(res.status, 404);
    assert.strictEqual(attempts.length, 1, "model yang benar-benar hilang tidak di-retry");
  } finally {
    setCustomExecutor(null);
  }
});
