import test from "node:test";
import assert from "node:assert";
import {
  initDb,
  closeDb,
  listCustomProviders,
  getCustomProviderById,
  getCustomProviderByPrefix,
  createCustomProvider,
  updateCustomProvider,
  deleteCustomProvider,
  addConnection,
  getConnections,
} from "../src/db/index.js";
import {
  getProvider,
  getAllProviders,
  resolveModel,
  getAvailableModels,
} from "../src/providers/index.js";
import { addCustomModel } from "../src/services/modelOverrides.js";
import { getImporter } from "../src/services/modelImport.js";
import {
  handleAddCustomProvider,
  handleDeleteCustomProvider,
  renderProvidersPage,
  renderProviderDetailPage,
} from "../src/ui/pages/providers.js";

test("Custom Providers - CRUD in Database", () => {
  initDb(":memory:");

  // 1. Create
  const created = createCustomProvider({
    id: "cp_lmstudio",
    name: "LM Studio Local",
    prefix: "lms",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiType: "openai",
    customHeaders: { "X-Test": "zenith" },
  });

  assert.ok(created, "Custom provider must be created");
  assert.strictEqual(created.id, "cp_lmstudio");
  assert.strictEqual(created.name, "LM Studio Local");
  assert.strictEqual(created.prefix, "lms");
  assert.strictEqual(created.base_url, "http://127.0.0.1:1234/v1");
  assert.strictEqual(created.api_type, "openai");

  // 2. Query list & lookup
  const list = listCustomProviders();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, "cp_lmstudio");

  const byId = getCustomProviderById("cp_lmstudio");
  assert.strictEqual(byId?.name, "LM Studio Local");

  const byPrefix = getCustomProviderByPrefix("LMS"); // Case insensitive
  assert.strictEqual(byPrefix?.id, "cp_lmstudio");

  // 3. Update
  const updated = updateCustomProvider("cp_lmstudio", {
    name: "LM Studio v2",
    baseUrl: "http://127.0.0.1:1234/v2/", // Trailing slash cleaned
  });
  assert.strictEqual(updated?.name, "LM Studio v2");
  assert.strictEqual(updated?.base_url, "http://127.0.0.1:1234/v2");

  // 4. Delete & cascade check
  addConnection({
    provider: "cp_lmstudio",
    name: "Local Acc",
    auth_type: "apikey",
    credentials: { api_key: "dummy" },
  });
  assert.strictEqual(getConnections("cp_lmstudio").length, 1);

  const deleted = deleteCustomProvider("cp_lmstudio");
  assert.strictEqual(deleted, true);
  assert.strictEqual(getCustomProviderById("cp_lmstudio"), null);
  assert.strictEqual(getConnections("cp_lmstudio").length, 0, "Connections should be cascade cleaned");

  closeDb();
});

test("Custom Providers - Registry and Model Resolution", () => {
  initDb(":memory:");

  // Awalnya belum ada
  assert.strictEqual(getProvider("myai"), null);

  // Buat custom provider
  const cp = createCustomProvider({
    id: "cp_custom_claude",
    name: "Custom Claude Relay",
    prefix: "myai",
    baseUrl: "https://my-relay.internal/v1",
    apiType: "claude",
  });
  assert.ok(cp);

  // Terdeteksi lewat getProvider dengan prefix atau id
  const providerByPrefix = getProvider("myai");
  assert.ok(providerByPrefix, "Provider must be found by prefix 'myai'");
  assert.strictEqual(providerByPrefix.id, "cp_custom_claude");
  assert.strictEqual(providerByPrefix.isCustom, true);
  assert.strictEqual(providerByPrefix.format, "claude");
  assert.strictEqual(providerByPrefix.transport.baseUrl, "https://my-relay.internal/v1/messages");

  const providerById = getProvider("cp_custom_claude");
  assert.ok(providerById, "Provider must be found by ID");
  assert.strictEqual(providerById.prefix, undefined);
  assert.deepStrictEqual(providerById.alias, ["myai"]);

  // Masuk dalam getAllProviders()
  const all = getAllProviders();
  const found = all.find((p) => p.id === "cp_custom_claude");
  assert.ok(found, "Custom provider must be present in getAllProviders()");

  // Model resolution via wire prefix syntax: "myai/claude-3-haiku"
  const resolved = resolveModel("myai/claude-3-haiku");
  assert.ok(resolved, "Model string with custom prefix must resolve");
  assert.strictEqual(resolved.provider.id, "cp_custom_claude");
  assert.strictEqual(resolved.targetModel, "claude-3-haiku");

  // Tambahkan custom model ke custom provider ini
  addCustomModel({ provider: "cp_custom_claude", model_id: "qwen-2.5-coder", name: "Qwen 2.5 Coder" });

  // Cek apakah muncul di getAvailableModels({ all: true })
  const models = getAvailableModels({ all: true });
  const customModelEntry = models.find((m) => m.id === "myai/qwen-2.5-coder");
  assert.ok(customModelEntry, "Custom model under custom provider must appear in getAvailableModels");
  assert.strictEqual(customModelEntry.owned_by, "cp_custom_claude");

  // Cleanup
  deleteCustomProvider("cp_custom_claude");
  assert.strictEqual(getProvider("myai"), null);

  closeDb();
});

