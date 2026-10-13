import { oauthFetch } from "../oauth/providers.js";
import { requireResolvedProxy } from "../proxyPools.js";
import { parseResetTime } from "./shared.js";

const CW_HOST = "https://codewhisperer.us-east-1.amazonaws.com";
const Q_HOST = "https://q.us-east-1.amazonaws.com";
const LIMITS_PATH = "/getUsageLimits";

/** Parse GetUsageLimits/usage response (same shape as 9router usage/kiro.js). */
function parseKiroQuotaData(data) {
  const usageList = data.usageBreakdownList || [];
  const resetAt = parseResetTime(data.nextDateReset || data.resetDate);
  const quotas = {};

  for (const breakdown of usageList) {
    const resourceType = (breakdown.resourceType || "").toLowerCase() || "unknown";
    const used = Number(breakdown.currentUsageWithPrecision) || 0;
    const total = Number(breakdown.usageLimitWithPrecision) || 0;
    const remaining = Math.max(0, total - used);

    quotas[resourceType] = {
      used,
      total,
      remaining,
      remainingPercentage: total > 0 ? (remaining / total) * 100 : null,
      resetAt,
      usedLabel: `${used.toLocaleString()} / ${total.toLocaleString()}`,
    };

    if (breakdown.freeTrialInfo) {
      const ft = breakdown.freeTrialInfo;
      const freeUsed = Number(ft.currentUsageWithPrecision) || 0;
      const freeTotal = Number(ft.usageLimitWithPrecision) || 0;
      const freeRemaining = Math.max(0, freeTotal - freeUsed);
      quotas[`${resourceType} (freetrial)`] = {
        used: freeUsed,
        total: freeTotal,
        remaining: freeRemaining,
        remainingPercentage: freeTotal > 0 ? (freeRemaining / freeTotal) * 100 : null,
        resetAt: parseResetTime(ft.freeTrialExpiry || resetAt),
        usedLabel: `${freeUsed.toLocaleString()} / ${freeTotal.toLocaleString()}`,
      };
    }
  }

  return {
    plan: data.subscriptionInfo?.subscriptionTitle || "Kiro",
    quotas,
  };
}

/**
 * Fetch live usage limits for Kiro (AWS CodeWhisperer). Tries the known
 * endpoints in order, like 9router usage/kiro.js.
 */
export async function fetchKiroQuota(connection) {
  const token = connection.credentials?.access_token;
  if (!token) return null;

  const authMethod = connection.credentials?.auth_method || "";
  const apiKeyHeaders = authMethod === "api_key" ? { tokentype: "API_KEY" } : {};
  const externalIdpHeaders = authMethod === "idc" ? { TokenType: "EXTERNAL_IDP" } : {};
  const profileArn = connection.credentials?.profile_arn || "";

  const usageParams = new URLSearchParams({
    isEmailRequired: "true",
    origin: "AI_EDITOR",
    resourceType: "AGENTIC_REQUEST",
  });

  const attempts = [
    {
      name: "codewhisperer-get",
      url: `${CW_HOST}${LIMITS_PATH}?${usageParams}`,
      init: { method: "GET" },
    },
    {
      name: "codewhisperer-post",
      url: CW_HOST,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-amz-json-1.0", "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits" },
        body: JSON.stringify({ origin: "AI_EDITOR", ...(profileArn ? { profileArn } : {}), resourceType: "AGENTIC_REQUEST" }),
      },
    },
    {
      name: "q-get",
      url: `${Q_HOST}${LIMITS_PATH}?${new URLSearchParams({ origin: "AI_EDITOR", ...(profileArn ? { profileArn } : {}), resourceType: "AGENTIC_REQUEST" })}`,
      init: { method: "GET" },
    },
  ];

  let sawAuthError = false;
  const errors = [];

  for (const attempt of attempts) {
    try {
      const res = await oauthFetch(
        attempt.url,
        {
          ...attempt.init,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE",
            "User-Agent": "aws-sdk-js/1.0.0 KiroIDE",
            ...(attempt.init.headers || {}),
            ...apiKeyHeaders,
            ...externalIdpHeaders,
          },
        },
        { proxyUrl: requireResolvedProxy(connection) }
      );
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) sawAuthError = true;
        errors.push(`${attempt.name}:${res.status}`);
        continue;
      }
      const data = await res.json();
      const parsed = parseKiroQuotaData(data);
      if (Object.keys(parsed.quotas).length === 0) {
        errors.push(`${attempt.name}:empty`);
        continue;
      }
      return {
        provider: "kiro",
        plan: parsed.plan,
        is_exhausted: Object.values(parsed.quotas).some((q) => q.remainingPercentage != null && q.remainingPercentage <= 0),
        unit: "requests",
        quotas: parsed.quotas,
      };
    } catch (err) {
      errors.push(`${attempt.name}:${err.message}`);
    }
  }

  if (sawAuthError) {
    // Soft failure: keep chat working, just report that quota is unavailable.
    return { provider: "kiro", plan: "Kiro", is_exhausted: false, unit: "requests", error: "Quota API token ditolak (401/403)" };
  }
  throw new Error(`Kiro usage endpoints gagal (${errors.join(", ")})`);
}
