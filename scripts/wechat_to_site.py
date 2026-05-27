#!/usr/bin/env python3
"""Build a static archive site from manually submitted WeChat article URLs."""

from __future__ import annotations

import hashlib
import html
import json
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import requests
from bs4 import BeautifulSoup


ROOT = Path(__file__).resolve().parents[1]
DATA_LINKS = ROOT / "data" / "links.json"
URLS_TXT = ROOT / "urls.txt"
PUBLIC = ROOT / "public"
ARTICLES_DIR = PUBLIC / "articles"
ASSETS_DIR = PUBLIC / "assets"
IMAGES_DIR = ASSETS_DIR / "images"
PUBLIC_DATA_DIR = PUBLIC / "data"
ARTICLES_JSON = PUBLIC_DATA_DIR / "articles.json"

WECHAT_PREFIX = "https://mp.weixin.qq.com/"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0 Safari/537.36"
)


def now_string() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def read_json_file(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def is_valid_wechat_url(url: str) -> bool:
    return url.strip().startswith(WECHAT_PREFIX)


def normalize_url(url: str) -> str:
    return url.strip()


def read_links_from_json() -> list[str]:
    data = read_json_file(DATA_LINKS, {"links": []})
    links = data.get("links", [])
    urls: list[str] = []

    if isinstance(links, list):
        for item in links:
            if isinstance(item, dict):
                url = item.get("url", "")
            elif isinstance(item, str):
                url = item
            else:
                continue
            url = normalize_url(url)
            if url:
                urls.append(url)
    return urls


def read_links_from_txt() -> list[str]:
    if not URLS_TXT.exists():
        return []

    urls: list[str] = []
    for line in URLS_TXT.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        urls.append(line)
    return urls


def load_urls() -> list[str]:
    seen: set[str] = set()
    urls: list[str] = []
    for url in [*read_links_from_json(), *read_links_from_txt()]:
        normalized = normalize_url(url)
        if not is_valid_wechat_url(normalized) or normalized in seen:
            continue
        seen.add(normalized)
        urls.append(normalized)
    return urls


def load_cached_articles() -> dict[str, dict[str, Any]]:
    data = read_json_file(ARTICLES_JSON, {"articles": []})
    articles = data.get("articles", [])
    cached: dict[str, dict[str, Any]] = {}

    if not isinstance(articles, list):
        return cached

    for article in articles:
        if not isinstance(article, dict):
            continue
        url = article.get("url", "")
        if url and article.get("success"):
            cached[url] = article
    return cached


def article_id_for_url(url: str) -> str:
    return hashlib.md5(url.encode("utf-8")).hexdigest()


def extract_script_string(page: str, name: str) -> str:
    pattern = rf"var\s+{re.escape(name)}\s*=\s*['\"]([^'\"]*)['\"]"
    match = re.search(pattern, page)
    if not match:
        return ""
    return html.unescape(match.group(1)).strip()


def parse_publish_time(page: str) -> str:
    ct = extract_script_string(page, "ct")
    if not ct:
        return ""
    try:
        return datetime.utcfromtimestamp(int(ct)).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OSError):
        return ""


def clean_text(value: str) -> str:
    return " ".join(value.split())


def meta_content(soup: BeautifulSoup, selector: str) -> str:
    element = soup.select_one(selector)
    if not element:
        return ""
    return clean_text(element.get("content", ""))


def image_extension_from_url(url: str) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    wx_fmt = query.get("wx_fmt", [""])[0].lower()
    if wx_fmt in {"jpeg", "jpg", "png", "gif", "webp"}:
        return "jpg" if wx_fmt == "jpeg" else wx_fmt

    suffix = Path(parsed.path).suffix.lower().lstrip(".")
    if suffix in {"jpeg", "jpg", "png", "gif", "webp"}:
        return "jpg" if suffix == "jpeg" else suffix

    return ""


def image_extension_from_type(content_type: str) -> str:
    content_type = content_type.split(";", 1)[0].strip().lower()
    return {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
    }.get(content_type, "jpg")


