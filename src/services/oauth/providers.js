import crypto from "node:crypto";
import { proxyFetch } from "../../executors/proxy.js";
import { antigravityUserAgent } from "../antigravityIdentity.js";
import { claudeUserAgent } from "../claudeIdentity.js";

// Login flows for OAuth providers, ported from the upstream OAuth provider definitions.
// Client ids are the public ones shipped in each vendor's own CLI/IDE.
//
// Every flow resolves to the same shape so flows.js can store it as a connection:
//   { access_token, refresh_token?, expires_in?, email?, name?, extra? }
// `extra` holds provider-specific credential fields (snake_case, merged into credentials).

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Swap the HTTP client (tests). Pass null to restore global fetch. */
export function setOAuthFetch(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
}

export function oauthFetch(url, init = {}, { proxyUrl = null } = {}) {
  if (proxyUrl) {
    return proxyFetch(url, init, proxyUrl);
  }
  return fetchImpl(url, init);
}

async function readJson(res, label) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function emailFromJwt(jwt) {
  const payload = decodeJwtPayload(jwt);
  return payload?.email || payload?.preferred_username || undefined;
}

export const OAUTH_CONFIG = {
  claude: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scopes: [
      "org:create_api_key",
      "user:profile",
      "user:inference",
      "user:sessions:claude_code",
      "user:mcp_servers",
    ],
    // Anthropic only accepts the official Claude Code redirect for this client
    // id, so the login finishes by pasting the callback URL or code back.
    redirectUri:
      process.env.CLAUDE_CODE_REDIRECT_URI || "https://platform.claude.com/oauth/code/callback",
    bootstrapUrl: "https://api.anthropic.com/api/claude_cli/bootstrap",
  },
  codex: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    // The Codex CLI client only accepts this redirect, so the flow listens on it.
    fixedPort: 1455,
    callbackPath: "/auth/callback",
    extraParams: {
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    },
  },
  antigravity: {
    clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
    clientSecret: "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",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    loadCodeAssistUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    onboardUserUrl: "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser",
  },
  cline: {
    authorizeUrl: "https://api.cline.bot/api/v1/auth/authorize",
    tokenUrl: "https://api.cline.bot/api/v1/auth/token",
    refreshUrl: "https://api.cline.bot/api/v1/auth/refresh",
  },
  github: {
    clientId: "Iv1.b507a08c87ecfe98",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    copilotTokenUrl: "https://api.github.com/copilot_internal/v2/token",
    scopes: "read:user",
    apiVersion: "2022-11-28",
    userAgent: "GitHubCopilotChat/0.26.7",
  },
  kilocode: {
    apiBaseUrl: "https://api.kilo.ai",
    initiateUrl: "https://api.kilo.ai/api/device-auth/codes",
  },
  kiro: {
    startUrl: "https://view.awsapps.com/start",
    clientName: "kiro-oauth-client",
    scopes: ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"],
    grantTypes: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    issuerUrl: "https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6",
    socialRefreshUrl: "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
  },
  glm: {
    providerId: "zai",
    cliInitUrl: "https://zcode.z.ai/api/v1/oauth/cli/init",
    cliPollUrl: "https://zcode.z.ai/api/v1/oauth/cli/poll",
    businessLoginUrl: "https://api.z.ai/api/auth/z/login",
    apiBaseUrl: "https://api.z.ai",
    planApiKeyName: "zcode-api-key",
  },
};

/** Fetch a fresh Copilot API token for a GitHub OAuth token. Used at login and on refresh. */
export async function fetchCopilotToken(githubToken, { proxyUrl = null } = {}) {
  const cfg = OAUTH_CONFIG.github;
  const res = await oauthFetch(cfg.copilotTokenUrl, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/json",
      "X-GitHub-Api-Version": cfg.apiVersion,
      "User-Agent": cfg.userAgent,
    },
  }, { proxyUrl });
  const data = await readJson(res, "Copilot token request");
  if (!data.token) throw new Error("Copilot token response has no token (no Copilot subscription?)");
  return { token: data.token, expiresAt: Number(data.expires_at) * 1000 || Date.now() + 25 * 60 * 1000 };
}

