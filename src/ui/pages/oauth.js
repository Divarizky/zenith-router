import { getProvider } from "../../providers/index.js";
import { getOAuthFlow } from "../../services/oauth/providers.js";
import {
  startOAuthFlow,
  pollOAuthFlow,
  completeManual,
  completeCallback,
  cancelOAuthFlow,
  importLocalLogin,
  renderCallbackPage,
} from "../../services/oauth/flows.js";

import { validateProxyAddress } from "../../services/proxyPools.js";

async function readJsonBody(c) {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

/** POST /dashboard/oauth/start {provider, name?, proxy_url?} */
export async function handleOAuthStart(c) {
  const body = await readJsonBody(c);
  const provider = getProvider(String(body.provider || ""));
  if (!provider) return c.json({ error: "Provider tidak dikenal." }, 400);
  if (!getOAuthFlow(provider.id)) return c.json({ error: "Provider ini tidak mendukung login OAuth." }, 400);
  const proxyUrl = String(body.proxy_url || "").trim();
  const proxyError = proxyUrl ? validateProxyAddress(proxyUrl) : null;
  if (proxyError) return c.json({ error: proxyError }, 400);

  try {
    const result = await startOAuthFlow({
      providerId: provider.id,
      origin: new URL(c.req.url).origin,
      name: String(body.name || "").trim(),
      proxyUrl,
    });
    return c.json(result);
  } catch (err) {
    return c.json({ error: err.message }, 502);
  }
}

/** POST /dashboard/oauth/poll {flowId} */
export async function handleOAuthPoll(c) {
  const body = await readJsonBody(c);
  return c.json(await pollOAuthFlow(String(body.flowId || "")));
}

/** POST /dashboard/oauth/manual {flowId, input}: pasted callback URL or code. */
export async function handleOAuthManual(c) {
  const body = await readJsonBody(c);
  const result = await completeManual(String(body.flowId || ""), body.input);
  return c.json(result.ok ? { status: "done", account: result.account } : { status: "error", error: result.error });
}

/** POST /dashboard/oauth/cancel {flowId} */
export async function handleOAuthCancel(c) {
  const body = await readJsonBody(c);
  cancelOAuthFlow(String(body.flowId || ""));
  return c.json({ ok: true });
}

/** GET /callback: where providers that own their redirect send the browser back. */
export async function handleOAuthCallback(c) {
  const result = await completeCallback(c.req.query());
  return c.html(renderCallbackPage(result), result.ok ? 200 : 400);
}

/** POST /dashboard/providers/accounts/import-local: reuse a login from the vendor's CLI/IDE. */
export async function handleImportLocalLogin(c) {
  const body = await c.req.parseBody();
  const provider = getProvider(String(body.provider || ""));
  if (!provider) return c.redirect("/dashboard/providers");
  const back = `/dashboard/providers/${encodeURIComponent(provider.id)}`;
  const proxyUrl = String(body.proxy_url || "").trim();
  if (proxyUrl && validateProxyAddress(proxyUrl)) return c.redirect(`${back}?notice=proxy_invalid`);

  try {
    await importLocalLogin(provider.id, { name: String(body.name || "").trim(), proxyUrl });
    return c.redirect(`${back}?notice=account_added`);
  } catch {
    return c.redirect(`${back}?notice=import_failed`);
  }
}
