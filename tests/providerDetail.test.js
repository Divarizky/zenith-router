
import test from "node:test";
import assert from "node:assert";
import { app } from "../src/index.js";
import { initDb, addConnection, setConnectionCooldown } from "../src/db/index.js";

test("GET /dashboard/providers/:id - baris akun menampilkan identitas dari bootstrap Claude", async () => {
  initDb(":memory:");
  addConnection({
    provider: "claude",
    name: "Claude Akun 1",
    auth_type: "oauth",
    credentials: {
      access_token: "sk-ant-oat01-x",
      account_email: "acc@example.com",
      organization_name: "Acme Inc",
      organization_rate_limit_tier: "default",
    },
  });

  const html = await (await app.request("/dashboard/providers/claude")).text();
  assert.ok(html.includes("acc@example.com"), "email akun tampil");
  assert.ok(html.includes("Acme Inc"), "nama organisasi tampil");
  assert.ok(html.includes("tier default"), "tier rate limit tampil");
});

test("GET /dashboard/providers/:id - selection is behind a toggle button and rows are clickable", async () => {
  initDb(":memory:");

  const res = await app.request("/dashboard/providers/glm");
  assert.strictEqual(res.status, 200);
  const html = await res.text();

  assert.ok(html.includes('data-select-mode-toggle="models"'), "mode toggle button exists");
  assert.ok(html.includes(">Pilih Model<"), "button reads Pilih Model while selection is off");
  assert.ok(html.includes('data-sync-row="models"'), "model table is select-mode aware");
  assert.ok(html.includes('class="model-row'), "model rows are clickable");
});

test("GET /dashboard/providers/:id - model rows show thinking and vision icons from capabilities", async () => {
  initDb(":memory:");

  const html = await (await app.request("/dashboard/providers/codex")).text();
  const icons = (modelId) => {
    const row = html.split("\n").find((line) => line.includes(`/${modelId}</code>`));
    return row || "";
  };

  // gpt-6.1-sol: vision + reasoning.
  const gemini = icons("gpt-6.1-sol");
  assert.ok(gemini.includes("cap-icons"), "icons are rendered");
  assert.ok(gemini.includes("mendukung thinking"), "brain icon has a thinking tooltip");
  assert.ok(gemini.includes("baca gambar"), "eye icon has a vision tooltip");

  const page = await (await app.request("/dashboard/providers/together")).text();
  const textModel = page.split("\n").find((line) => line.includes("/meta-llama/Llama-3.3-70B-Instruct-Turbo</code>")) || "";
  assert.ok(!textModel.includes("cap-icons"), "text-only model shows no icons");
});

// A rate limit on one model no longer takes the whole account down, so the
// dashboard must not count it as unhealthy or paint a Cooldown pill.
test("Dashboard - a model scoped cooldown does not mark the account as down", async () => {
  initDb(":memory:");
  const conn = addConnection({
    provider: "together",
    name: "Together Acc",
    credentials: { api_key: "[REDACTED:credential_assignment]" },
  });
  setConnectionCooldown(conn.id, Date.now() + 60000, "meta-llama/Llama-3.3-70B-Instruct-Turbo");

  const scoped = await (await app.request("/dashboard/providers/together")).text();
  assert.ok(!scoped.includes(">Cooldown<"), "lock satu model bukan outage akun");
  assert.ok(!scoped.includes("Habis Kuota"));

  const overview = await (await app.request("/dashboard")).text();
  assert.ok(!overview.includes(">Cooldown<"));

  // Lock seluruh koneksi tetap harus terlihat sebagai Cooldown.
  setConnectionCooldown(conn.id, Date.now() + 60000, null);
  const full = await (await app.request("/dashboard/providers/together")).text();
  assert.ok(full.includes(">Cooldown<"), "lock penuh harus tampil sebagai Cooldown");
});