test("Custom Providers - Dynamic Importer (/models URL resolution)", () => {
  initDb(":memory:");

  createCustomProvider({
    id: "cp_test_import",
    name: "Test Importer",
    prefix: "imp",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiType: "openai",
  });

  const importer = getImporter("cp_test_import");
  assert.ok(importer, "Dynamic importer must be created for custom provider");
  assert.strictEqual(importer.url, "http://127.0.0.1:8000/v1/models");
  assert.strictEqual(importer.public, false);
  assert.strictEqual(importer.useTransportHeaders, true);
  assert.deepStrictEqual(importer.modes, ["all"]);

  // Test parse response /models
  const sampleJson = {
    data: [
      { id: "llama-3-8b", name: "Llama 3 8B" },
      { id: "mistral-7b" },
    ],
  };
  const parsed = importer.parse(sampleJson);
  assert.strictEqual(parsed.length, 2);
  assert.strictEqual(parsed[0].id, "llama-3-8b");
  assert.strictEqual(parsed[1].name, "mistral-7b");

  closeDb();
});

test("Custom Providers - Dashboard Form Actions & UI Rendering", async () => {
  initDb(":memory:");

  // 1. Tambah custom provider via form action
  let redirectUrl = "";
  const mockContextAdd = {
    req: {
      parseBody: async () => ({
        name: "Local vLLM",
        prefix: "vllm",
        base_url: "http://127.0.0.1:8000/v1",
        api_type: "openai",
        custom_headers: '{"X-Auth": "secret"}',
      }),
    },
    redirect: (url) => {
      redirectUrl = url;
      return { status: 302, url };
    },
  };

  await handleAddCustomProvider(mockContextAdd);
  assert.strictEqual(redirectUrl, "/dashboard/providers/cp_vllm?notice=custom_provider_added");

  // 2. Render halaman list providers dan pastikan muncul di kategori Custom Providers
  const listHtml = renderProvidersPage(20128, {});
  assert.ok(listHtml.includes("Custom Providers"), "Section Custom Providers must be rendered");
  assert.ok(listHtml.includes("Local vLLM"), "Provider name must appear in card");
  assert.ok(listHtml.includes("vllm/"), "Prefix badge must appear in card");
  assert.ok(listHtml.includes("+ Custom Provider"), "+ Custom Provider button must exist");

  // 3. Render halaman detail custom provider
  const detailHtml = renderProviderDetailPage(20128, "cp_vllm", {});
  assert.ok(detailHtml, "Detail page must render");
  assert.ok(detailHtml.includes("Hapus Custom Provider"), "Delete button must exist on custom provider detail");

  // 4. Hapus custom provider via action
  const mockContextDel = {
    req: {
      parseBody: async () => ({ provider: "cp_vllm" }),
    },
    redirect: (url) => {
      redirectUrl = url;
      return { status: 302, url };
    },
  };

  await handleDeleteCustomProvider(mockContextDel);
  assert.strictEqual(redirectUrl, "/dashboard/providers?notice=custom_provider_deleted");
  assert.strictEqual(getCustomProviderById("cp_vllm"), null);

  closeDb();
});
