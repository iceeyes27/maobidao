const SITE_NAME = "公开文章归档";
const ARTICLE_ID = /^[a-f0-9]{32}$/i;
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function originalUrl(article) {
  try {
    const url = new URL(article.original_url || article.url);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function publication(value) {
  if (value === undefined || value === null || value === "") return { text: "", iso: "", timestamp: 0 };
  // Older saved pages have local date strings without a timezone. Preserve their display.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    const text = value.replace("T", " ");
    const timestamp = Date.parse(`${value.replace(" ", "T")}+08:00`);
    return Number.isFinite(timestamp) ? { text, iso: `${value.replace(" ", "T")}+08:00`, timestamp } : { text: "", iso: "", timestamp: 0 };
  }
  let normalized = value;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value))) {
    const number = Number(value);
    normalized = number < 1e12 ? number * 1000 : number;
  }
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) return { text: "", iso: "", timestamp: 0 };
  return { text: dateFormatter.format(date).replaceAll("/", "-"), iso: date.toISOString(), timestamp: date.getTime() };
}

function normalizeArticle(article) {
  let publishedAt = article.first_published_at ?? article.published_at ?? article.publish_time;
  const url = originalUrl(article);
  const legacyWechatTime = publishedAt === article.publish_time && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(String(publishedAt || ""))
    && url && new URL(url).hostname === "mp.weixin.qq.com";
  if (legacyWechatTime) publishedAt = `${publishedAt.replace(" ", "T")}Z`;
  return {
    ...article,
    title: article.title || "未命名文章",
    author: article.author || article.account_name || "",
    source_name: article.source_name || article.account_name || "",
    published_at: publishedAt,
    original_url: url,
  };
}

