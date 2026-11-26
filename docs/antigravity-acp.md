# Antigravity ACP (preview)

The ACP integration is a separate local-agent route, not the existing Antigravity HTTP API executor. It is opt-in and exposes only `agy-acp/gemini-3.8-flash`; the regular `antigravity` provider remains unchanged.

## Safety contract

- ACP is disabled by default. A profile configuration alone does not enable it.
- Accounts are unlimited. Each account stores only a random 32-character hex `id`, a unique `name` (at most 40 characters, compared case-insensitively), and an `enabled` flag. List order is routing order. Duplicate ids or names, non-hex ids, and extra fields are rejected; dashboard input cannot choose a command, arguments, environment, credentials, or working directory.
- An explicit deployment worker map at `~/.config/zenith-router/antigravity-acp-workers.json` has priority and allowlists exact worker IDs/namespaces and absolute launcher/workspace paths. If present, even an empty, malformed, symlinked, or insecure map fails closed; Zenith never falls back to discovery. Only when the map is absent does Zenith auto-discover a trusted `agy` executable and derive one worker per account (`agy-worker-<id>`) with isolated `home`, `appdata`, and `workspace` directories under `~/.config/zenith-router/acp/<id>/`. Each worker runs with `HOME` (and `USERPROFILE`/`APPDATA` on Windows) set to its own folder, `GEMINI_HOME=<home>/.gemini`, and `AGY_ACP_FORCE_FILE_STORAGE=1`, so the Agy token stays in `<home>/.gemini/antigravity-acp/acp_token.json` of that account only. Entries in an explicit map cannot contain arguments, env, or credentials. POSIX candidates must be executable and not group/other-writable; Windows deployments must enforce equivalent ACLs externally. ACP remains opt-in. Zenith does not read tokens/keyrings, switch OS users, or claim isolation has been verified.
- A trusted server-side adapter maps the configured worker ID to a pre-provisioned local worker. The adapter must negotiate ACP v1 explicitly. Zenith sends text-only chat prompts, supports non-streaming JSON and OpenAI-compatible SSE text deltas (bounded to 1 MiB), and rejects tools, generation options, and multimodal content. Filesystem, terminal, and permission requests are denied by the adapter. No quota-based retry or generic Zenith account/model/combo fallback is enabled; only the narrowly documented pre-dispatch worker selection below applies.
- Another account may be tried only after local preflight confirms an account is unavailable, `needs_login`, or limited, or ACP returns the coded `-32000` authentication-required error during initialize/session setup, before `session/prompt`. Any prompt error/disconnect is an unknown outcome and is not replayed.
- Client cancellation uses ACP v1 `session/cancel` with the active `sessionId`. Usage is not reported because the supported ACP surface does not provide a verified Zenith usage contract.

The `/v1/chat/completions` ACP path is intercepted before generic HTTP routing so generic status-based account/model/combo fallback does not reinterpret ACP errors. Streaming emits deltas before `session/prompt` resolves, followed by a finish chunk and `[DONE]`; post-dispatch failures emit a generic SSE error frame and are never replayed. Abort during initialize/session setup prevents prompt dispatch. Abort/disconnect after dispatch sends `session/cancel` and closes the worker transport. Unsupported tools, generation options, and non-text message content fail with a 400 response rather than being silently dropped.

The deployment file is an array with at most 256 entries, for example:

```json
[
  {
    "workerId": "agy-worker-a",
    "namespace": "agy-worker-a",
    "launcher": "/opt/zenith/acp/launch-worker-a",
    "workspace": "/srv/zenith/acp/worker-a"
  }
]
```

Each launcher must itself enforce the separate account/OS sandbox and start an ACP v1 stdio endpoint. For an explicit map, this application does not provision launcher scripts, accounts, keyrings, or sign-in state. When the map is absent, Zenith uses the discovered `agy` binary directly with fixed ACP arguments and isolated data directories; it does not read tokens/keyrings or claim OS-account isolation has been verified.

## Accounts and limits

- Adding an account only creates its folders. The account starts as `needs_login` and is never selected for requests until a login has been verified.
- Login state is read from the presence of a non-empty `acp_token.json` in the account folder. Zenith never reads the file contents.
- Removing an account deletes `acp_token.json` and `acp_business_token.json`, then the account folder, then the list entry. It is refused while a request or login uses the account.
- When Agy answers with the "Usage Limit Reached" text, the account is marked limited in memory until the reset time Agy reported, or for 5 hours when none was reported. Limited accounts are skipped for new requests and become eligible again after the reset. The request that hit the limit is never replayed on another account, because the limit text arrives after `session/prompt`.

## Browser login MVP

The Antigravity provider's **Login via Agy** action is a browser-only bootstrap for one chosen account (an explicitly mapped worker or an automatically derived one). It is separate from the existing **Login via Zenith OAuth** action, which remains available and unchanged.

When the explicit worker map is absent and a safe `agy` binary is discovered, the same binary is used for login with isolated home/app-data directories. An explicit map remains the priority override; add `loginLauncher` to exactly one worker entry to enable login for mapped workers. That launcher must be an externally provisioned, non-group/world-writable executable in the same worker isolation and workspace as `launcher`; it must run `agy acp --login` and print the official Google authorization URL in this documented machine-readable shape:

```text
AGY_LOGIN_URL=https://accounts.google.com/o/oauth2/v2/auth?...
```

Zenith also accepts that same official URL when an Agy version prefixes it with human-readable text. Only `https://accounts.google.com/o/oauth2/v2/auth` (or `/o/oauth2/auth`) URLs with a query string are passed to the browser. URLs supplied by the browser are never accepted. Example deployment entry:

```json
{
  "workerId": "agy-worker-a",
  "namespace": "agy-worker-a",
  "launcher": "/opt/zenith/acp/launch-worker-a",
  "loginLauncher": "/opt/zenith/acp/login-worker-a",
  "workspace": "/srv/zenith/acp/worker-a"
}
```

The dashboard starts the trusted login launcher with server-side fixed arguments and a minimal environment (plus the isolated `HOME`/`USERPROFILE` when provisioned), never browser-selected command, arguments, environment, or cwd. It relays only the short raw authorization code (not a redirect URL) to the original process stdin. Attempts are bound to the authenticated dashboard session, expire after two minutes, accept one submission, and are cleaned up on cancel, timeout, or process failure. A successful process exit is not sufficient: Zenith verifies ACP v1 `initialize` and `session/new` through the worker runtime launcher before marking the account ready. Completion fails closed if the account was removed, the worker mapping changed, or verification failed. Zenith never reads or persists Agy tokens, keyrings, email, or account output.

Live testing is intentionally out of scope for this MVP. Before a real deployment, an administrator must provision and review both launchers, confirm the Agy CLI output shape, ensure the worker's keyring is isolated, and manually complete a browser login on a disposable account. Automated tests use fake child processes and offline ACP fixtures only.