/** Kiro Builder ID tokens carry no profileArn; requests 403 without it. */
export async function fetchKiroProfileArn(accessToken, { proxyUrl = null } = {}) {
  try {
    const res = await oauthFetch("https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ maxResults: 10 }),
    }, { proxyUrl });
    if (!res.ok) return null;
    const data = await res.json();
    return data.profiles?.find((p) => p.arn?.trim())?.arn?.trim() || null;
  } catch {
    return null;
  }
}

const AWS_REGION = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

// ---------------------------------------------------------------------------
// Authorization code flows: buildAuthUrl → user signs in → exchange(code)
// ---------------------------------------------------------------------------

const claude = {
  flowType: "authorization_code",
  pkce: true,
  // Claude redirects to its own callback page, so the login is finished by
  // pasting the callback URL or code back into the dashboard.
  manualOnly: true,
  redirectUri: OAUTH_CONFIG.claude.redirectUri,
  buildAuthUrl({ redirectUri, state, codeChallenge }) {
    const cfg = OAUTH_CONFIG.claude;
    const params = new URLSearchParams({
      code: "true",
      client_id: cfg.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: cfg.scopes.join(" "),
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      // Forces Anthropic to re-authenticate instead of silently reusing the
      // browser session, which otherwise invalidates the previous account's
      // refresh token family for this shared client id.
      prompt: "login",
    });
    return `${cfg.authorizeUrl}?${params}`;
  },
  async exchange({ code, redirectUri, codeVerifier, state, proxyUrl = null }) {
    const cfg = OAUTH_CONFIG.claude;
    // The manual-copy page shows "code#state"; the state part is optional
    // because the flow already knows it.
    const [authCode, ...codeStateParts] = String(code).split("#");
    const codeState = codeStateParts.join("#");
    const res = await oauthFetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // The token endpoint expects the same client identity the CLI sends.
        "User-Agent": claudeUserAgent(),
        "X-App": "cli",
        "Anthropic-Dangerous-Direct-Browser-Access": "true",
      },
      body: JSON.stringify({
        code: authCode,
        state: codeState || state,
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    }, { proxyUrl });
    const t = await readJson(res, "Claude token exchange");
    const tokens = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_in: t.expires_in,
      email: t.account?.email_address,
    };
    const extra = await fetchClaudeBootstrap(tokens.access_token, proxyUrl);
    if (extra) tokens.extra = extra;
    return tokens;
  },
};

/**
 * Best-effort read of the Claude account behind an OAuth token. A failure here
 * must not block the login, the access token alone is enough to use the API.
 */
async function fetchClaudeBootstrap(accessToken, proxyUrl) {
  if (!accessToken) return null;
  try {
    const res = await oauthFetch(OAUTH_CONFIG.claude.bootstrapUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": claudeUserAgent(),
        "X-App": "cli",
        "Anthropic-Dangerous-Direct-Browser-Access": "true",
        "anthropic-beta": "oauth-2025-04-20",
      },
    }, { proxyUrl });
    if (!res.ok) return null;
    const data = await res.json();
    const acct = data?.oauth_account;
    if (!acct || typeof acct !== "object") return null;
    return {
      account_uuid: acct.account_uuid || null,
      account_email: acct.account_email || null,
      organization_uuid: acct.organization_uuid || null,
      organization_name: acct.organization_name || null,
      organization_rate_limit_tier: acct.organization_rate_limit_tier || null,
    };
  } catch {
    return null;
  }
}

