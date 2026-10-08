import test from "node:test";
import assert from "node:assert";
import { initDb, addConnection, getConnectionById } from "../src/db/index.js";
import { app } from "../src/index.js";
import { isModelDisabled, listCustomModels } from "../src/services/modelOverrides.js";

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

test("GET /dashboard/providers - groups providers by category and marks noAuth as Ready", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Main", credentials: { api_key: "k_test" } });

  const res = await app.request("/dashboard/providers");
  assert.strictEqual(res.status, 200);
  assert.ok(res.headers.get("content-type")?.includes("text/html"));

  const html = await res.text();
  assert.ok(html.includes("OAuth Providers"));
  assert.ok(html.includes("Free Tier Providers"));
  assert.ok(html.includes("OpenCode Free"));
  assert.ok(html.includes("Siap"));
  assert.ok(html.includes("1 Terhubung"));
  assert.ok(html.includes("/dashboard/providers/opencode"));
});

test("GET /dashboard/connections and /dashboard/models redirect to providers", async () => {
  for (const path of ["/dashboard/connections", "/dashboard/models"]) {
    const res = await app.request(path);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/dashboard/providers");
  }
});

test("GET /dashboard/providers/:id - shows accounts and models for one provider", async () => {
  initDb(":memory:");
  addConnection({ provider: "glm", name: "GLM Main", credentials: { api_key: "k_test" } });

  const res = await app.request("/dashboard/providers/glm");
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("GLM Main"));
  assert.ok(html.includes("Tambah Akun"));
  assert.ok(html.includes("glm/glm-4-flash"));
  assert.ok(html.includes("Add Custom Model"));

  const unknown = await app.request("/dashboard/providers/does-not-exist");
  assert.strictEqual(unknown.status, 302);
  assert.strictEqual(unknown.headers.get("location"), "/dashboard/providers");
});

test("GET /dashboard/providers/opencode - noAuth provider hides the add account form", async () => {
  initDb(":memory:");
  const html = await (await app.request("/dashboard/providers/opencode")).text();
  assert.ok(html.includes("tidak butuh akun"));
  assert.ok(!html.includes("openModal('add-account-modal')"));
});

test("POST /dashboard/providers/accounts/add - creates account and redirects to provider page", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/providers/accounts/add", {
    method: "POST",
    body: form({
      provider: "claude",
      name: "Claude Work",
      auth_type: "apikey",
      api_key: "sk-ant-test12345",
      proxy_url: "http://127.0.0.1:1080",
    }),
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/claude?notice=account_added");

  const html = await (await app.request(res.headers.get("location"))).text();
  assert.ok(html.includes("Claude Work"));
  assert.ok(html.includes("127.0.0.1:1080"));
  assert.ok(html.includes("Akun berhasil ditambahkan."));
});

test("POST /dashboard/providers/accounts/delete - deletes account and redirects", async () => {
  initDb(":memory:");
  const conn = addConnection({ provider: "codex", name: "Temporary Account", credentials: { api_key: "temp" } });

  const res = await app.request("/dashboard/providers/accounts/delete", {
    method: "POST",
    body: form({ id: String(conn.id), provider: "codex" }),
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/codex?notice=account_deleted");
  assert.strictEqual(getConnectionById(conn.id), null);
});

test("POST /dashboard/providers/models/* - disable, enable, and custom model actions", async () => {
  initDb(":memory:");

  let res = await app.request("/dashboard/providers/models/disable", {
    method: "POST",
    body: form({ provider: "glm", model_id: "glm-4-flash" }),
  });
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/glm?notice=model_disabled");
  assert.ok(isModelDisabled("glm", "glm-4-flash"));

  res = await app.request("/dashboard/providers/models/enable", {
    method: "POST",
    body: form({ provider: "glm", model_id: "glm-4-flash" }),
  });
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/glm?notice=model_enabled");
  assert.ok(!isModelDisabled("glm", "glm-4-flash"));

  res = await app.request("/dashboard/providers/models/custom/add", {
    method: "POST",
    body: form({ provider: "glm", model_id: "glm-4-thinking", name: "GLM 4 Thinking" }),
  });
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/glm?notice=custom_added");
  const custom = listCustomModels();
  assert.strictEqual(custom.length, 1);
  const html = await (await app.request("/dashboard/providers/glm")).text();
  assert.ok(html.includes("glm/glm-4-thinking"));

  res = await app.request("/dashboard/providers/models/custom/delete", {
    method: "POST",
    body: form({ id: String(custom[0].id), provider: "glm" }),
  });
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers/glm?notice=custom_deleted");
  assert.strictEqual(listCustomModels().length, 0);
});

test("POST actions with an unknown provider redirect to the providers list", async () => {
  initDb(":memory:");
  const res = await app.request("/dashboard/providers/accounts/add", {
    method: "POST",
    body: form({ provider: "https://evil.example", name: "x", api_key: "y" }),
  });
  assert.strictEqual(res.headers.get("location"), "/dashboard/providers");
});

test("Provider detail pages link to the vendor API key page", async () => {
  initDb(":memory:");
  const expected = {
    xkiro: "https://xkiro.com/dashboard/api/keys",
    openrouter: "https://openrouter.ai/keys",
    mistral: "https://console.mistral.ai/api-keys",
    glm: "https://z.ai/manage-apikey/apikey-list",
  };
  for (const [id, url] of Object.entries(expected)) {
    const html = await (await app.request(`/dashboard/providers/${id}`)).text();
    assert.ok(html.includes(`href="${url}"`), `${id} harus punya link ${url}`);
    assert.ok(html.includes('target="_blank"') && html.includes('rel="noopener noreferrer"'));
  }
  // Provider tanpa keyUrl tidak menampilkan link.
  const kiro = await (await app.request("/dashboard/providers/kiro")).text();
  assert.ok(!kiro.includes(`class="key-link"`));
});
