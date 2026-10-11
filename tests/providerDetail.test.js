
import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb } from "../src/db/index.js";

test("GET /dashboard/providers/:id - selection is behind a toggle button and rows are clickable", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/providers/glm");
  assert.strictEqual(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes('data-select-mode-toggle="models"'), "mode toggle button exists");
  assert.ok(html.includes(">Pilih<"), "button reads Pilih while selection is off");
  assert.ok(html.includes('data-sync-row="models"'), "model table is select-mode aware");
  assert.ok(html.includes('class="model-row'), "model rows are clickable");
});

test("GET /dashboard/providers/:id - model rows show thinking and vision icons from capabilities", async () => {
  initDb(":memory:");

  const html = await (await app.request("/dashboard/providers/antigravity")).text();
  const icons = (modelId) => {
    const row = html.split("\n").find((line) => line.includes(`/${modelId}</code>`));
    return row || "";
  };

  // gemini-3.8-flash-high: vision + reasoning.
  const gemini = icons("gemini-3.8-flash-high");
  assert.ok(gemini.includes("cap-icons"), "icons are rendered");
  assert.ok(gemini.includes("mendukung thinking"), "brain icon has a thinking tooltip");
  assert.ok(gemini.includes("baca gambar"), "eye icon has a vision tooltip");

  const page = await (await app.request("/dashboard/providers/mistral")).text();
  const codestral = page.split("\n").find((line) => line.includes("/codestral-2508</code>")) || "";
  assert.ok(!codestral.includes("cap-icons"), "text-only model shows no icons");
});