def download_image(source_url: str, article_url: str, image_dir: Path) -> str:
    digest = hashlib.md5(source_url.encode("utf-8")).hexdigest()
    existing = next(image_dir.glob(f"{digest}.*"), None)
    if existing:
        return f"/assets/images/{image_dir.name}/{existing.name}"

    try:
        response = requests.get(
            source_url,
            headers={
                "User-Agent": USER_AGENT,
                "Referer": article_url,
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
            },
            timeout=20,
        )
        response.raise_for_status()
    except requests.RequestException:
        return source_url

    content_type = response.headers.get("content-type", "")
    if content_type and not content_type.lower().startswith("image/"):
        return source_url

    extension = image_extension_from_url(source_url) or image_extension_from_type(content_type)
    filename = f"{digest}.{extension}"
    target = image_dir / filename
    target.write_bytes(response.content)
    return f"/assets/images/{image_dir.name}/{filename}"


def localize_article_images(article: dict[str, Any]) -> dict[str, Any]:
    if not article.get("success") or not article.get("content_html"):
        return article

    soup = BeautifulSoup(article["content_html"], "lxml")
    root = soup.select_one("#js_content") or soup.find("div")
    if not root:
        return article

    image_dir = IMAGES_DIR / article["id"]
    image_dir.mkdir(parents=True, exist_ok=True)

    changed = False
    for image in root.select("img"):
        source = image.get("src") or image.get("data-src") or image.get("data-original")
        if not source or source.startswith("/assets/images/"):
            continue
        if not source.startswith("http://") and not source.startswith("https://"):
            continue

        local_src = download_image(source, article["url"], image_dir)
        if local_src != source:
            image["data-original-src"] = source
            image["src"] = local_src
            image["data-src"] = local_src
            changed = True

    if changed:
        article["content_html"] = str(root)

    return article