test("GET /dashboard/providers/:id - light theme styles, no lime text on light surfaces, and red color policy", async () => {
  initDb(":memory:");
  addConnection({
    provider: "glm",
    name: "GLM Light Test",
    credentials: { api_key: "sk-test-light-123456" },
  });

  const html = await (await app.request("/dashboard/providers/glm")).text();

  // 1. Light theme card & surface overrides
  assert.ok(html.includes("[data-theme=\"light\"] .main .provider-chassis-card"), "light theme card override exists");
  assert.ok(html.includes("[data-theme=\"light\"] .main .subnav-bar"), "light theme subnav override exists");
  assert.ok(!html.includes("fusion-highlights-card"), "fusion highlights explanation card is removed");
  assert.ok(html.includes("[data-theme=\"light\"] .hw-screw"), "light theme screw override exists");
  assert.ok(html.includes("[data-theme=\"light\"] .chassis-telemetry-strip"), "light theme telemetry override exists");
  assert.ok(html.includes("[data-theme=\"light\"] .tag-status-operational"), "light theme operational tag override exists");
  assert.ok(html.includes("[data-theme=\"light\"] .meter-unit.on"), "light theme meter unit override exists");

  // 2. Eliminate inline lime text on light backgrounds
  assert.ok(!html.includes('style="color: var(--accent-lime, #ccff00); font-weight: 900;">NODE:'), "NODE status uses CSS class instead of inline lime");
  assert.ok(!html.includes('style="color: var(--accent-lime, #ccff00);">'), "telemetry load uses CSS class instead of inline lime");
  assert.ok(html.includes('class="chassis-node-status"'), "NODE status class rendered");
  assert.ok(html.includes('class="telemetry-load-pct"'), "load percentage class rendered");
  assert.ok(html.includes('class="telemetry-value telemetry-load-value"'), "load value class rendered");
  assert.ok(html.includes("[data-theme=\"light\"] .chassis-node-status"), "light theme emerald color for NODE status");
  assert.ok(html.includes("[data-theme=\"light\"] .arcade-display-number"), "light theme black color for arcade display");

  // 3. Reasoning capability icon is neutralized (not pink/red #db2777) while tag-thinking badge stays intact
  assert.ok(html.includes(".rack-table .cap-icon.is-reasoning"), "reasoning icon color neutralized in model table");
  assert.ok(html.includes("tag-thinking"), "neobrutalist THINKING badge class present");

  // 4. Required form IDs, hidden inputs, and data attributes preserved
  assert.ok(html.includes('id="concurrency-form"'), "concurrency form id preserved");
  assert.ok(html.includes('id="models-bulk-form"'), "models bulk form id preserved");
  assert.ok(html.includes('id="model-filter-input"'), "model filter input id preserved");
  assert.ok(html.includes('data-cat-filter="all"'), "data-cat-filter preserved");
  assert.ok(html.includes('data-sync-row="models"'), "data-sync-row preserved");
  assert.ok(html.includes('data-requires-selection="models"'), "data-requires-selection preserved");
});