const codex = {
  flowType: "authorization_code",
  pkce: true,
  fixedPort: OAUTH_CONFIG.codex.fixedPort,
  callbackPath: OAUTH_CONFIG.codex.callbackPath,
  buildAuthUrl({ redirectUri, state, codeChallenge }) {
    const cfg = OAUTH_CONFIG.codex;
    const params = new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: cfg.scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      ...cfg.extraParams,
      state,
    });
    return `${cfg.authorizeUrl}?${params}`;
  },
  async exchange({ code, redirectUri, codeVerifier, proxyUrl = null }) {
    const cfg = OAUTH_CONFIG.codex;
    const res = await oauthFetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    }, { proxyUrl });
    const t = await readJson(res, "Codex token exchange");
    const id = decodeJwtPayload(t.id_token) || {};
    const auth = id["https://api.openai.com/auth"] || {};
    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_in: t.expires_in,
      email: id.email || emailFromJwt(t.access_token),
      extra: {
        id_token: t.id_token,
        account_id: auth.chatgpt_account_id || id.account_id,
        plan_type: auth.chatgpt_plan_type || id.plan_type,
      },
    };
  },
};

const antigravity = {
  flowType: "authorization_code",
  buildAuthUrl({ redirectUri, state }) {
    const cfg = OAUTH_CONFIG.antigravity;
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: cfg.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${cfg.authorizeUrl}?${params}`;
  },
  async exchange({ code, redirectUri, proxyUrl = null }) {
    const cfg = OAUTH_CONFIG.antigravity;
    const res = await oauthFetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    }, { proxyUrl });
    const t = await readJson(res, "Google token exchange");

    const userRes = await oauthFetch(`${cfg.userInfoUrl}?alt=json`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    }, { proxyUrl });
    const user = userRes.ok ? await userRes.json() : {};

    // loadCodeAssist gives the Cloud Code project every request must name.
    const headers = {
      Authorization: `Bearer ${t.access_token}`,
      "Content-Type": "application/json",
      "User-Agent": antigravityUserAgent(),
    };
    // agy 1.4.0 sends ideType as the string "ANTIGRAVITY". The numeric form only
    // works without platform and returns the legacy catalog. Verified against a live account.
    const metadata = { ideType: "ANTIGRAVITY" };
    let projectId = "";
    let tierId = "legacy-tier";
    try {
      const loadRes = await oauthFetch(cfg.loadCodeAssistUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata }),
      }, { proxyUrl });
      if (loadRes.ok) {
        const data = await loadRes.json();
        projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
        tierId = data.allowedTiers?.find((x) => x.isDefault && x.id)?.id?.trim() || tierId;
      }
    } catch {}

    // Onboarding can take a while; it must not block saving the account.
    if (projectId) {
      oauthFetch(cfg.onboardUserUrl, { method: "POST", headers, body: JSON.stringify({ tierId, metadata }) }, { proxyUrl }).catch(
        () => {}
      );
    }

    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_in: t.expires_in,
      email: user.email,
      extra: projectId ? { project_id: projectId } : {},
    };
  },
};

const cline = {
  flowType: "authorization_code",
  stateless: true,
  buildAuthUrl({ redirectUri }) {
    const params = new URLSearchParams({ client_type: "extension", callback_url: redirectUri, redirect_uri: redirectUri });
    return `${OAUTH_CONFIG.cline.authorizeUrl}?${params}`;
  },
  async exchange({ code, redirectUri, proxyUrl = null }) {
    // Cline hands the token back base64-encoded in `code`; older builds need an exchange call.
    // URLSearchParams turns "+" in the base64 payload into a space; undo that.
    code = String(code).trim().replace(/ /g, "+");
    try {
      const decoded = Buffer.from(code, "base64").toString("utf8");
      const data = JSON.parse(decoded.slice(0, decoded.lastIndexOf("}") + 1));
      if (data.accessToken) {
        return {
          access_token: data.accessToken,
          refresh_token: data.refreshToken,
          expires_in: data.expiresAt ? Math.floor((new Date(data.expiresAt).getTime() - Date.now()) / 1000) : 3600,
          email: data.email,
        };
      }
    } catch {}
    const res = await oauthFetch(OAUTH_CONFIG.cline.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, client_type: "extension", redirect_uri: redirectUri }),
    }, { proxyUrl });
    const body = await readJson(res, "Cline token exchange");
    const data = body.data || body;
    return {
      access_token: data.accessToken,
      refresh_token: data.refreshToken,
      expires_in: data.expiresAt ? Math.floor((new Date(data.expiresAt).getTime() - Date.now()) / 1000) : 3600,
      email: data.userInfo?.email,
    };
  },
};

// ---------------------------------------------------------------------------
// Device flows: start() shows a code/URL → poll() until the user approves.
// poll() returns { pending: true } or { error } or { tokens }.
// ---------------------------------------------------------------------------

const github = {
  flowType: "device_code",
  async start({ proxyUrl = null } = {}) {
    const cfg = OAUTH_CONFIG.github;
    const res = await oauthFetch(cfg.deviceCodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scopes }),
    }, { proxyUrl });
    const d = await readJson(res, "GitHub device code request");
    return {
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUri: d.verification_uri,
      expiresIn: d.expires_in,
      interval: d.interval || 5,
    };
  },
  async poll({ deviceCode, proxyUrl = null }) {
    const cfg = OAUTH_CONFIG.github;
    const res = await oauthFetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }, { proxyUrl });
    const d = await res.json().catch(() => ({}));
    if (d.error === "authorization_pending" || d.error === "slow_down") return { pending: true };
    if (!d.access_token) return { error: d.error_description || d.error || "GitHub login failed" };

    // Copilot's API wants its own short-lived token, minted from the GitHub token.
    const copilot = await fetchCopilotToken(d.access_token, { proxyUrl });
    const userRes = await oauthFetch(cfg.userInfoUrl, {
      headers: { Authorization: `Bearer ${d.access_token}`, Accept: "application/json", "User-Agent": cfg.userAgent },
    }, { proxyUrl });
    const user = userRes.ok ? await userRes.json() : {};
    return {
      tokens: {
        access_token: copilot.token,
        expires_at: copilot.expiresAt,
        email: user.email,
        name: user.login,
        extra: { github_token: d.access_token },
      },
    };
  },
};

const kilocode = {
  flowType: "device_code",
  async start({ proxyUrl = null } = {}) {
    const res = await oauthFetch(OAUTH_CONFIG.kilocode.initiateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }, { proxyUrl });
    if (res.status === 429) throw new Error("Terlalu banyak permintaan login yang menunggu. Coba lagi nanti.");
    const d = await readJson(res, "Kilo device auth");
    return {
      deviceCode: d.code,
      userCode: d.code,
      verificationUri: d.verificationUrl,
      expiresIn: d.expiresIn || 300,
      interval: 3,
    };
  },
  async poll({ deviceCode, proxyUrl = null }) {
    const cfg = OAUTH_CONFIG.kilocode;
    const res = await oauthFetch(`${cfg.initiateUrl}/${encodeURIComponent(deviceCode)}`, {}, { proxyUrl });
    if (res.status === 202) return { pending: true };
    if (res.status === 403) return { error: "Login ditolak." };
    if (res.status === 410) return { error: "Kode login kedaluwarsa." };
    if (!res.ok) return { error: `Kilo poll gagal (HTTP ${res.status})` };
    const d = await res.json();
    if (d.status !== "approved" || !d.token) return { pending: true };

    // Organization accounts must send X-Kilocode-OrganizationID.
    let orgId = null;
    try {
      const profileRes = await oauthFetch(`${cfg.apiBaseUrl}/api/profile`, {
        headers: { Authorization: `Bearer ${d.token}` },
      }, { proxyUrl });
      if (profileRes.ok) orgId = (await profileRes.json()).organizations?.[0]?.id || null;
    } catch {}
    return { tokens: { access_token: d.token, email: d.userEmail, extra: orgId ? { org_id: orgId } : {} } };
  },
};

const kiro = {
  flowType: "device_code",
  // AWS Builder ID via SSO OIDC: register a public client, then device authorization.
  async start({ region = "us-east-1", proxyUrl = null } = {}) {
    if (!AWS_REGION.test(region)) throw new Error("Invalid region");
    const cfg = OAUTH_CONFIG.kiro;
    const oidc = `https://oidc.${region}.amazonaws.com`;
    const regRes = await oauthFetch(`${oidc}/client/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientName: cfg.clientName,
        clientType: "public",
        scopes: cfg.scopes,
        grantTypes: cfg.grantTypes,
        issuerUrl: cfg.issuerUrl,
      }),
    }, { proxyUrl });
    const client = await readJson(regRes, "AWS client registration");
    const devRes = await oauthFetch(`${oidc}/device_authorization`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clientId: client.clientId, clientSecret: client.clientSecret, startUrl: cfg.startUrl }),
    }, { proxyUrl });
    const d = await readJson(devRes, "AWS device authorization");
    return {
      deviceCode: d.deviceCode,
      userCode: d.userCode,
      verificationUri: d.verificationUriComplete || d.verificationUri,
      expiresIn: d.expiresIn,
      interval: d.interval || 5,
      state: { clientId: client.clientId, clientSecret: client.clientSecret, region },
    };
  },
  async poll({ deviceCode, state, proxyUrl = null }) {
    const res = await oauthFetch(`https://oidc.${state.region}.amazonaws.com/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        clientId: state.clientId,
        clientSecret: state.clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }, { proxyUrl });
    const d = await res.json().catch(() => ({}));
    if (!d.accessToken) {
      if (!d.error || d.error === "authorization_pending" || d.error === "slow_down") return { pending: true };
      return { error: d.error_description || d.error };
    }
    const profileArn = d.profileArn || (await fetchKiroProfileArn(d.accessToken, { proxyUrl }));
    return {
      tokens: {
        access_token: d.accessToken,
        refresh_token: d.refreshToken,
        expires_in: d.expiresIn,
        email: emailFromJwt(d.accessToken),
        extra: {
          auth_method: "builder-id",
          client_id: state.clientId,
          client_secret: state.clientSecret,
          region: state.region,
          ...(profileArn ? { profile_arn: profileArn } : {}),
        },
      },
    };
  },
};

