# zenroute

Gateway AI personal ultra-ringan (<5 MB) yang kompatibel dengan protokol OpenAI, Anthropic, dan Responses API, dirancang khusus untuk agent coding (Pi, Claude Code, Cursor, Codex).

Disederhanakan dari arsitektur 9router dan OmniRoute dengan membuang bloatware dan hanya mempertahankan fitur esensial.

---

## Spesifikasi Teknis

- **Runtime**: Node.js 22+ (ESM murni)
- **HTTP Engine**: Hono + `@hono/node-server`
- **Database**: `node:sqlite` (DatabaseSync bawaan Node, tanpa kompilasi native C++)
- **Dashboard**: Hono JSX (SSR) + HTMX/Vanilla JS (tanpa build step React/Next.js)
- **Port Default**: `20128` (kompatibel langsung dengan ekstensi Pi `9router.ts`)
- **Total Footprint**: ~3–5 MB disk, RAM idle ~25–40 MB

---

## 5 Fitur Utama (Merged Architecture)

### 1. Gateway
- Endpoint: `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models`.
- Streaming SSE & non-streaming support.
- Hub-and-Spoke translator (pivot lewat OpenAI format).
- Combo routing: `fallback` (berurutan) dan `round-robin` + sticky session.
- Mengadopsi ide OmniRoute: Circuit breaker provider sederhana + auto-retry koneksi sebelum emisi byte pertama.

### 2. Connections (Providers & Proxy Pool)
- 8 provider esensial:
  - **OAuth**: Claude, Codex, GitHub (Copilot), Kiro, Antigravity, GLM
  - **Free**: Opencode, Kilocode
  - **Custom**: OpenAI-compatible & Anthropic-compatible nodes
- Token refresh otomatis di background.
- Konfigurasi proxy pool terintegrasi langsung per-koneksi (`proxy_url`).

### 3. Usage & Quota
- Tracking token in/out per request dari SSE header/footer.
- Sinkronisasi sisa kuota live per provider.
- Penyimpanan ringkas di SQLite (`usage_history`, `quota_cache`).

### 4. Token Saver
- In-process engine:
  - **RTK (Reduced Token Kit)**: Pemadatan context & dedup baris log/diff.
  - **Caveman**: Kompaksi system prompt instruksi panjang.

### 5. Settings
- 1 tabel SQLite / JSON config untuk semua pengaturan:
  - API key access guard (`requireApiKey`).
  - Default routing fallback model.
  - Toggle token saver.
  - Header overrides.

---

## Struktur Folder

```
zenroute/
├── src/
│   ├── index.js               # Entry point Hono server & route definitions
│   ├── db/
│   │   ├── index.js           # Inisialisasi node:sqlite & migrations
│   │   └── schema.sql         # Skema tabel (connections, usage, settings, combos)
│   ├── gateway/
│   │   ├── chat.js            # Handler /v1/chat/completions
│   │   ├── messages.js        # Handler /v1/messages (Claude)
│   │   ├── responses.js       # Handler /v1/responses
│   │   └── models.js          # Handler /v1/models
│   ├── translator/
│   │   ├── index.js           # Hub-and-spoke translation engine
│   │   └── formats/           # Converter (claude, gemini, kiro, openai)
│   ├── providers/
│   │   ├── index.js           # Provider registry loader
│   │   ├── registry/          # 8 file registry provider pilihan
│   │   └── oauth/             # OAuth flows (PKCE, device code, refresh)
│   ├── executors/
│   │   ├── base.js            # Base executor (fetch, timeout, retry, proxy)
│   │   ├── default.js         # Default executor
│   │   └── special/           # Executor khusus (kiro, codex, antigravity, github)
│   ├── services/
│   │   ├── auth.js            # Credential resolver & account fallback
│   │   ├── combo.js           # Combo fallback & round-robin
│   │   ├── usage.js           # Usage & quota recorder
│   │   ├── tokenSaver.js      # RTK & Caveman pipeline
│   │   └── backgroundRefresh.js # Token refresher background loop
│   └── ui/
│       ├── layout.js          # Hono JSX base layout
│       └── pages/             # Dashboard, connections, usage, settings
├── public/                    # Static CSS & icon assets
├── package.json
└── README.md
```

---

## Rencana Implementasi

1. **Fase 1**: Scaffold core Hono server, SQLite DB, dan Base Gateway (`/v1/models`, `/v1/chat/completions`).
2. **Fase 2**: Porting Registry & Executor untuk 8 provider utama + Hub Translator.
3. **Fase 3**: OAuth flow handler & loop refresh token background.
4. **Fase 4**: Integrasi Combo routing, Account fallback, dan Token Saver (RTK).
5. **Fase 5**: Dashboard UI sederhana berbasis Hono JSX + Tailwind.
