const PROVIDER_TIMEOUT_MS = 10000;
const PROVIDER_ENV_KEYS = [
  "ABUSEIPDB_API_KEY",
  "IP2LOCATION_API_KEY",
  "IPDATA_API_KEY",
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store, max-age=0",
    },
  });
}

function missingProviderEnvKeys(env) {
  return PROVIDER_ENV_KEYS.filter((key) => !env[key]);
}

function hasProviderKey(env, key) {
  return Boolean(env[key]);
}

function providerNotConfigured(provider, keyName) {
  return {
    status: "not_configured",
    provider,
    label: "未配置",
    summary: `未配置 ${keyName}，当前仅显示访问者 IP。`,
  };
}

function buildOverallMessage(checks) {
  const entries = Object.values(checks);
  const okCount = entries.filter((item) => item.status === "ok").length;
  const notConfiguredCount = entries.filter((item) => item.status === "not_configured").length;
  const errorCount = entries.filter((item) => item.status === "error").length;

  if (okCount === entries.length) {
    return "已完成当前访问 IP 检测。";
  }
  if (okCount > 0 && notConfiguredCount > 0 && errorCount === 0) {
    return `已识别当前访问 IP，已完成 ${okCount} 项检测，另有 ${notConfiguredCount} 项未配置。`;
  }
  if (okCount > 0 && errorCount > 0) {
    return `已识别当前访问 IP，已完成 ${okCount} 项检测，另有 ${errorCount} 项查询失败。`;
  }
  if (okCount === 0 && notConfiguredCount === entries.length) {
    return "已识别当前访问 IP，但检测服务尚未配置，当前仅显示访问者 IP。";
  }
  if (okCount === 0 && notConfiguredCount > 0 && errorCount > 0) {
    return `已识别当前访问 IP，但仅有未配置或失败的检测项：未配置 ${notConfiguredCount} 项，失败 ${errorCount} 项。`;
  }
  return "已识别当前访问 IP，但检测服务暂时不可用。";
}

function overallSuccess(checks) {
  return Object.values(checks).some((item) => item.status === "ok");
}


function firstHeaderValue(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .find(Boolean) || "";
}

