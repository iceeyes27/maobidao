import sanitizeHtml from "sanitize-html";

const DAY = 86_400_000;
const CHINA_OFFSET = 8 * 3_600_000;
const encoder = new TextEncoder();

export class ArchiveError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
    this.status = status;
  }
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function stableId(value) {
  return (await sha256(value)).slice(0, 32);
}

export function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ArchiveError("INVALID_URL", "文章地址无效。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ArchiveError("INVALID_URL", "仅支持没有登录信息的 HTTP 或 HTTPS 地址。");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host.includes(".") || host === "localhost" || /\.(?:local|localhost|internal|test|invalid)$/.test(host)
      || host.includes(":") || /^\d+(?:\.\d+){3}$/.test(host)
      || (url.port && !["80", "443"].includes(url.port))) {
    throw new ArchiveError("PRIVATE_URL", "仅支持公开网站的标准端口地址。");
  }
  url.hash = "";
  return url;
}

export function sourceArticleKey(value) {
  const url = publicUrl(value);
  if (url.hostname === "mp.weixin.qq.com") {
    const biz = url.searchParams.get("__biz");
    const mid = url.searchParams.get("mid") || url.searchParams.get("appmsgid");
    const idx = url.searchParams.get("idx") || "1";
    if (biz && mid) return `wechat:${biz}:${mid}:${idx}`;
    if (/^\/s\/[\w-]+\/?$/.test(url.pathname)) return `wechat:short:${url.pathname.replace(/\/$/, "")}`;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|fbclid$|gclid$|from$|isappinstalled$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return `url:${url.href}`;
}

export function beijingDate(milliseconds = Date.now()) {
  return new Date(milliseconds + CHINA_OFFSET).toISOString().slice(0, 10);
}

function dateStart(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ArchiveError("INVALID_DATE", "请选择有效的开始日期和结束日期。");
  }
  const milliseconds = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(milliseconds) || beijingDate(milliseconds) !== value) {
    throw new ArchiveError("INVALID_DATE", "日期不存在。");
  }
  return milliseconds;
}

export function historyRange(startDate, endDate, now = Date.now()) {
  const start = dateStart(startDate);
  const lastDay = dateStart(endDate);
  if (lastDay < start) throw new ArchiveError("INVALID_RANGE", "结束日期不能早于开始日期。");
  if (start > now || lastDay > dateStart(beijingDate(now))) {
    throw new ArchiveError("FUTURE_RANGE", "历史采集不能选择未来日期。");
  }
  return { start, end: Math.min(lastDay + DAY, now) };
}

export function automaticWindow(milliseconds = Date.now()) {
  const date = beijingDate(milliseconds);
  const start = dateStart(date) + (21 * 60 + 30) * 60_000;
  const end = dateStart(date) + (23 * 60 + 30) * 60_000;
  return { date, start, end, active: milliseconds >= start && milliseconds <= end, final: milliseconds === end };
}

export function eligibleArticle(article, source, window) {
  const timestamp = Number(article.first_published_at ?? article.published_at);
  return article.time_trusted !== false && Number.isFinite(timestamp) && timestamp > 0
    && timestamp >= window.start && timestamp < window.end
    && timestamp > Number(source.activated_at || 0);
}

export function articleForPage(article) {
  return {
    ...article,
    author: article.author || article.metadata?.author || article.account_name || "",
    source_name: article.source_name || article.metadata?.source_name || article.account_name || "",
    published_at: article.first_published_at || article.publish_time || null,
    original_url: article.url || article.original_url || "",
  };
}

export function sanitizeBody(html, imageMap = new Map(), { legacy = false } = {}) {
  return sanitizeHtml(String(html || ""), {
    allowedTags: ["p", "div", "section", "article", "span", "br", "hr", "strong", "b", "em", "i", "u", "s", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "a", "img", "figure", "figcaption", "sup", "sub"],
    allowedAttributes: { a: ["href", "title", "rel", "target"], img: ["src", "alt", "width", "height", "loading"], "*": ["style"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"] },
    allowedSchemes: ["https", "http"],
    allowProtocolRelative: false,
    allowedStyles: {
      "*": { "text-align": [/^(?:left|right|center|justify)$/], "font-weight": [/^(?:normal|bold|[1-9]00)$/], "font-style": [/^(?:normal|italic)$/], color: [/^(?:#[\da-f]{3,8}|rgb\([\d ,]+\))$/i], "background-color": [/^(?:#[\da-f]{3,8}|rgb\([\d ,]+\))$/i] },
    },
    transformTags: {
      a: (_tag, attributes) => {
        const result = { title: attributes.title || "", rel: "noopener noreferrer", target: "_blank" };
        try { result.href = publicUrl(attributes.href).href; } catch { /* Invalid source links render as text. */ }
        return { tagName: "a", attribs: result };
      },
      img: (_tag, attributes) => {
        const original = attributes["data-src"] || attributes.src || "";
        const mapped = imageMap.get(original);
        const safeLegacy = legacy && /^\/assets\/images\/[\da-f]{32}\/[\w.-]+$/.test(original);
        const src = mapped || (safeLegacy ? original : "");
        return { tagName: "img", attribs: { src, alt: attributes.alt || "", loading: "lazy" } };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
    enforceHtmlBoundary: true,
  });
}

export function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...extraHeaders } });
}

export async function readJson(request, maxBytes = 64 * 1024) {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new ArchiveError("TOO_LARGE", "提交内容过大。", 413);
  if (!request.body) throw new ArchiveError("INVALID_JSON", "提交内容为空。");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new ArchiveError("TOO_LARGE", "提交内容过大。", 413); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError("INVALID_JSON", "提交内容格式无效。");
  } finally { reader.releaseLock(); }
}

export function checkOrigin(request) {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ArchiveError("BAD_ORIGIN", "请从本站管理页发起操作。", 403);
  }
}

export async function equalSecret(left, right) {
  const a = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(left || ""))));
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(right || ""))));
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signature(value, password) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(`maobidao-admin-v1:${password}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export async function createAdminSession(password, now = Date.now()) {
  const value = `${now + 8 * 3_600_000}.${crypto.randomUUID()}`;
  return `${value}.${await signature(value, password)}`;
}

export async function isAdmin(request, env, now = Date.now()) {
  if (!env.SUBMIT_PASSWORD) return false;
  const cookie = request.headers.get("cookie") || "";
  const token = cookie.match(/(?:^|;\s*)maobidao_admin=([^;]+)/)?.[1] || "";
  const match = token.match(/^(\d{13})\.([\da-f-]{36})\.([\w-]{43})$/);
  if (!match || Number(match[1]) <= now || Number(match[1]) > now + 8 * 3_600_000) return false;
  return equalSecret(match[3], await signature(`${match[1]}.${match[2]}`, env.SUBMIT_PASSWORD));
}

export function adminCookie(request, value, maxAge = 28_800) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `maobidao_admin=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
