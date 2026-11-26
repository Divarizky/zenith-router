import {
  cancelAntigravityAcpLogin,
  getAntigravityAcpLoginBinding,
  getAntigravityAcpLoginStatus,
  startAntigravityAcpLogin,
  submitAntigravityAcpLogin,
} from "../../services/antigravityAcp/login.js";
import {
  addAntigravityAcpAccount,
  listAntigravityAcpProfiles,
  removeAntigravityAcpAccount,
} from "../../services/antigravityAcp/profiles.js";
import { escapeHtml } from "../html.js";
import { t } from "../i18n/index.js";

const BACK = "/dashboard/providers/antigravity-acp";
const STATUS_KEYS = { ready: "status_ready", needs_login: "status_needs_login", limited: "status_limited", unavailable: "status_unavailable" };

function statusFor(code) {
  if (code === "login_busy") return 409;
  if (code === "login_attempt_invalid") return 404;
  if (code === "invalid_authorization_code" || code === "login_attempt_used") return 400;
  return 502;
}

async function input(c) {
  const contentType = (c.req.header("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/json") return c.req.json().catch(() => ({}));
  return c.req.parseBody().catch(() => ({}));
}

function binding(c) {
  return getAntigravityAcpLoginBinding(c.req);
}

export async function handleAgyLoginStart(c) {
  const body = await input(c);
  const result = await startAntigravityAcpLogin(binding(c), typeof body.accountId === "string" ? body.accountId : "");
  if (!result.ok) return c.json({ ok: false, error: result.code }, statusFor(result.code));
  return c.json({ ok: true, attemptId: result.attemptId, authorizationUrl: result.authorizationUrl, expiresIn: result.expiresIn }, 202);
}

export async function handleAgyLoginSubmit(c) {
  const body = await input(c);
  const result = await submitAntigravityAcpLogin({
    attemptId: typeof body.attemptId === "string" ? body.attemptId : String(body.attemptId || ""),
    code: typeof body.code === "string" ? body.code : "",
    binding: binding(c),
  });
  if (!result.ok) return c.json({ ok: false, error: result.code }, statusFor(result.code));
  return c.json({ ok: true, status: result.status });
}

export async function handleAgyLoginStatus(c) {
  const body = await input(c);
  const result = getAntigravityAcpLoginStatus({
    attemptId: typeof body.attemptId === "string" ? body.attemptId : String(body.attemptId || ""),
    binding: binding(c),
  });
  if (!result.ok) return c.json({ ok: false, error: result.code }, statusFor(result.code));
  return c.json({ ok: true, status: result.status, error: result.error });
}

export async function handleAgyLoginCancel(c) {
  const body = await input(c);
  const result = cancelAntigravityAcpLogin({
    attemptId: typeof body.attemptId === "string" ? body.attemptId : String(body.attemptId || ""),
    binding: binding(c),
  });
  if (!result.ok) return c.json({ ok: false, error: result.code }, statusFor(result.code));
  return c.json({ ok: true, status: result.status });
}

export async function handleAgyAccountAdd(c) {
  const body = await input(c);
  const result = await addAntigravityAcpAccount(typeof body.name === "string" ? body.name : "");
  const code = result.ok ? "added" : result.reason === "invalid_name" || result.reason === "duplicate_name" ? "err_name" : "err_generic";
  return c.redirect(`${BACK}?acp_notice=${code}`);
}

export async function handleAgyAccountRemove(c) {
  const body = await input(c);
  const result = await removeAntigravityAcpAccount(typeof body.id === "string" ? body.id : "");
  const code = result.ok ? "removed" : result.reason === "account_busy" ? "err_busy" : "err_generic";
  return c.redirect(`${BACK}?acp_notice=${code}`);
}

const NOTICE_CODES = new Set(["added", "removed", "err_name", "err_busy", "err_generic"]);

const LOGIN_SCRIPT = `
<script>
(function () {
  var attemptId = null, popup = null;
  function post(url, data) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return { error: 'x' }; }); });
  }
  function box() { return document.getElementById('agy-acp-login'); }
  function msg(text) { var el = document.getElementById('agy-acp-login-msg'); if (el) el.textContent = text; }
  function extractCode(value) {
    var text = value.trim();
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return new URL(text).searchParams.get('code') || text;
      if (/(?:^|[?&])code=/.test(text)) return new URLSearchParams(text.replace(/^.*?\?/, '')).get('code') || text;
    } catch (_) {}
    return text;
  }
  window.zrAgyAcpLogin = function (id, btn) {
    var t = btn.dataset;
    window.zrAgyAcpCancel();
    popup = window.open('about:blank', '_blank');
    post('/dashboard/providers/antigravity-acp/login/start', { accountId: id }).then(function (r) {
      if (r.error || !r.attemptId) { if (popup) popup.close(); popup = null; return alert(t.failed); }
      attemptId = r.attemptId;
      if (popup) popup.location = r.authorizationUrl;
      box().hidden = false;
      box().innerHTML = '<a class="btn-nb" target="_blank" rel="noopener" href="' + r.authorizationUrl + '">Buka Halaman Login Google</a> <label for="agy-acp-code">Kode otorisasi</label> <input id="agy-acp-code" type="text" autocomplete="off" class="search-cli-input" placeholder="' + t.placeholder + '" /> <button type="button" class="btn-nb" id="agy-acp-submit">' + t.submit + '</button> <button type="button" class="btn-nb" id="agy-acp-cancel">Batal</button> <span id="agy-acp-login-msg" class="hint"></span>';
      document.getElementById('agy-acp-cancel').onclick = function () { window.zrAgyAcpCancel(); box().innerHTML = ''; box().hidden = true; };
      document.getElementById('agy-acp-submit').onclick = function () {
        var code = extractCode(document.getElementById('agy-acp-code').value);
        if (!code) return;
        this.disabled = true;
        var self = this;
        post('/dashboard/providers/antigravity-acp/login/submit', { attemptId: attemptId, code: code }).then(function (j) {
          if (j.status === 'ready') { attemptId = null; return location.reload(); }
          msg(j.error === 'invalid_authorization_code' ? t.invalid : t.failed);
          self.disabled = false;
        }).catch(function () { msg(t.failed); self.disabled = false; });
      };
    }).catch(function () { if (popup) popup.close(); popup = null; alert(t.failed); });
  };
  window.zrAgyAcpCancel = function () {
    if (attemptId) post('/dashboard/providers/antigravity-acp/login/cancel', { attemptId: attemptId }).catch(function () {});
    attemptId = null;
    if (popup && !popup.closed) popup.close();
    popup = null;
    var loginBox = box(); if (loginBox) { loginBox.innerHTML = ''; loginBox.hidden = true; }
  };
  if (window.__zrSwapCleanups) window.__zrSwapCleanups.push(function () { window.zrAgyAcpCancel(); });
})();
</script>`;

export function renderAgyAccountsCard({ accounts = listAntigravityAcpProfiles(), enabled = false, lang, notice } = {}) {
  const tr = (key) => t(`agyAcp.${key}`, {}, lang);
  const noticeKey = NOTICE_CODES.has(notice) ? notice : null;
  const rows = accounts.map((account) => {
    const status = STATUS_KEYS[account.status] ? account.status : "unavailable";
    const until = account.limitedUntil ? ` ${escapeHtml(tr("limited_until"))} ${escapeHtml(new Date(account.limitedUntil).toISOString().slice(0, 16).replace("T", " "))} UTC` : "";
    const dataAttrs = `data-failed="${escapeHtml(tr("login_failed"))}" data-invalid="${escapeHtml(tr("invalid_code"))}" data-placeholder="${escapeHtml(tr("code_placeholder"))}" data-submit="${escapeHtml(tr("submit_code"))}"`;
    return `<div class="acp-worker-row" style="display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:12px;align-items:center;">
      <span>${escapeHtml(account.name)}</span>
      <span class="pill pill-muted" style="border-radius: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 800; text-transform: uppercase;">${escapeHtml(tr(STATUS_KEYS[status]))}${until}</span>
      <button type="button" class="btn-nb" ${dataAttrs} onclick="zrAgyAcpLogin('${escapeHtml(account.id)}', this)">${escapeHtml(tr("login"))}</button>
      <form action="${BACK}/accounts/remove" method="POST" onsubmit="return confirm(this.dataset.confirm)" data-confirm="${escapeHtml(tr("remove_confirm"))}" style="margin:0;">
        <input type="hidden" name="id" value="${escapeHtml(account.id)}" />
        <button type="submit" class="btn-nb">${escapeHtml(tr("remove"))}</button>
      </form>
    </div>`;
  }).join("") || `<p class="hint">${escapeHtml(tr("empty"))}</p>`;
  return `
    <div class="card channel-strips-card" id="acp-workers">
      <div class="hw-screw screw-tl"></div>
      <div class="hw-screw screw-tr"></div>
      <div class="hw-screw screw-bl"></div>
      <div class="hw-screw screw-br"></div>
      <div class="block-header-strip">
        <div class="block-header-title"><img src="/providers/antigravity-acp.png" alt="" width="22" height="22" /><span>${escapeHtml(tr("title"))}</span><span class="badge-tag">PREVIEW</span></div>
        <div class="block-header-sub">${escapeHtml(tr("hint"))}</div>
      </div>
      <div style="padding: 16px 20px; display: grid; gap: 14px;">
        ${noticeKey ? `<p class="hint">${escapeHtml(tr(noticeKey))}</p>` : ""}
        <form action="${BACK}" method="POST" style="margin:0;">
          <label class="acp-check-label" style="display: inline-flex; align-items: center; gap: 10px; cursor: pointer; user-select: none;">
            <input type="checkbox" name="enabled" value="true" class="nb-check" style="width: 18px; height: 18px; min-width: 18px; flex-shrink: 0; margin: 0;" ${enabled ? "checked" : ""} onchange="this.form.submit()" />
            <span>${escapeHtml(tr("enable"))}</span>
          </label>
        </form>
        ${rows}
        <div id="agy-acp-login" hidden></div>
        <section class="rack-chassis" style="padding:14px;border:2px solid var(--border);display:grid;gap:10px;">
          <strong>Tambah Akun</strong>
          <p class="hint">Step 1: Beri nama &amp; tambah akun → Step 2: Klik Login Google.</p>
          <form action="${BACK}/accounts/add" method="POST" style="display:grid;gap:8px;margin:0;">
            <label for="agy-account-name">Nama akun</label>
            <input id="agy-account-name" name="name" maxlength="40" required autocomplete="off" placeholder="${escapeHtml(tr("name_placeholder"))}" class="search-cli-input acp-worker-input" style="border-radius: 0; width:100%;" />
            <button type="submit" class="btn-nb">${escapeHtml(tr("add"))}</button>
          </form>
        </section>
      </div>
    </div>${LOGIN_SCRIPT}`;
}