function isIpv4(ip) {
  const parts = String(ip || "").split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function isPrivateIpv4(ip) {
  if (!isIpv4(ip)) {
    return false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  );
}

function isIpv6(ip) {
  return String(ip || "").includes(":");
}

function isPrivateIpv6(ip) {
  const normalized = String(ip || "").toLowerCase();
  return (
    normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:")
  );
}

function isPublicIp(ip) {
  if (isIpv4(ip)) {
    return !isPrivateIpv4(ip);
  }
  if (isIpv6(ip)) {
    return !isPrivateIpv6(ip);
  }
  return false;
}

function readVisitorIp(request) {
  const candidates = [
    request.headers.get("cf-connecting-ip"),
    request.headers.get("x-forwarded-for"),
    request.headers.get("x-real-ip"),
  ];

  for (const candidate of candidates) {
    const ip = firstHeaderValue(candidate);
    if (ip) {
      return ip;
    }
  }

  return "";
}

async function parseJsonSafe(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function providerFetchJson(url, options, fallbackMessage) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const data = await parseJsonSafe(response);

  if (!response.ok) {
    const detail = data && typeof data === "object"
      ? data.message || data.error_message || data.reason || data.raw
      : "";
    const error = new Error(detail ? `${fallbackMessage}（HTTP ${response.status}: ${detail}）` : `${fallbackMessage}（HTTP ${response.status}）`);
    error.providerData = data;
    throw error;
  }

  return data;
}

function attachDebugPayload(result, enabled, raw) {
  if (!enabled) {
    return result;
  }
  return {
    ...result,
    debug: {
      raw,
    },
  };
}

function boolLabel(value, yesLabel = "是", noLabel = "否") {
  if (value === true) {
    return yesLabel;
  }
  if (value === false) {
    return noLabel;
  }
  return "未知";
}

function normalizeText(value) {
  const text = String(value || "").trim();
  return text || "未知";
}

function buildAbuseResult(data) {
  const payload = data && data.data ? data.data : {};
  const score = Number.isFinite(Number(payload.abuseConfidenceScore)) ? Number(payload.abuseConfidenceScore) : null;
  const totalReports = Number.isFinite(Number(payload.totalReports)) ? Number(payload.totalReports) : null;
  const lastReportedAt = payload.lastReportedAt || "";
  const isAbusive = score === null ? (totalReports && totalReports > 0 ? true : null) : score > 0;
  const label = isAbusive === true ? "有记录" : isAbusive === false ? "未发现" : "未知";
  const summaryParts = [];

  if (score !== null) {
    summaryParts.push(`置信分 ${score}`);
  }
  if (totalReports !== null) {
    summaryParts.push(`报告 ${totalReports} 次`);
  }
  if (lastReportedAt) {
    summaryParts.push(`最近上报 ${lastReportedAt}`);
  }

  return {
    status: "ok",
    provider: "AbuseIPDB",
    label,
    isAbusive,
    abuseConfidenceScore: score,
    totalReports,
    lastReportedAt,
    countryCode: payload.countryCode || "",
    usageType: payload.usageType || "",
    isp: payload.isp || "",
    summary: summaryParts.join("，") || "未返回更多信息。",
  };
}

function residentialDecisionFromUsageType(usageType, category) {
  const usageTypeText = String(usageType || "").trim().toLowerCase();
  const categoryText = String(category || "").trim().toLowerCase();
  const usageTypeCode = String(usageType || "").trim().toUpperCase();

  if (
    usageTypeText === "data center/web hosting/transit"
    || categoryText === "data centers"
  ) {
    return false;
  }
  if (["ISP", "MOB"].includes(usageTypeCode)) {
    return true;
  }
  if (["DCH", "CDN", "SES", "CSP", "ORG", "EDU", "GOV", "MIL", "COM"].includes(usageTypeCode)) {
    return false;
  }
  return null;
}

function buildIp2LocationResult(data) {
  const usageType = data.usage_type || data.usageType || "";
  const category = data.category || "";
  const isResidential = residentialDecisionFromUsageType(usageType, category);
  const label = isResidential === true ? "是" : isResidential === false ? "否" : "未知";
  const summaryParts = [];

  if (usageType) {
    summaryParts.push(`用途类型 ${usageType}`);
  }
  if (category) {
    summaryParts.push(`分类 ${category}`);
  }
  if (data.connection_type) {
    summaryParts.push(`连接类型 ${data.connection_type}`);
  }
  if (data.isp) {
    summaryParts.push(`ISP ${data.isp}`);
  }
  if (data.asn) {
    summaryParts.push(`ASN ${data.asn}`);
  }

  return {
    status: "ok",
    provider: "IP2Location",
    label,
    isResidential,
    usageType,
    category,
    connectionType: data.connection_type || "",
    isp: data.isp || "",
    asn: data.asn || "",
    countryName: data.country_name || data.countryName || "",
    summary: summaryParts.join("，") || "未返回更多信息。",
  };
}

function buildIpdataRiskResult(data) {
  const threat = data && typeof data.threat === "object" ? data.threat : {};
  const hardFlags = [
    threat.is_tor,
    threat.is_proxy,
    threat.is_anonymous,
    threat.is_known_attacker,
    threat.is_known_abuser,
    threat.is_threat,
    data.is_threat,
  ].filter((value) => value === true).length;
  const softFlags = [
    threat.is_datacenter,
    threat.is_bogon,
    threat.is_icloud_relay,
  ].filter((value) => value === true).length;

  let level = "低";
  if (hardFlags > 0) {
    level = "高";
  } else if (softFlags > 0) {
    level = "中";
  }

  const threatFlags = {
    isTor: threat.is_tor ?? null,
    isProxy: threat.is_proxy ?? null,
    isAnonymous: threat.is_anonymous ?? null,
    isKnownAttacker: threat.is_known_attacker ?? null,
    isKnownAbuser: threat.is_known_abuser ?? null,
    isDatacenter: threat.is_datacenter ?? null,
    isIcloudRelay: threat.is_icloud_relay ?? null,
    isBogon: threat.is_bogon ?? null,
  };
  const summaryParts = [];
  if (threatFlags.isTor === true) {
    summaryParts.push("Tor");
  }
  if (threatFlags.isProxy === true) {
    summaryParts.push("代理");
  }
  if (threatFlags.isAnonymous === true) {
    summaryParts.push("匿名网络");
  }
  if (threatFlags.isKnownAttacker === true) {
    summaryParts.push("已知攻击者");
  }
  if (threatFlags.isKnownAbuser === true) {
    summaryParts.push("已知滥用者");
  }
  if (threatFlags.isDatacenter === true) {
    summaryParts.push("数据中心");
  }
  if (threatFlags.isIcloudRelay === true) {
    summaryParts.push("iCloud Relay");
  }
  if (threatFlags.isBogon === true) {
    summaryParts.push("bogon");
  }

  return {
    status: "ok",
    provider: "ipdata",
    label: level,
    level,
    isThreat: Boolean(hardFlags),
    threat: threatFlags,
    flags: summaryParts,
    summary: summaryParts.length > 0 ? summaryParts.join("，") : "未发现明显风险标记。",
  };
}

function providerError(provider, error) {
  return {
    status: "error",
    provider,
    label: "查询失败",
    summary: error instanceof Error ? error.message : String(error || "查询失败"),
  };
}

async function checkAbuseIpdb(ip, env, debugEnabled = false) {
  try {
    const data = await providerFetchJson(
      `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose`,
      {
        headers: {
          Accept: "application/json",
          Key: env.ABUSEIPDB_API_KEY,
        },
      },
      "AbuseIPDB 查询失败",
    );
    return attachDebugPayload(buildAbuseResult(data), debugEnabled, data);
  } catch (error) {
    return attachDebugPayload(providerError("AbuseIPDB", error), debugEnabled, error && error.providerData ? error.providerData : null);
  }
}

async function checkIp2Location(ip, env, debugEnabled = false) {
  try {
    const data = await providerFetchJson(
      `https://api.ip2location.io/?key=${encodeURIComponent(env.IP2LOCATION_API_KEY)}&ip=${encodeURIComponent(ip)}&format=json`,
      {
        headers: {
          Accept: "application/json",
        },
      },
      "IP2Location 查询失败",
    );
    return attachDebugPayload(buildIp2LocationResult(data), debugEnabled, data);
  } catch (error) {
    return attachDebugPayload(providerError("IP2Location", error), debugEnabled, error && error.providerData ? error.providerData : null);
  }
}

async function checkIpdata(ip, env, debugEnabled = false) {
  try {
    const data = await providerFetchJson(
      `https://api.ipdata.co/${encodeURIComponent(ip)}?api-key=${encodeURIComponent(env.IPDATA_API_KEY)}`,
      {
        headers: {
          Accept: "application/json",
        },
      },
      "ipdata 查询失败",
    );
    return attachDebugPayload(buildIpdataRiskResult(data), debugEnabled, data);
  } catch (error) {
    return attachDebugPayload(providerError("ipdata", error), debugEnabled, error && error.providerData ? error.providerData : null);
  }
}

function providerSummary(checks) {
  return Object.values(checks)
    .map((item) => `${item.provider}：${item.label}`)
    .join("；");
}

function normalizeVisitorNetwork(request) {
  return {
    city: normalizeText(request.cf && request.cf.city),
    country: normalizeText(request.cf && request.cf.country),
    colo: normalizeText(request.cf && request.cf.colo),
  };
}

function healthCheckResponse(request, env) {
  const missing = missingProviderEnvKeys(env);
  return jsonResponse({
    success: true,
    message: missing.length === 0 ? "Visitor IP Check API 已部署，环境变量已配置。" : `Visitor IP Check API 已部署，但缺少环境变量：${missing.join(", ")}。当前仍可显示访问者 IP。`,
    visitor_ip: readVisitorIp(request) || "",
    visitor_network: normalizeVisitorNetwork(request),
    missing_provider_keys: missing,
  });
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return jsonResponse({ success: true, message: "ok" });
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 204 });
  }

  let debugEnabled = false;
  if (request.method === "GET") {
    const url = new URL(request.url);
    if (url.searchParams.get("health") === "1") {
      return healthCheckResponse(request, env);
    }
    debugEnabled = url.searchParams.get("debug") === "1";
  }

  if (request.method !== "GET") {
    return jsonResponse({ success: false, message: "只支持 GET 请求。" }, 405);
  }

  const ip = readVisitorIp(request);
  if (!ip) {
    return jsonResponse({
      success: false,
      message: "未能识别当前访问者 IP。",
    }, 400);
  }

  if (!isPublicIp(ip)) {
    return jsonResponse({
      success: false,
      ip,
      message: "当前访问者 IP 不是可公开检测的公网地址。",
      visitor_network: normalizeVisitorNetwork(request),
    }, 400);
  }

  const [abuse, residential, risk] = await Promise.all([
    hasProviderKey(env, "ABUSEIPDB_API_KEY")
      ? checkAbuseIpdb(ip, env, debugEnabled)
      : providerNotConfigured("AbuseIPDB", "ABUSEIPDB_API_KEY"),
    hasProviderKey(env, "IP2LOCATION_API_KEY")
      ? checkIp2Location(ip, env, debugEnabled)
      : providerNotConfigured("IP2Location", "IP2LOCATION_API_KEY"),
    hasProviderKey(env, "IPDATA_API_KEY")
      ? checkIpdata(ip, env, debugEnabled)
      : providerNotConfigured("ipdata", "IPDATA_API_KEY"),
  ]);

  const checks = { abuse, residential, risk };
  const message = buildOverallMessage(checks);
  const missing = missingProviderEnvKeys(env);

  return jsonResponse({
    success: overallSuccess(checks),
    ip,
    message,
    checks,
    provider_summary: providerSummary(checks),
    missing_provider_keys: missing,
    notice: missing.length === 0
      ? "打开页面后，当前访问者公网 IP 会发送到 AbuseIPDB、IP2Location、ipdata 进行安全信息查询。"
      : `当前缺少 ${missing.join(", ")}，未配置的检测项将仅显示访问者 IP。`,
    checked_at: new Date().toISOString(),
    visitor_network: normalizeVisitorNetwork(request),
    debug_enabled: debugEnabled,
  });
}
