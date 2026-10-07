import test from "node:test";
import assert from "node:assert";
import { parseFreebuffSources, fetchFreebuffCatalog, setFreebuffCatalogFetch } from "../src/services/freebuffCatalog.js";
import { initDb } from "../src/db/index.js";
import { syncFreeModels } from "../src/services/modelSync.js";
import { getSetting } from "../src/services/settings.js";
import { resolveFreebuffAgent } from "../src/executors/freebuff.js";

const SAMPLE_AGENTS = `
export const FREEBUFF_ROOT_AGENT_ID_BY_MODEL: Record<string, string> = {
  [FREEBUFF_MIMO_V25_MODEL_ID]: 'base2-free-mimo',
  [FREEBUFF_GLM_V53_FLASH_MODEL_ID]: 'base2-free-glm-5-3-flash',
  [FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID]: 'base2-free-deepseek-flash',
  [FREEBUFF_GPT_6_LUNA_MODEL_ID]: 'base2-free-luna-6',
  [FREEBUFF_CUSTOM_NEW_MODEL_ID]: 'base2-free-custom-new',
}
`;

const SAMPLE_MODELS = `
export const FREEBUFF_GLM_V53_FLASH_MODEL_ID = 'z-ai/glm-5.3-flash'
export const FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID = 'deepseek/deepseek-v4-flash'
export const FREEBUFF_GPT_6_LUNA_MODEL_ID = 'openai/gpt-6-luna'
export const FREEBUFF_CUSTOM_NEW_MODEL_ID = 'vendor/custom-new'
export const FREEBUFF_PAUSED_OLD_MODEL_ID = 'vendor/paused-old'

const MIMO_V25_MODEL = {
  id: FREEBUFF_MIMO_V25_MODEL_ID,
  displayName: 'MiMo 2.6 Flash',
  premium: false,
} as const satisfies FreebuffModelOption

const GLM_V53_FLASH_MODEL = {
  id: FREEBUFF_GLM_V53_FLASH_MODEL_ID,
  displayName: 'GLM 5.3 Flash',
  premium: false,
} as const satisfies FreebuffModelOption

const DEEPSEEK_V4_FLASH_MODEL = {
  id: FREEBUFF_DEEPSEEK_V4_FLASH_MODEL_ID,
  displayName: 'DeepSeek V4.1 Flash',
  premium: false,
} as const satisfies FreebuffModelOption

const GPT_6_LUNA_MODEL = {
  id: FREEBUFF_GPT_6_LUNA_MODEL_ID,
  displayName: 'GPT-6 Luna',
  premium: true,
} as const satisfies FreebuffModelOption

const CUSTOM_NEW_MODEL = {
  id: FREEBUFF_CUSTOM_NEW_MODEL_ID,
  displayName: 'Custom New Model',
  premium: false,
} as const satisfies FreebuffModelOption

export const FREEBUFF_PAUSED_FREE_MODEL_IDS = [
  FREEBUFF_PAUSED_OLD_MODEL_ID,
] as const

export const FREEBUFF_PRO_ONLY_EVERY_SURFACE_MODEL_IDS = [
  FREEBUFF_GPT_6_LUNA_MODEL_ID,
]

export const FREEBUFF_MODELS = [
  MIMO_V25_MODEL,
  GLM_V53_FLASH_MODEL,
  DEEPSEEK_V4_FLASH_MODEL,
  GPT_6_LUNA_MODEL,
  CUSTOM_NEW_MODEL,
] as const satisfies readonly FreebuffModelOption[]
`;

test("parseFreebuffSources - parses wire IDs, displays names, agent mappings and excludes pro-only/paused", () => {
  const result = parseFreebuffSources({ agentsText: SAMPLE_AGENTS, modelsText: SAMPLE_MODELS });
  assert.ok(result);
  const ids = result.models.map((m) => m.id);
  assert.deepStrictEqual(ids, [
    "mimo/mimo-v2.5",
    "z-ai/glm-5.3-flash",
    "deepseek/deepseek-v4-flash",
    "vendor/custom-new",
  ]);
  assert.ok(!ids.includes("openai/gpt-6-luna"), "pro-only row excluded");
  assert.strictEqual(result.agentMap["vendor/custom-new"], "base2-free-custom-new");
  assert.strictEqual(result.agentMap["z-ai/glm-5.3-flash"], "base2-free-glm-5-3-flash");
});

test("fetchFreebuffCatalog - handles 304 Not Modified and updates on 200", async (t) => {
  t.after(() => setFreebuffCatalogFetch(null));

  setFreebuffCatalogFetch(async (url, init) => {
    if (init?.headers?.["If-None-Match"] === 'W/"test-etag"') {
      return new Response(null, { status: 304 });
    }
    if (url.endsWith("free-agents.ts")) {
      return new Response(SAMPLE_AGENTS, { status: 200, headers: { etag: 'W/"test-etag"' } });
    }
    if (url.endsWith("freebuff-models.ts")) {
      return new Response(SAMPLE_MODELS, { status: 200, headers: { etag: 'W/"test-etag"' } });
    }
    return new Response("", { status: 404 });
  });

  const res1 = await fetchFreebuffCatalog({ etag: null });
  assert.strictEqual(res1.ok, true);
  assert.strictEqual(res1.models.length, 4);
  assert.strictEqual(res1.etag, 'W/"test-etag"');

  const res2 = await fetchFreebuffCatalog({ etag: 'W/"test-etag"' });
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.notModified, true);
});

test("syncFreeModels for freebuff - writes synced models and dynamic agent map", async (t) => {
  t.after(() => setFreebuffCatalogFetch(null));
  initDb(":memory:");

  setFreebuffCatalogFetch(async (url) => {
    if (url.endsWith("free-agents.ts")) return new Response(SAMPLE_AGENTS, { status: 200, headers: { etag: "e1" } });
    if (url.endsWith("freebuff-models.ts")) return new Response(SAMPLE_MODELS, { status: 200, headers: { etag: "e1" } });
    return new Response("", { status: 404 });
  });

  const res = await syncFreeModels("freebuff");
  assert.deepStrictEqual(res, { code: "synced", count: 4 });

  const agentMapStr = getSetting("freebuff_agent_map");
  assert.ok(agentMapStr);
  const map = JSON.parse(agentMapStr);
  assert.strictEqual(map["vendor/custom-new"], "base2-free-custom-new");

  // resolveFreebuffAgent picks up the dynamically synced map
  assert.strictEqual(resolveFreebuffAgent("vendor/custom-new"), "base2-free-custom-new");
  assert.strictEqual(resolveFreebuffAgent("z-ai/glm-5.3-flash"), "base2-free-glm-5-3-flash");
  assert.strictEqual(resolveFreebuffAgent("unknown/model"), "base2-free");
});
