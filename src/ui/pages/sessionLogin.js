import { getProvider } from "../../providers/index.js";
import { validateProxyAddress } from "../../services/proxyPools.js";
import { cancelBrowserLogin, pollBrowserLogin, startBrowserLogin } from "../../services/deepseekWeb/browserLogin.js";

async function readJsonBody(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** POST /dashboard/providers/accounts/login/start {provider, name?, proxy_url?} */
export async function handleSessionLoginStart(c) {
  const body = await readJsonBody(c);
  const provider = getProvider(String(body.provider || ""));
  if (!provider) return c.json({ error: "Provider tidak dikenal." }, 400);
  if (!(provider.authMethods || []).includes("session")) {
    return c.json({ error: "Provider ini tidak memakai token sesi browser. Tempel token manual." }, 400);
  }
  const proxyUrl = String(body.proxy_url || "").trim();
  if (proxyUrl) {
    const proxyError = validateProxyAddress(proxyUrl);
    if (proxyError) return c.json({ error: proxyError }, 400);
  }
  try {
    return c.json(startBrowserLogin({ providerId: provider.id, name: String(body.name || ""), proxyUrl }));
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
}

/** POST /dashboard/providers/accounts/login/poll {flowId} */
export async function handleSessionLoginPoll(c) {
  const body = await readJsonBody(c);
  return c.json(pollBrowserLogin(String(body.flowId || "")));
}

/** POST /dashboard/providers/accounts/login/cancel {flowId} */
export async function handleSessionLoginCancel(c) {
  const body = await readJsonBody(c);
  cancelBrowserLogin(String(body.flowId || ""));
  return c.json({ ok: true });
}