function structuredData(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function shell(title, description, content, { schema, script = "", article = false } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escapeHtml(description)}">
  <title>${escapeHtml(title)}</title>
  <meta property="og:type" content="${article ? "article" : "website"}">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta name="twitter:card" content="summary">
  <link rel="stylesheet" href="/assets/style.css">
  ${schema ? `<script type="application/ld+json">${structuredData(schema)}</script>` : ""}
</head>
<body>
  <main class="site">${content}</main>
  ${script}
</body>
</html>`;
}

function statsScript(page, articleId = "") {
  const article = page === "article";
  if (article && !ARTICLE_ID.test(articleId)) return "";
  const payload = article ? { page, article_id: articleId.toLowerCase() } : { page };
  return `<script>
(() => {
  const status = document.getElementById("${article ? "article" : "site"}-stats-status");
  const counters = ${article ? '[[' + '"article-pv", "article_pv"' + ']]' : '[["site-pv", "site_pv"], ["site-uv", "site_uv"]]'};
  async function loadStats() {
    try {
      const response = await fetch("/api/stats", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(${JSON.stringify(payload)})
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error("统计暂时无法使用。");
      for (const [id, key] of counters) {
        const node = document.getElementById(id);
        const value = Number(data[key]);
        if (node) node.textContent = Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(value) : "-";
      }
      if (status) status.textContent = "统计已更新。";
    } catch {
      for (const [id] of counters) { const node = document.getElementById(id); if (node) node.textContent = "加载失败"; }
      if (status) { status.textContent = "统计暂时无法使用。"; status.classList.add("error"); }
    }
  }
  loadStats();
})();
</script>`;
}

function metadata(article) {
  const date = publication(article.published_at);
  const parts = [];
  if (article.author) parts.push(`<span class="meta-item"><span class="meta-key">作者</span><span class="meta-value">${escapeHtml(article.author)}</span></span>`);
  if (article.source_name && article.source_name !== article.author) parts.push(`<span class="meta-item"><span class="meta-key">来源</span><span class="meta-value">${escapeHtml(article.source_name)}</span></span>`);
  if (date.text) parts.push(`<span class="meta-item"><span class="meta-key">发布时间</span><time class="meta-value" datetime="${escapeHtml(date.iso)}">${escapeHtml(date.text)}（北京时间）</time></span>`);
  return parts.join("\n");
}

export function renderHome(articles, { legacyArticles = [], page = 0, hasMore = false } = {}) {
  const pageIndex = Number.isFinite(Number(page)) ? Math.max(0, Math.min(1_000_000, Math.trunc(Number(page)))) : 0;
  const unique = new Map();
  for (const item of [...(articles || []), ...(legacyArticles || [])]) {
    if (!item || !ARTICLE_ID.test(String(item.id || "")) || item.success === false || (item.status && item.status !== "published")) continue;
    const id = String(item.id).toLowerCase();
    if (!unique.has(id)) unique.set(id, normalizeArticle({ ...item, id }));
  }
  const published = [...unique.values()].sort((first, second) => publication(second.published_at).timestamp - publication(first.published_at).timestamp);
  const items = published.map((article) => {
    const href = `/articles/${article.id}`;
    const summary = String(article.summary || article.content_text || "").trim();
    return `<li class="article-item">
      <div class="article-title-row">
        <h3><a href="${href}">${escapeHtml(article.title)}</a></h3>
        ${article.source_name ? `<span class="source-badge">${escapeHtml(article.source_name)}</span>` : ""}
      </div>
      <div class="article-meta">${metadata(article)}</div>
      ${summary ? `<p class="article-summary"><a href="${href}">${escapeHtml(summary.slice(0, 160))}${summary.length > 160 ? "…" : ""}</a></p>` : ""}
    </li>`;
  }).join("\n");
  const pagination = pageIndex > 0 || hasMore ? `<nav class="toolbar" aria-label="文章分页">
    ${pageIndex > 0 ? `<a class="button secondary" href="${pageIndex === 1 ? "/" : `/?page=${pageIndex - 1}`}">上一页</a>` : "<span></span>"}
    <span class="help">第 ${pageIndex + 1} 页</span>
    ${hasMore ? `<a class="button secondary" href="/?page=${pageIndex + 1}">下一页</a>` : "<span></span>"}
  </nav>` : "";
  return shell(SITE_NAME, "收录公开文章，保留作者、来源和原文链接，提供稳定的阅读页面。", `
    <header class="site-header">
      <h1 class="site-title">${SITE_NAME}</h1>
      <p class="site-desc">收录公开文章，保留作者、来源与原文入口。</p>
      <div class="toolbar">
        <span class="meta">${pageIndex || hasMore ? "本页显示" : "已收录"} ${published.length} 篇文章</span>
        <div class="toolbar-actions"><a class="button secondary" href="/visitor-ip">访问 IP 检测工具</a><a class="button secondary" href="/admin">管理员入口</a></div>
      </div>
    </header>
    <section class="summary-panel" aria-label="站点概览">
      <div class="summary-grid">
        <span class="summary-stat"><strong>${published.length} 篇</strong><span>文章</span></span>
        <span class="summary-stat"><strong id="site-pv">-</strong><span>浏览</span></span>
        <span class="summary-stat"><strong id="site-uv">-</strong><span>今日访客</span></span>
      </div>
      <p id="site-stats-status" class="help stats-status">正在准备统计…</p>
    </section>
    <section class="panel">
      <header class="panel-header"><h2 class="section-title">最新归档</h2><p class="help">点击标题阅读文章，详情页保留原文链接。</p></header>
      ${published.length ? `<ul class="article-list">${items}</ul>` : '<p class="empty">暂无文章。</p>'}
      ${pagination}
    </section>`, {
    schema: [{ "@context": "https://schema.org", "@type": "WebSite", name: SITE_NAME }, {
      "@context": "https://schema.org", "@type": "ItemList", itemListElement: published.map((article, index) => ({ "@type": "ListItem", position: pageIndex * 100 + index + 1, name: article.title, url: `/articles/${article.id}` })),
    }],
    script: statsScript("site"),
  });
}

export function renderArticle(article, bodyHtml) {
  const value = normalizeArticle(article);
  const title = `${value.title}${value.author ? ` - ${value.author}` : ""} - ${SITE_NAME}`;
  const description = `${value.title}，保留作者、来源与原文链接。`;
  const date = publication(value.published_at);
  const schema = { "@context": "https://schema.org", "@type": "Article", headline: value.title };
  if (date.iso) schema.datePublished = date.iso;
  if (value.author) schema.author = { "@type": "Person", name: value.author };
  if (value.original_url) schema.isBasedOn = value.original_url;
  // bodyHtml is the already-sanitized, fully saved body from the capture pipeline.
  return shell(title, description, `
    <article class="article">
      <p><a href="/">返回首页</a></p>
      <h1 class="site-title">${escapeHtml(value.title)}</h1>
      <div class="meta">${metadata(value)}</div>
      <div class="stats-inline">
        <span class="meta-item"><span class="meta-key">阅读量</span><span id="article-pv" class="meta-value">加载中…</span></span>
        <span id="article-stats-status" class="stats-status">正在准备统计…</span>
      </div>
      <div class="source-card">
        <strong>原文来源</strong>
        ${value.author ? `<span>作者：${escapeHtml(value.author)}</span>` : ""}
        ${value.source_name ? `<span>来源：${escapeHtml(value.source_name)}</span>` : ""}
        ${value.original_url ? `<a href="${escapeHtml(value.original_url)}" target="_blank" rel="noopener noreferrer">查看原文</a>` : ""}
      </div>
      <div class="article-body">${String(bodyHtml || "")}</div>
      ${value.original_url ? `<p class="links"><a href="${escapeHtml(value.original_url)}" target="_blank" rel="noopener noreferrer">查看原文链接</a></p>` : ""}
    </article>`, { schema, script: statsScript("article", String(value.id || "")), article: true });
}

export function renderNotFound() {
  return shell(`文章未找到 - ${SITE_NAME}`, "暂时找不到这篇文章。", '<section class="panel"><h1 class="site-title">文章未找到</h1><p>这篇文章暂时无法查看，请返回首页查找其他文章。</p><p><a class="button secondary" href="/">返回首页</a></p></section>');
}
