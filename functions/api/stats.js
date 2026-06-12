const VISITOR_COOKIE_NAME = "maobidao_vid";
const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;
const UV_TIMEZONE = "Asia/Shanghai";
const ARTICLE_ID_RE = /^[a-f0-9]{32}$/i;
const BOT_USER_AGENT_RE = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|python-requests|curl\b|wget\b|go-http-client|HeadlessChrome/i;
const PREFETCH_HEADER_RE = /prefetch|prerender|preview/i;

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function methodNotAllowed() {
  return jsonResponse({ success: false, message: "只支持 GET / POST 请求。" }, 405);
}

function missingEnvKeys(env) {
  return ["STATS_COUNTER"].filter((key) => !env[key]);
}

function counterStub(env) {
  const id = env.STATS_COUNTER.idFromName("global");
  return env.STATS_COUNTER.get(id);
}

async function recordVisit(env, page, articleId, visitorId, day) {
  const stub = counterStub(env);
  const response = await stub.fetch("https://do/record", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page, articleId, visitorId, day }),
  });
  return response.json();
}

async function readSnapshot(env, page, articleId, day) {
  const stub = counterStub(env);
  const params = new URLSearchParams({ page, day });
  if (articleId) params.set("articleId", articleId);
  const response = await stub.fetch(`https://do/snapshot?${params}`);
  return response.json();
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies[rawName] = rest.join("=");
  }
  return cookies;
}

function createVisitorId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function buildVisitorCookie(requestUrl, visitorId) {
  const url = new URL(requestUrl);
  const parts = [
    `${VISITOR_COOKIE_NAME}=${visitorId}`,
    "Path=/",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (url.protocol === "https:") {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function normalizeArticleId(value) {
  const articleId = String(value || "").trim().toLowerCase();
  return ARTICLE_ID_RE.test(articleId) ? articleId : "";
}

function chinaDateString(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: UV_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(now);
}

async function readPayload(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function isPrefetchRequest(request) {
  const headers = [
    request.headers.get("purpose"),
    request.headers.get("x-moz"),
    request.headers.get("sec-purpose"),
  ];
  return headers.some((value) => PREFETCH_HEADER_RE.test(String(value || "")));
}

function isBotRequest(request) {
  const userAgent = String(request.headers.get("user-agent") || "");
  return BOT_USER_AGENT_RE.test(userAgent);
}

function ignoredReason(request) {
  if (isPrefetchRequest(request)) {
    return "prefetch";
  }
  if (isBotRequest(request)) {
    return "bot";
  }
  return "";
}

function successMessage(page, counted, reason, day) {
  if (!counted && reason === "prefetch") {
    return `已返回统计数据，本次预取请求不计入统计。今日 UV 按 ${UV_TIMEZONE} 日期 ${day} 去重。`;
  }
  if (!counted && reason === "bot") {
    return `已返回统计数据，本次机器人请求不计入统计。今日 UV 按 ${UV_TIMEZONE} 日期 ${day} 去重。`;
  }
  if (page === "article") {
    return `已更新文章阅读量，今日 UV 按 ${UV_TIMEZONE} 日期 ${day} 去重。`;
  }
  return `已更新站点统计，今日 UV 按 ${UV_TIMEZONE} 日期 ${day} 去重。`;
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return jsonResponse({ success: true, message: "ok" });
  }

  const missing = missingEnvKeys(env);
  const day = chinaDateString();

  if (request.method === "GET") {
    return jsonResponse({
      success: missing.length === 0,
      message: missing.length === 0
        ? "Stats API 已部署，Durable Object 绑定已配置。"
        : `Stats API 已部署，但缺少环境绑定：${missing.join(", ")}`,
      do_configured: missing.length === 0,
      cookie_name: VISITOR_COOKIE_NAME,
      uv_scope: "daily",
      uv_timezone: UV_TIMEZONE,
      uv_date: day,
      bot_filtering: true,
      prefetch_filtering: true,
    }, missing.length === 0 ? 200 : 500);
  }

  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  if (missing.length > 0) {
    return jsonResponse({ success: false, message: `服务端配置不完整，缺少：${missing.join(", ")}` }, 500);
  }

  const payload = await readPayload(request);
  if (!payload || typeof payload !== "object") {
    return jsonResponse({ success: false, message: "请求 JSON 格式无效。" }, 400);
  }

  const page = String(payload.page || "").trim().toLowerCase();
  if (!["site", "article"].includes(page)) {
    return jsonResponse({ success: false, message: "page 只支持 site 或 article。" }, 400);
  }

  const articleId = page === "article" ? normalizeArticleId(payload.article_id) : "";
  if (page === "article" && !articleId) {
    return jsonResponse({ success: false, message: "article_id 无效。" }, 400);
  }

  const cookies = parseCookies(request.headers.get("cookie"));
  let visitorId = String(cookies[VISITOR_COOKIE_NAME] || "").trim();
  let setCookie = "";

  if (!visitorId) {
    visitorId = createVisitorId();
    setCookie = buildVisitorCookie(request.url, visitorId);
  }

  try {
    const reason = ignoredReason(request);
    let snapshot;

    if (reason) {
      snapshot = await readSnapshot(env, page, articleId, day);
    } else {
      const result = await recordVisit(env, page, articleId, visitorId, day);
      snapshot = {
        site_pv: result.sitePv,
        site_uv: result.siteUv,
        article_pv: result.articlePv,
      };
    }

    const headers = setCookie ? { "set-cookie": setCookie } : {};
    return jsonResponse({
      success: true,
      counted: !reason,
      ignored_reason: reason || null,
      message: successMessage(page, !reason, reason, day),
      page,
      uv_scope: "daily",
      uv_timezone: UV_TIMEZONE,
      uv_date: day,
      site_pv: snapshot.site_pv,
      site_uv: snapshot.site_uv,
      article_id: articleId || undefined,
      article_pv: snapshot.article_pv,
    }, 200, headers);
  } catch (error) {
    return jsonResponse({ success: false, message: error instanceof Error ? error.message : "统计写入失败。" }, 500);
  }
}