def fetch_article(url: str) -> dict[str, Any]:
    article_id = article_id_for_url(url)
    filename = f"{article_id}.html"
    fetched_at = now_string()
    base = {
        "id": article_id,
        "url": url,
        "filename": filename,
        "title": "",
        "account_name": "",
        "publish_time": "",
        "content_text": "",
        "content_html": "",
        "fetched_at": fetched_at,
        "success": False,
        "error": "",
    }

    try:
        response = requests.get(
            url,
            headers={"User-Agent": USER_AGENT},
            timeout=20,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        base["error"] = f"请求失败：{exc.__class__.__name__}"
        return base

    soup = BeautifulSoup(response.text, "lxml")

    title_el = soup.select_one("#activity-name")
    account_el = soup.select_one("#js_name")
    content_el = soup.select_one("#js_content")

    title = clean_text(title_el.get_text(" ", strip=True)) if title_el else ""
    if not title:
        title = meta_content(soup, 'meta[property="og:title"]')
    account_name = clean_text(account_el.get_text(" ", strip=True)) if account_el else ""
    if not account_name:
        account_name = extract_script_string(response.text, "nickname")

    if content_el:
        for script_or_style in content_el.select("script, style"):
            script_or_style.decompose()
        content_el.attrs.pop("style", None)
        content_el.attrs.pop("hidden", None)
        for image in content_el.select("img"):
            if not image.get("src"):
                source = image.get("data-src") or image.get("data-original")
                if source:
                    image["src"] = source
            image["loading"] = image.get("loading") or "lazy"
        content_html = str(content_el)
        content_text = clean_text(content_el.get_text(" ", strip=True))
    else:
        content_html = ""
        content_text = ""

    base.update(
        {
            "title": title or "未命名文章",
            "account_name": account_name,
            "publish_time": parse_publish_time(response.text),
            "content_text": content_text,
            "content_html": content_html,
            "success": bool(content_el),
            "error": "" if content_el else "未找到正文内容 #js_content",
        }
    )
    return base


def ensure_dirs() -> None:
    ARTICLES_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DATA_DIR.mkdir(parents=True, exist_ok=True)
    for old_article in ARTICLES_DIR.glob("*.html"):
        old_article.unlink()


def write_style() -> None:
    css = """\
:root {
  color-scheme: light;
  --bg: #f4f5f7;
  --card: #ffffff;
  --text: #1f2328;
  --muted: #68707d;
  --line: #d8dee6;
  --accent: #0f766e;
  --accent-dark: #115e59;
  --danger: #b42318;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  line-height: 1.8;
}

a {
  color: var(--accent);
  text-decoration: none;
}

a:hover {
  color: var(--accent-dark);
  text-decoration: underline;
}

.site {
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 18px 56px;
}

.panel,
.article {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 28px;
}

.site-header {
  margin-bottom: 22px;
}

.site-title {
  margin: 0 0 8px;
  font-size: 30px;
  line-height: 1.25;
}

.site-desc,
.meta,
.empty,
.help {
  color: var(--muted);
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin-top: 16px;
}

.button,
button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 42px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  font: inherit;
  line-height: 1.2;
  padding: 9px 16px;
}

.button.secondary {
  background: #fff;
  color: var(--accent);
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}

.article-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.article-item {
  padding: 22px 0;
  border-bottom: 1px solid var(--line);
}

.article-item:first-child {
  padding-top: 0;
}

.article-item:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.article-item h2 {
  margin: 0 0 8px;
  font-size: 22px;
  line-height: 1.35;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin: 8px 0;
  font-size: 14px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
}

.article-body {
  margin-top: 24px;
  overflow-wrap: anywhere;
}

.article-body #js_content,
.article-body .rich_media_content {
  visibility: visible !important;
  opacity: 1 !important;
}

.article-body img,
.article-body video,
.article-body iframe {
  max-width: 100%;
}

.article-body img {
  height: auto;
}

label {
  display: block;
  margin: 18px 0 8px;
  font-weight: 600;
}

input,
textarea {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #fff;
  color: var(--text);
  font: inherit;
  padding: 10px 12px;
}

textarea {
  min-height: 220px;
  resize: vertical;
}

.result {
  margin-top: 16px;
  min-height: 28px;
}

.result.ok {
  color: var(--accent-dark);
}

.result.error {
  color: var(--danger);
}

@media (max-width: 640px) {
  .site {
    padding: 22px 12px 40px;
  }

  .panel,
  .article {
    padding: 20px;
  }

  .site-title {
    font-size: 25px;
  }
}
"""
    (ASSETS_DIR / "style.css").write_text(css, encoding="utf-8")


def page_shell(title: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{html.escape(title)}</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <main class="site">
{body}
  </main>
</body>
</html>
"""


def article_meta(article: dict[str, Any]) -> str:
    parts = []
    if article.get("account_name"):
        parts.append(f"<span>公众号：{html.escape(article['account_name'])}</span>")
    if article.get("publish_time"):
        parts.append(f"<span>发布时间：{html.escape(article['publish_time'])}</span>")
    if article.get("fetched_at"):
        parts.append(f"<span>抓取时间：{html.escape(article['fetched_at'])}</span>")
    if not article.get("success"):
        parts.append(f"<span>状态：抓取失败</span>")
    return "\n        ".join(parts)


def write_index(articles: list[dict[str, Any]]) -> None:
    items = []
    successful_count = sum(1 for article in articles if article.get("success"))
    for article in articles:
        title = html.escape(article.get("title") or "未命名文章")
        detail_href = f"/articles/{html.escape(article['filename'])}"
        original_href = html.escape(article["url"], quote=True)
        error = article.get("error", "")
        error_html = f'<p class="meta">错误：{html.escape(error)}</p>' if error else ""
        items.append(
            f"""      <li class="article-item">
        <h2><a href="{detail_href}">{title}</a></h2>
        <div class="meta">
        {article_meta(article)}
        </div>
        {error_html}
        <div class="links">
          <a href="{detail_href}">查看归档页</a>
          <a href="{original_href}" target="_blank" rel="noopener noreferrer">查看原文</a>
        </div>
      </li>"""
        )

    if items:
        list_html = '<ul class="article-list">\n' + "\n".join(items) + "\n    </ul>"
    else:
        list_html = '<p class="empty">暂无文章。请通过提交页添加公开微信公众号文章链接。</p>'

    body = f"""    <header class="site-header">
      <h1 class="site-title">微信公众号文章归档</h1>
      <p class="site-desc">手动提交的公开微信公众号文章链接归档。</p>
      <div class="toolbar">
        <span class="meta">共 {len(articles)} 条链接，成功归档 {successful_count} 篇</span>
        <a class="button secondary" href="/submit.html">提交新文章链接</a>
      </div>
    </header>
    <section class="panel">
{list_html}
    </section>"""
    (PUBLIC / "index.html").write_text(page_shell("微信公众号文章归档", body), encoding="utf-8")


def write_article_page(article: dict[str, Any]) -> None:
    title = html.escape(article.get("title") or "未命名文章")
    original_href = html.escape(article["url"], quote=True)
    content_html = article.get("content_html") or ""
    if not article.get("success"):
        error = html.escape(article.get("error") or "抓取失败")
        content_html = f'<p class="result error">{error}</p>'

    body = f"""    <article class="article">
      <p><a href="/index.html">返回首页</a></p>
      <h1 class="site-title">{title}</h1>
      <div class="meta">
        {article_meta(article)}
      </div>
      <div class="article-body">
{content_html}
      </div>
      <p class="links"><a href="{original_href}" target="_blank" rel="noopener noreferrer">查看原文链接</a></p>
    </article>"""
    (ARTICLES_DIR / article["filename"]).write_text(page_shell(article.get("title") or "文章详情", body), encoding="utf-8")


def write_submit_page() -> None:
    html_text = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>提交微信公众号文章链接</title>
  <link rel="stylesheet" href="/assets/style.css">
</head>
<body>
  <main class="site">
    <section class="panel">
      <header class="site-header">
        <h1 class="site-title">提交微信公众号文章链接</h1>
        <p class="site-desc">请每行粘贴一个微信公众号文章链接。提交后系统会自动更新链接库，稍后重新生成归档网站。</p>
      </header>

      <form id="submit-form">
        <label for="password">管理密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>

        <label for="links">文章链接</label>
        <textarea id="links" name="links" placeholder="https://mp.weixin.qq.com/s/..." required></textarea>

        <div class="toolbar">
          <button id="submit-button" type="submit">提交</button>
          <a class="button secondary" href="/index.html">返回首页</a>
        </div>
        <div id="result" class="result" role="status" aria-live="polite"></div>
      </form>
    </section>
  </main>

  <script>
    const form = document.querySelector("#submit-form");
    const button = document.querySelector("#submit-button");
    const result = document.querySelector("#result");
    const prefix = "https://mp.weixin.qq.com/";

    function setResult(message, ok) {
      result.textContent = message;
      result.className = ok ? "result ok" : "result error";
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = document.querySelector("#password").value;
      const rawLinks = document.querySelector("#links").value
        .split(/\\r?\\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const links = [...new Set(rawLinks)];
      const invalid = links.filter((link) => !link.startsWith(prefix));

      if (!password) {
        setResult("请输入管理密码。", false);
        return;
      }
      if (links.length === 0) {
        setResult("请至少输入一个文章链接。", false);
        return;
      }
      if (invalid.length > 0) {
        setResult("存在非微信公众号文章链接，请检查后重试。", false);
        return;
      }

      button.disabled = true;
      setResult("正在提交...", true);

      try {
        const response = await fetch("/api/submit", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({password, links})
        });
        const text = await response.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          throw new Error(`提交接口没有返回 JSON，HTTP ${response.status}。请检查 Cloudflare Pages Functions 是否已部署。`);
        }
        if (!response.ok || !data.success) {
          throw new Error(data.message || `提交失败，HTTP ${response.status}。`);
        }
        setResult(`${data.message} 新增 ${data.added} 条，当前共 ${data.total} 条。`, true);
        document.querySelector("#links").value = "";
      } catch (error) {
        setResult(error.message || "提交失败，请稍后重试。", false);
      } finally {
        button.disabled = false;
      }
    });
  </script>
</body>
</html>
"""
    (PUBLIC / "submit.html").write_text(html_text, encoding="utf-8")


def write_articles_json(articles: list[dict[str, Any]]) -> None:
    ARTICLES_JSON.write_text(
        json.dumps({"articles": articles}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build() -> None:
    cached_articles = load_cached_articles()
    ensure_dirs()
    write_style()
    write_submit_page()

    urls = load_urls()
    articles = []
    for index, url in enumerate(urls):
        if index > 0:
            time.sleep(2)
        article = fetch_article(url)
        if not article.get("success") and url in cached_articles:
            article = cached_articles[url]
        article = localize_article_images(article)
        articles.append(article)
        write_article_page(article)

    write_index(articles)
    write_articles_json(articles)


if __name__ == "__main__":
    build()