test("GET /dashboard/providers/:id - scaled-up typography hierarchy and padding preserved", async () => {
  initDb(":memory:");
  addConnection({
    provider: "glm",
    name: "GLM Typography Test",
    credentials: { api_key: "sk-test-typo-123456" },
  });

  const html = await (await app.request("/dashboard/providers/glm")).text();

  // 1. Model table & catalog typography
  assert.match(html, /\.rack-table\s*\{[^}]*font-size:\s*13\.5px;/, "rack table base font-size scaled up");
  assert.match(html, /\.rack-table th\s*\{[^}]*font-size:\s*12px;[^}]*padding:\s*12px 14px;/s, "table header font-size and padding scaled up");
  assert.match(html, /\.rack-table td\s*\{[^}]*padding:\s*11px 14px;/, "table cell padding scaled up");
  assert.match(html, /\.rack-table td code\s*\{[^}]*font-size:\s*13px;/, "model id code font-size scaled up");
  assert.match(html, /\.tag-fusion\s*\{[^}]*font-size:\s*10\.5px;[^}]*padding:\s*3px 7px;/s, "capability badge font-size and padding scaled up");
  assert.match(html, /\.rocker-opt\s*\{[^}]*font-size:\s*11px;[^}]*padding:\s*4px 10px;/s, "rocker switch font-size and padding scaled up");

  // 2. Action buttons
  assert.ok(html.includes('style="padding: 5px 12px; font-size: 11px;" title="Uji koneksi'), "channel strip test button scaled up");
  assert.ok(html.includes('class="btn-nb btn-nb-danger" style="padding: 5px 12px; font-size: 11px;">HAPUS</button>'), "channel strip delete button scaled up");
  assert.ok(html.includes('data-select-mode-toggle="models" style="padding: 5px 12px; font-size: 11px;"'), "toolbar select button scaled up");
  assert.ok(html.includes('font-size: 12px; font-weight: 800; text-transform: uppercase; padding: 8px 14px;">\n              SIMPAN BATAS CONCURRENCY'), "concurrency submit button scaled up");

  // 3. Telemetry strip & chassis metadata
  assert.match(html, /\.telemetry-label\s*\{[^}]*font-size:\s*11px;\s*font-weight:\s*800;/s, "telemetry label scaled up");
  assert.match(html, /\.telemetry-value\s*\{[^}]*font-size:\s*16px;/, "telemetry value scaled up");
  assert.match(html, /\.chassis-meta-line\s*\{[^}]*font-size:\s*12px;/, "chassis metadata scaled up");

  // 4. Waterfall channel strips
  assert.match(html, /\.block-header-title\s*\{[^}]*font-size:\s*13px;/, "block header title scaled up");
  assert.match(html, /\.block-header-sub\s*\{[^}]*font-size:\s*12px;/, "block header subtitle scaled up");
  assert.match(html, /\.stamp-priority-index\s*\{[^}]*width:\s*28px;\s*height:\s*28px;[^}]*font-size:\s*12px;/s, "priority stamp scaled up");
  assert.match(html, /\.account-name-block h4\s*\{[^}]*font-size:\s*14\.5px;/, "account name scaled up");
  assert.match(html, /\.account-sub-key\s*\{[^}]*font-size:\s*11\.5px;/, "account sub key scaled up");
  assert.match(html, /\.proxy-jack-badge\s*\{[^}]*padding:\s*5px 10px;[^}]*font-size:\s*12px;/s, "proxy jack badge scaled up");
  assert.match(html, /\.strip-slot-meter\s*\{[^}]*padding:\s*5px 10px;[^}]*font-size:\s*12px;/s, "slot meter scaled up");
  assert.match(html, /\.meter-unit\s*\{[^}]*width:\s*7px;\s*height:\s*14px;/s, "slot meter unit size scaled up");
  assert.match(html, /\.tag-status\s*\{[^}]*font-size:\s*10\.5px;[^}]*padding:\s*4px 8px;/s, "status tag scaled up");

  // 5. Hardware concurrency module
  assert.match(html, /\.module-title-bar\s*\{[^}]*font-size:\s*12px;/, "module title bar scaled up");
  assert.match(html, /\.stepper-label\s*\{[^}]*font-size:\s*11px;/, "stepper label scaled up");
  assert.match(html, /\.arcade-display-number\s*\{[^}]*font-size:\s*28px;/, "arcade display number scaled up");
  assert.match(html, /\.arcade-btn\s*\{[^}]*width:\s*38px;\s*height:\s*38px;[^}]*font-size:\s*19px;/s, "arcade buttons scaled up");
  assert.match(html, /\.queue-info-card\s*\{[^}]*font-size:\s*11\.5px;/, "queue info card scaled up");

  // 6. Toolbar & filter pills
  assert.match(html, /\.search-cli-input\s*\{[^}]*font-size:\s*12px;\s*padding:\s*7px 12px;/s, "search input scaled up");
  assert.match(html, /\.filter-pill\s*\{[^}]*font-size:\s*11px;[^}]*padding:\s*5px 10px;/s, "filter pill scaled up");
});

