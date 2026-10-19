import { onRequest as submit } from "./functions/api/submit.js";
import { onRequest as visitorIpCheck } from "./functions/api/visitor-ip-check.js";
import { onRequest as stats } from "./functions/api/stats.js";
import { handleAdmin, handleArchiveSubmit } from "./src/archive/api.js";
import { ArchiveStore } from "./src/archive/store.js";
import { articleForPage, isAdmin, json } from "./src/archive/core.js";
import { renderArticle, renderHome, renderNotFound } from "./src/archive/pages.js";
import { scheduledArchive } from "./src/archive/dispatch.js";
import { publicArticleComments } from "./src/archive/reading-service.js";
import { renderPublicComments } from "./src/archive/comment-pages.js";

export { ArchiveWorkflow } from "./src/archive/workflow.js";
export { ArchiveScheduler } from "./src/archive/scheduler-workflow.js";
export { ArchiveExecutor } from "./src/archive/executor.js";

function html(body, status = 200, privatePage = false) {
  return new Response(body, { status, headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": privatePage ? "no-store" : "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "SAMEORIGIN",
  } });
}

async function publicArchive(request, env) {
  if (env.ARCHIVE_ENABLED !== "true" || !env.ARCHIVE_DB || !env.ARCHIVE_BUCKET) return null;
  const url = new URL(request.url);
  const store = new ArchiveStore(env.ARCHIVE_DB);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const page = Math.max(0, Math.min(1_000_000, Math.trunc(Number(url.searchParams.get("page")) || 0)));
    const articles = await store.listPublished({ limit: 101, offset: page * 100 });
    return html(renderHome(articles.slice(0, 100).map(articleForPage), { page, hasMore: articles.length > 100 }));
  }
  const articleMatch = url.pathname.match(/^\/articles\/([a-f0-9]{32})(?:\.html)?\/?$/i);
  if (articleMatch) {
    const article = await store.getArticle(articleMatch[1].toLowerCase());
    if (!article || article.status !== "published") return html(renderNotFound(), 404);
    if (article.legacy_fallback && !article.body_key) {
      const asset = new URL(`/articles/${article.id}`, url);
      return env.ASSETS.fetch(new Request(asset, { headers: request.headers }));
    }
    const object = article.body_key ? await env.ARCHIVE_BUCKET.get(article.body_key) : null;
    if (!object || object.size > 4 * 1024 * 1024) return html(renderNotFound(), 404);
    let commentHtml = "";
    try { commentHtml = renderPublicComments(await publicArticleComments(env, article.id)); }
    catch { console.warn(JSON.stringify({ event: "archive_comments_unavailable", article_id: article.id })); }
    return html(renderArticle(articleForPage(article), (await object.text()) + commentHtml));
  }
  const mediaMatch = url.pathname.match(/^\/media\/([a-f0-9]{32})\/([a-f0-9]{64})$/);
  if (mediaMatch) {
    const article = await store.getArticle(mediaMatch[1]);
    if (!article || article.status !== "published") return new Response("Not found", { status: 404 });
    const key = `articles/${article.id}/images/${mediaMatch[2]}`;
    const media = await store.getPublicMedia(article.id, key);
    if (!media) return new Response("Not found", { status: 404 });
    const object = await env.ARCHIVE_BUCKET.get(media.key);
    if (!object) return new Response("Not found", { status: 404 });
    return new Response(object.body, { headers: {
      "content-type": media.content_type || object.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    } });
  }
  if (url.pathname.startsWith("/media/")) return new Response("Not found", { status: 404 });
  return null;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/admin/")) return await handleAdmin(request, env);
      const comments = url.pathname.match(/^\/api\/articles\/([a-f\d]{32})\/comments$/);
      if (comments) {
        if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
        const snapshot = await publicArticleComments(env, comments[1]);
        return json(snapshot ? { status: snapshot.complete ? "ready" : "partial", ...snapshot }
          : { status: "unavailable", comments: null });
      }
      if (url.pathname === "/admin" || url.pathname === "/admin.html") {
        if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
        const asset = await env.ASSETS.fetch(new Request(new URL("/admin", url), { headers: request.headers }));
        return new Response(asset.body, { status: asset.status, headers: { ...Object.fromEntries(asset.headers), "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
      }
      if (url.pathname === "/api/submit") {
        return env.ARCHIVE_ENABLED === "true" || await isAdmin(request, env) ? await handleArchiveSubmit(request, env) : await submit({ request, env });
      }
      if (url.pathname === "/api/visitor-ip-check") return await visitorIpCheck({ request, env });
      if (url.pathname === "/api/stats") return await stats({ request, env });
      if (["GET", "HEAD"].includes(request.method)) {
        const archive = await publicArchive(request, env);
        if (archive) return request.method === "HEAD" ? new Response(null, archive) : archive;
      }
      return await env.ASSETS.fetch(request);
    } catch (error) {
      const status = error.status || (error.code === "LOGIN_REQUIRED" || error.code === "LOGIN_EXPIRED" || error.code === "CHALLENGE_REQUIRED" ? 409 : 500);
      const safe = status < 500 || error.name === "CollectorError";
      console.warn(JSON.stringify({ event: "archive_request_error", code: error.code || "REQUEST_FAILED", status }));
      const retryAt = Number.isSafeInteger(error.retry_at) && error.retry_at > Date.now() ? error.retry_at : null;
      return json({ success: false, code: error.code || "REQUEST_FAILED", error: safe ? error.message : "服务暂时不可用，请稍后重试。",
        ...(retryAt ? { retry_at: retryAt } : {}),
      }, status, retryAt ? { "Retry-After": String(Math.ceil((retryAt - Date.now()) / 1000)) } : {});
    }
  },
  async scheduled(controller, env) { await scheduledArchive(controller, env); },
};
