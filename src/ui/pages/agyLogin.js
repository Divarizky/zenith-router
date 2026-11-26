import {
  cancelAntigravityAcpLogin,
  getAntigravityAcpLoginBinding,
  getAntigravityAcpLoginStatus,
  startAntigravityAcpLogin,
  submitAntigravityAcpLogin,
} from "../../services/antigravityAcp/login.js";

function statusFor(code) {
  if (code === "login_busy" || code === "profile_slots_full") return 409;
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
  const result = await startAntigravityAcpLogin(binding(c));
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
  return c.json({ ok: true, status: result.status, added: result.added === true });
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