test("GET /dashboard/providers/:id - fusion card removed, jargon cleaned, mint #6ee7b7 and neon yellow #ccff00/#facc15 integrated", async () => {
  initDb(":memory:");
  addConnection({
    provider: "glm",
    name: "GLM Mint Test",
    credentials: { api_key: "sk-test-mint-123456" },
  });

  const authHtml = await (await app.request("/dashboard/providers/glm")).text();
  assert.ok(!authHtml.includes("fusion-highlights-card"), "fusion highlights card removed");
  assert.ok(!authHtml.includes("Hardware Concurrency Module"), "Hardware Concurrency Module jargon removed");
  assert.ok(!authHtml.includes("(Batas Sesi Paralel)"), "repeated stepper label removed");
  assert.ok(!authHtml.includes("AUTHENTICATION ROSTER &middot; WATERFALL CHANNEL STRIPS"), "WATERFALL CHANNEL STRIPS jargon removed from heading");
  assert.ok(!authHtml.includes("ROUTING CATALOG"), "ROUTING CATALOG jargon removed");
  assert.ok(authHtml.includes("<span>Batas Sesi Paralel</span>"), "clean concurrency title present");
  assert.ok(authHtml.includes("Maksimal request serentak per akun"), "clean stepper label present");
  assert.ok(authHtml.includes("<span>AUTHENTICATION ROSTER (1)</span>"), "clean auth roster title present");
  assert.ok(authHtml.includes("Prioritas dari atas ke bawah saat jenuh atau cooldown."), "clean auth roster subtitle present");
  assert.ok(authHtml.includes("<span>MODEL DIRECTORY ("), "clean model directory title present");
  const detailStyleStart = authHtml.indexOf("--pd-card-bg:");
  const detailStyleEnd = authHtml.indexOf("</style>", detailStyleStart);
  const detailStyle = authHtml.slice(detailStyleStart, detailStyleEnd);
  assert.ok(detailStyleStart !== -1 && detailStyleEnd !== -1, "provider detail style block found");
  assert.ok(!detailStyle.includes("#16a34a"), "old dark green #16a34a removed from provider detail styles");

  // Mint green (#6ee7b7) for primary operational & active controls
  assert.match(detailStyle, /\.btn-nb-primary\s*\{[^}]*background:\s*#6ee7b7\s*!important;[^}]*color:\s*#000000\s*!important;[^}]*border:\s*2px solid #000000\s*!important;/s, "primary button uses #6ee7b7 with black text and border");
  assert.match(detailStyle, /\.nb-check:checked\s*\{[^}]*background:\s*#6ee7b7\s*!important;/s, "checkbox checked uses #6ee7b7");
  assert.match(detailStyle, /\.tag-status-operational\s*\{[^}]*background:\s*#6ee7b7\s*!important;\s*color:\s*#000000\s*!important;\s*border:\s*1\.5px solid #000000\s*!important;/s, "dark operational tag uses #6ee7b7 with high-contrast black text");
  assert.match(detailStyle, /\[data-theme="light"\]\s*\.tag-status-operational\s*\{[^}]*background:\s*#6ee7b7\s*!important;\s*color:\s*#000000\s*!important;/s, "light operational tag uses #6ee7b7");
  assert.match(detailStyle, /\.meter-unit\.on\s*\{[^}]*background:\s*#6ee7b7\s*!important;/s, "meter unit uses #6ee7b7");
  assert.match(detailStyle, /\.filter-pill\.active\s*\{[^}]*background:\s*#6ee7b7;/s, "filter pill active uses #6ee7b7");
  assert.match(detailStyle, /\.led-dot\s*\{[^}]*background:\s*#6ee7b7;/s, "led dot uses #6ee7b7");

  // Pure monochrome rocker toggle switch in dark and light modes
  assert.match(detailStyle, /\.rocker-toggle\s*\{[^}]*border:\s*2px solid #71717a;[^}]*box-shadow:\s*2px 2px 0 #000000;/s, "dark rocker frame uses monochrome border and shadow");
  assert.match(detailStyle, /\[data-theme="light"\]\s*\.rocker-toggle\s*\{[^}]*border:\s*2px solid #000000;[^}]*box-shadow:\s*2px 2px 0 #000000;/s, "light rocker frame uses black border and shadow");
  assert.match(detailStyle, /\.rocker-opt\s*\{[^}]*background:\s*#282a33;[^}]*color:\s*#a1a1aa;/s, "dark inactive rocker option uses monochrome surface and text");
  assert.match(detailStyle, /\[data-theme="light"\]\s*\.rocker-opt\s*\{[^}]*background:\s*#f4f4f5;[^}]*color:\s*#71717a;/s, "light inactive rocker option uses monochrome surface and text");
  assert.match(detailStyle, /\.rocker-opt\.active\s*\{[^}]*background:\s*#ffffff\s*!important;[^}]*color:\s*#000000\s*!important;/s, "dark active rocker option uses pure white background and black text");
  assert.match(detailStyle, /\[data-theme="light"\]\s*\.rocker-opt\.active\s*\{[^}]*background:\s*#000000\s*!important;[^}]*color:\s*#ffffff\s*!important;/s, "light active rocker option uses pure black background and white text");

  // Neon yellow (#ccff00 / #facc15 / #fde047) for hardware accents & action variation
  assert.match(detailStyle, /\.btn-nb-concurrency,\s*\.btn-nb-neon\s*\{[^}]*background:\s*#ccff00\s*!important;\s*color:\s*#000000\s*!important;\s*border:\s*2px solid #000000\s*!important;/s, "concurrency & custom model buttons use neon yellow #ccff00");
  assert.match(detailStyle, /\.arcade-display-number\s*\{[^}]*color:\s*#ccff00;/s, "arcade display uses #ccff00 in dark mode");
  assert.match(detailStyle, /\[data-theme="light"\]\s*\.arcade-display-number\s*\{[^}]*color:\s*#0a0a0a\s*!important;/s, "arcade display uses high-contrast #0a0a0a in light mode");
  assert.match(detailStyle, /\.arcade-btn:hover\s*\{[^}]*background:\s*#ccff00;/s, "arcade button hover uses #ccff00");
  assert.match(detailStyle, /\.tag-free\s*\{[^}]*background:\s*#ccff00\s*!important;\s*color:\s*#000000\s*!important;\s*border:\s*1\.5px solid #000000\s*!important;/s, "free tag uses #ccff00 with black text and border");
  assert.match(detailStyle, /\.tag-status-cooldown\s*\{[^}]*background:\s*#facc15\s*!important;\s*color:\s*#000000\s*!important;\s*border:\s*1\.5px solid #000000\s*!important;\s*font-weight:\s*900;/s, "cooldown tag uses #facc15 with black bold text");
  assert.match(detailStyle, /\[data-theme="light"\]\s*\.tag-status-cooldown\s*\{[^}]*background:\s*#facc15\s*!important;\s*color:\s*#000000\s*!important;/s, "light cooldown tag uses #facc15 with black text");
  assert.match(detailStyle, /\.tag-custom\s*\{[^}]*background:\s*#fde047\s*!important;\s*color:\s*#000000\s*!important;\s*border:\s*1\.5px solid #000000\s*!important;/s, "custom tag uses neobrutalist yellow sticker");
  assert.match(detailStyle, /\.tag-imported\s*\{[^}]*background:\s*#facc15\s*!important;\s*color:\s*#000000\s*!important;\s*border:\s*1\.5px solid #000000\s*!important;/s, "imported tag uses neobrutalist amber sticker");

  assert.ok(authHtml.includes('class="btn-nb btn-nb-primary" onclick="openModal(\'add-account-modal\')"'), "add account button stays mint primary");
  assert.ok(authHtml.includes('class="btn-nb btn-nb-concurrency"'), "save concurrency button uses btn-nb-concurrency");
  assert.ok(authHtml.includes('class="btn-nb btn-nb-neon" style="padding: 5px 12px; font-size: 11px;" onclick="openModal(\'add-model-modal\')"'), "add custom model button uses btn-nb-neon");

  const noAuthHtml = await (await app.request("/dashboard/providers/opencode")).text();
  assert.ok(!noAuthHtml.includes("Proxy Rotation Module"), "Proxy Rotation Module jargon removed");
  assert.ok(noAuthHtml.includes("<span>Rotasi Proxy</span>"), "clean proxy rotation title present");
  assert.ok(noAuthHtml.includes('class="btn-nb btn-nb-concurrency"'), "save proxy strategy button uses btn-nb-concurrency");
});
