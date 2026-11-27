import {
  cancelAntigravityAcpLogin,
  getAntigravityAcpLoginBinding,
  getAntigravityAcpLoginStatus,
  startAntigravityAcpLogin,
  submitAntigravityAcpLogin,
} from "../../services/antigravityAcp/login.js";
import {
  listAntigravityAcpProfiles,
  removeAntigravityAcpAccount,
  renameAntigravityAcpAccount,
} from "../../services/antigravityAcp/profiles.js";
import { escapeHtml } from "../html.js";
import { t } from "../i18n/index.js";

const BACK = "/dashboard/providers/antigravity-acp";
const STATUS_KEYS = { ready: "status_ready", needs_login: "status_needs_login", limited: "status_limited", unavailable: "status_unavailable" };

function statusFor(code) {
  if (code === "login_busy") return 409;
  if (code === "login_attempt_invalid") return 404;
  if (code === "invalid_authorization_code" || code === "login_callback_failed" || code === "login_attempt_used") return 400;
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
  return c.json({ ok: true, attemptId: result.attemptId, authorizationUrl: result.authorizationUrl, expiresIn: result.expiresIn, callback: result.callback || null }, 202);
}

export async function handleAgyLoginSubmit(c) {
  const body = await input(c);
  const result = await submitAntigravityAcpLogin({
    attemptId: typeof body.attemptId === "string" ? body.attemptId : String(body.attemptId || ""),
    code: typeof body.code === "string" ? body.code : "",
    binding: binding(c),
  });
  if (!result.ok) return c.json({ ok: false, error: result.code }, statusFor(result.code));
  return c.json({ ok: true, status: result.status, added: result.added });
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

export async function handleAgyAccountRename(c) {
  const body = await input(c);
  const result = renameAntigravityAcpAccount(typeof body.id === "string" ? body.id : "", typeof body.name === "string" ? body.name : "");
  const code = result.ok ? "renamed" : result.reason === "invalid_name" || result.reason === "duplicate_name" ? "err_name" : "err_generic";
  return c.redirect(`${BACK}?acp_notice=${code}`);
}

export async function handleAgyAccountRemove(c) {
  const body = await input(c);
  const result = await removeAntigravityAcpAccount(typeof body.id === "string" ? body.id : "");
  const code = result.ok ? "removed" : result.reason === "account_busy" ? "err_busy" : "err_generic";
  return c.redirect(`${BACK}?acp_notice=${code}`);
}

const NOTICE_CODES = new Set(["added", "relogin", "removed", "renamed", "err_name", "err_busy", "err_generic"]);

const LOGIN_SCRIPT = String.raw`
<script>
(function () {
  var attemptId = null, popup = null;
  function post(url, data) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().catch(function () { return { error: 'x' }; }); });
  }
  function box() { return document.getElementById('agy-acp-login'); }
  function msg(text) { var el = document.getElementById('agy-acp-login-msg'); if (el) el.textContent = text; }
  window.zrAgyAcpLogin = function (id, btn) {
    var t = btn.dataset;
    window.zrAgyAcpCancel();
    popup = window.open('about:blank', '_blank');
    post('/dashboard/providers/antigravity-acp/login/start', id ? { accountId: id } : {}).then(function (r) {
      if (r.error || !r.attemptId) { if (popup) popup.close(); popup = null; return alert(t.failed); }
      attemptId = r.attemptId;
      if (popup) popup.location = r.authorizationUrl;
      box().hidden = false;
      var b = box(); b.innerHTML = '';
      function el(tag, props) { var e = document.createElement(tag); Object.keys(props || {}).forEach(function (k) { e[k] = props[k]; }); return e; }
      var link = el('a', { className: 'btn-nb', target: '_blank', rel: 'noopener', href: r.authorizationUrl, textContent: t.open });
      var hint = el('p', { className: 'hint', textContent: r.callback ? t.hint : t.hintCode });
      var input = el('input', { id: 'agy-acp-code', type: 'text', autocomplete: 'off', className: 'search-cli-input', placeholder: t.placeholder });
      var submit = el('button', { type: 'button', className: 'btn-nb', id: 'agy-acp-submit', textContent: t.submit });
      var cancel = el('button', { type: 'button', className: 'btn-nb', id: 'agy-acp-cancel', textContent: t.cancel });
      var note = el('span', { id: 'agy-acp-login-msg', className: 'hint', textContent: t.waiting });
      [link, hint, input, submit, cancel, note].forEach(function (n) { b.appendChild(n); });
      var myAttempt = attemptId;
      var poll = setInterval(function () {
        if (attemptId !== myAttempt) return clearInterval(poll);
        post('/dashboard/providers/antigravity-acp/login/status', { attemptId: myAttempt }).then(function (j) {
          if (attemptId !== myAttempt) return;
          if (j.status === 'ready') { clearInterval(poll); attemptId = null; location.assign(location.pathname + '?acp_notice=added'); }
          else if (j.error || j.status === 'failed' || j.status === 'cancelled') { clearInterval(poll); msg(t.failed); }
        }).catch(function () {});
      }, 2000);
      cancel.onclick = function () { clearInterval(poll); window.zrAgyAcpCancel(); };
      submit.onclick = function () {
        var code = input.value.trim();
        if (!code) return;
        submit.disabled = true;
        post('/dashboard/providers/antigravity-acp/login/submit', { attemptId: attemptId, code: code }).then(function (j) {
          if (j.status === 'ready') { clearInterval(poll); attemptId = null; return location.assign(location.pathname + '?acp_notice=' + (j.added ? 'added' : 'relogin')); }
          msg(j.error === 'invalid_authorization_code' ? t.invalid : j.error === 'login_callback_failed' ? t.callbackFailed : t.failed);
          submit.disabled = false;
        }).catch(function () { msg(t.failed); submit.disabled = false; });
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
  const loginAttrs = `data-open="${escapeHtml(tr("open_login"))}" data-hint="${escapeHtml(tr("login_hint"))}" data-hint-code="${escapeHtml(tr("login_hint_code"))}" data-cancel="${escapeHtml(tr("cancel"))}" data-waiting="${escapeHtml(tr("login_waiting"))}" data-callback-failed="${escapeHtml(tr("callback_failed"))}" data-failed="${escapeHtml(tr("login_failed"))}" data-invalid="${escapeHtml(tr("invalid_code"))}" data-placeholder="${escapeHtml(tr("code_placeholder"))}" data-submit="${escapeHtml(tr("submit_code"))}"`;
  const rows = accounts.map((account) => {
    const status = STATUS_KEYS[account.status] ? account.status : "unavailable";
    const resetAt = account.limitedUntil || account.quota?.resetAt || null;
    const until = resetAt ? ` ${escapeHtml(tr("limited_until"))} ${escapeHtml(new Date(resetAt).toISOString().slice(0, 16).replace("T", " "))} UTC` : "";
    const quotaBadge = account.quota?.status && account.quota.status !== status
      ? ` (${escapeHtml(account.quota.status)})`
      : "";
    const dataAttrs = `data-open="${escapeHtml(tr("open_login"))}" data-hint="${escapeHtml(tr("login_hint"))}" data-hint-code="${escapeHtml(tr("login_hint_code"))}" data-cancel="${escapeHtml(tr("cancel"))}" data-waiting="${escapeHtml(tr("login_waiting"))}" data-callback-failed="${escapeHtml(tr("callback_failed"))}" data-failed="${escapeHtml(tr("login_failed"))}" data-invalid="${escapeHtml(tr("invalid_code"))}" data-placeholder="${escapeHtml(tr("code_placeholder"))}" data-submit="${escapeHtml(tr("submit_code"))}"`;
    return `<div class="acp-worker-row" style="display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:12px;align-items:center;">
      <form action="${BACK}/accounts/rename" method="POST" style="margin:0;display:flex;gap:6px;align-items:center;">
        <input type="hidden" name="id" value="${escapeHtml(account.id)}" />
        <input name="name" value="${escapeHtml(account.name)}" maxlength="40" required autocomplete="off" aria-label="${escapeHtml(tr("rename"))}" class="search-cli-input acp-worker-input" style="min-width:0;" />
        <button type="submit" class="btn-nb">${escapeHtml(tr("rename"))}</button>
      </form>
      <span class="pill pill-muted" style="border-radius: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 800; text-transform: uppercase;">${escapeHtml(tr(STATUS_KEYS[status]))}${until}${quotaBadge}</span>
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
          <strong>${escapeHtml(tr("add_title"))}</strong>
          <p class="hint">${escapeHtml(tr("add_hint"))}</p>
          <button type="button" class="btn-nb" ${loginAttrs} onclick="zrAgyAcpLogin('', this)">${escapeHtml(tr("add_via_agy"))}</button>
        </section>
      </div>
    </div>${LOGIN_SCRIPT}`;
}