// ZCode CLI polling flow (mirrors the official Z.ai CLI). The login ends in a
// long-lived coding-plan API key, so the account needs no refresh afterwards.
const glm = {
  flowType: "device_code",
  async start({ proxyUrl = null } = {}) {
    const cfg = OAUTH_CONFIG.glm;
    const pollToken = crypto.randomBytes(32).toString("hex");
    const res = await oauthFetch(cfg.cliInitUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${pollToken}` },
      body: JSON.stringify({ provider: cfg.providerId }),
    }, { proxyUrl });
    const payload = await readJson(res, "ZCode OAuth init");
    const d = payload.data;
    if (!isZaiSuccess(payload.code) || !d?.flow_id || !d?.authorize_url) {
      throw new Error(payload.msg || "ZCode OAuth init returned no flow");
    }
    return {
      deviceCode: d.flow_id,
      verificationUri: d.authorize_url,
      expiresIn: relativeSeconds(d.expires_at) ?? 300,
      interval: d.poll_interval_sec || 3,
      state: { pollToken },
    };
  },
  async poll({ deviceCode, state, proxyUrl = null }) {
    const cfg = OAUTH_CONFIG.glm;
    const res = await oauthFetch(`${cfg.cliPollUrl}/${encodeURIComponent(deviceCode)}`, {
      headers: { Authorization: `Bearer ${state.pollToken}` },
    }, { proxyUrl });
    if (!res.ok) return { error: `ZCode poll gagal (HTTP ${res.status})` };
    const payload = await res.json();
    if (!isZaiSuccess(payload.code)) return { error: payload.msg || "ZCode poll gagal" };
    const d = payload.data || {};
    if (d.status === "failed") return { error: "Login Z.ai gagal atau dibatalkan." };
    if (d.status !== "ready") return { pending: true };

    const zai = d[cfg.providerId] || {};
    const zaiToken = zai.access_token || zai.accessToken || d.accessToken || d.access_token;
    if (!zaiToken) return { error: "Respons ZCode tidak berisi access token." };
    const apiKey = await resolveGlmPlanApiKey(zaiToken, { proxyUrl });
    const user = d.user || {};
    return { tokens: { access_token: apiKey, email: user.email, name: user.name } };
  },
};

function isZaiSuccess(code) {
  return code === undefined || code === null || [0, 200, "0", "200"].includes(code);
}

function relativeSeconds(expiresAt) {
  const raw = Number(expiresAt);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const s = Math.floor((ms - Date.now()) / 1000);
  return s > 0 ? s : null;
}

async function zaiJson(url, init, label, { proxyUrl = null } = {}) {
  const payload = await readJson(await oauthFetch(url, init, { proxyUrl }), `Z.ai ${label}`);
  if (!isZaiSuccess(payload?.code) || payload?.success === false) {
    throw new Error(payload?.msg || `Z.ai ${label} returned error ${payload?.code}`);
  }
  return payload?.data ?? payload ?? null;
}

/** Z.ai OAuth token → business JWT → the "zcode-api-key" coding-plan key (created if missing). */
async function resolveGlmPlanApiKey(zaiToken, { proxyUrl = null } = {}) {
  const cfg = OAUTH_CONFIG.glm;
  const login = await zaiJson(
    cfg.businessLoginUrl,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: zaiToken }) },
    "business login",
    { proxyUrl }
  );
  const business = login?.access_token || login?.accessToken;
  if (!business) throw new Error("Z.ai business login returned no access_token");
  const headers = { Authorization: `Bearer ${business}`, "Content-Type": "application/json" };

  const info = await zaiJson(`${cfg.apiBaseUrl}/api/biz/customer/getCustomerInfo`, { headers }, "customer info", { proxyUrl });
  // Personal org/project: skip team projects (projectType "2"), prefer the default ones.
  const isDefault = (n) => /默认机构|默认项目/.test(String(n || "")) || String(n || "").trim().toLowerCase() === "default";
  const orgs = (info?.organizations || [])
    .map((o) => ({ o, projects: (o.projects || []).filter((p) => String(p.projectType ?? "") !== "2") }))
    .filter((x) => x.o.organizationId && x.projects.length);
  if (!orgs.length) throw new Error("Tidak menemukan organisasi/proyek Z.ai untuk coding plan");
  const org = orgs.find((x) => isDefault(x.o.organizationName)) || orgs[0];
  const project = org.projects.find((p) => isDefault(p.projectName)) || org.projects[0];

  const listUrl = `${cfg.apiBaseUrl}/api/biz/v1/organization/${org.o.organizationId}/projects/${project.projectId}/api_keys`;
  const keys = (await zaiJson(listUrl, { headers }, "api keys", { proxyUrl })) || [];
  let entry = Array.isArray(keys) ? keys.find((k) => k?.name === cfg.planApiKeyName) : null;
  if (!entry) {
    entry = await zaiJson(
      listUrl,
      { method: "POST", headers, body: JSON.stringify({ name: cfg.planApiKeyName }) },
      "api key create",
      { proxyUrl }
    );
  }
  const apiKey = entry?.apiKey?.trim();
  if (!apiKey) throw new Error("Z.ai api_keys response has no apiKey");
  const secret = await zaiJson(`${listUrl}/copy/${encodeURIComponent(apiKey)}`, { headers }, "api key copy", { proxyUrl });
  if (!secret?.secretKey?.trim()) throw new Error("Z.ai api key copy has no secretKey");
  return `${apiKey}.${secret.secretKey.trim()}`;
}

export const OAUTH_FLOWS = { claude, codex, antigravity, cline, github, kilocode, kiro, glm };

export function getOAuthFlow(providerId) {
  return OAUTH_FLOWS[providerId] || null;
}
