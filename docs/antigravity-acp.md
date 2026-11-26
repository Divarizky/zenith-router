# Antigravity ACP (preview)

The ACP integration is a separate local-agent route, not the existing Antigravity HTTP API executor. It is opt-in and exposes only `agy-acp/gemini-3.8-flash`; the regular `antigravity` provider remains unchanged.

## Safety contract

- ACP is disabled by default. A profile configuration alone does not enable it.
- At most two profiles are stored. Each profile contains only an opaque allowlisted worker ID, priority, and enabled flag. Duplicate worker IDs and extra fields are rejected; dashboard input cannot choose a command, arguments, environment, credentials, or working directory.
- A deployment-only worker map at `~/.config/zenith-router/antigravity-acp-workers.json` allowlists exact worker IDs/namespaces and absolute launcher/workspace paths. Entries cannot contain arguments, env, or credentials. The launcher must be an externally provisioned executable wrapper, separately sandboxed to its own OS identity, keyring, and workspace; Zenith invokes it with no user-selected arguments and a minimal fixed environment. Missing, malformed, duplicate, noncanonical, or unknown mappings fail closed, as do a map, launcher, or workspace that is writable by group/other on POSIX; Windows deployments must enforce equivalent ACLs for the map and launcher externally. Zenith does not log in, read tokens/keyrings, switch OS users, or claim isolation has been verified.
- A trusted server-side adapter maps the configured worker ID to a pre-provisioned local worker. The adapter must negotiate ACP v1 explicitly. Zenith sends text-only chat prompts, supports non-streaming JSON and OpenAI-compatible SSE text deltas (bounded to 1 MiB), and rejects tools, generation options, and multimodal content. Filesystem, terminal, and permission requests are denied by the adapter. No quota-based retry or generic Zenith account/model/combo fallback is enabled; only the narrowly documented pre-dispatch worker selection below applies.
- A second worker may be tried only after local preflight confirms a worker is unavailable or ACP returns the coded `-32000` authentication-required error during initialize/session setup, before `session/prompt`. Any prompt error/disconnect is an unknown outcome and is not replayed.
- Client cancellation uses ACP v1 `session/cancel` with the active `sessionId`. Usage is not reported because the supported ACP surface does not provide a verified Zenith usage contract.

The `/v1/chat/completions` ACP path is intercepted before generic HTTP routing so generic status-based account/model/combo fallback does not reinterpret ACP errors. Streaming emits deltas before `session/prompt` resolves, followed by a finish chunk and `[DONE]`; post-dispatch failures emit a generic SSE error frame and are never replayed. Abort during initialize/session setup prevents prompt dispatch. Abort/disconnect after dispatch sends `session/cancel` and closes the worker transport. Unsupported tools, generation options, and non-text message content fail with a 400 response rather than being silently dropped.

The deployment file is an array with at most two entries, for example:

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

Each launcher must itself enforce the separate account/OS sandbox and start an ACP v1 stdio endpoint. This application does not provision launcher scripts, accounts, keyrings, or sign-in state. Provisioning and verification of those external controls are production prerequisites.

## Browser login MVP

The Antigravity provider's **Login via Agy** action is a browser-only bootstrap for an already provisioned worker. It is separate from the existing **Login via Zenith OAuth** action, which remains available and unchanged.

To enable the MVP, add `loginLauncher` to exactly one worker entry. The file must be an externally provisioned, non-group/world-writable executable in the same worker isolation and workspace as `launcher`; it must run `agy acp --login` and print the official Google authorization URL in this documented machine-readable shape:

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

The dashboard starts the trusted login launcher with no browser-selected command, arguments, environment, or cwd. It relays only the short raw authorization code (not a redirect URL) to the original process stdin. Attempts are bound to the authenticated dashboard session, expire after two minutes, accept one submission, and are cleaned up on cancel, timeout, or process failure. A successful process exit is not sufficient: Zenith verifies ACP v1 `initialize` and `session/new` through the worker runtime launcher before registering the worker in the ACP profile list. The registration fails closed if the worker mapping changed, verification failed, or both profile slots are occupied. Zenith never reads or persists Agy tokens, keyrings, email, or account output.

Live testing is intentionally out of scope for this MVP. Before a real deployment, an administrator must provision and review both launchers, confirm the Agy CLI output shape, ensure the worker's keyring is isolated, and manually complete a browser login on a disposable account. Automated tests use fake child processes and offline ACP fixtures only.
