#!/usr/bin/env python3
"""Build a static archive site from submitted article URLs, with strong WeChat support."""

from __future__ import annotations

import hashlib
import html
import json
import os
import re
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urljoin, urlparse

import requests
from bs4 import BeautifulSoup, FeatureNotFound


ROOT = Path(__file__).resolve().parents[1]
DATA_LINKS = ROOT / "data" / "links.json"
URLS_TXT = ROOT / "urls.txt"
PUBLIC = ROOT / "public"
ARTICLES_DIR = PUBLIC / "articles"
ASSETS_DIR = PUBLIC / "assets"
IMAGES_DIR = ASSETS_DIR / "images"
PUBLIC_DATA_DIR = PUBLIC / "data"
PUBLIC_ARTICLES_JSON = PUBLIC_DATA_DIR / "articles.json"
ARTICLES_CACHE_JSON = ROOT / "data" / "articles-cache.json"

WECHAT_PREFIX = "https://mp.weixin.qq.com/"
REFETCH_ALL = os.environ.get("REFETCH_ALL", "").strip().lower() in {"1", "true", "yes"}
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


def is_wechat_url(url: str) -> bool:
    return url.strip().startswith(WECHAT_PREFIX)


def is_valid_article_url(url: str) -> bool:
    parsed = urlparse(url.strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def normalize_url(url: str) -> str:
    return url.strip()


def source_host(url: str) -> str:
    host = urlparse(url).netloc.lower()
    return host.removeprefix("www.")


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
        if not is_valid_article_url(normalized) or normalized in seen:
            continue
        seen.add(normalized)
        urls.append(normalized)
    return urls


def load_cached_articles() -> dict[str, dict[str, Any]]:
    data = read_json_file(ARTICLES_CACHE_JSON, None)
    if data is None:
        data = read_json_file(PUBLIC_ARTICLES_JSON, {"articles": []})
    articles = data.get("articles", []) if isinstance(data, dict) else []
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
        return datetime.fromtimestamp(int(ct), timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError, OSError):
        return ""


def parse_article_time(value: str) -> datetime:
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return datetime.min


def sort_articles_by_publish_time(articles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        articles,
        key=lambda article: parse_article_time(article.get("publish_time", "")),
        reverse=True,
    )


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


def positive_int(value: Any) -> int | None:
    text = str(value or "")
    match = re.search(r"\d+", text)
    if not match:
        return None
    number = int(match.group(0))
    return number if number > 0 else None


def positive_float(value: Any) -> float | None:
    try:
        number = float(str(value or "").strip())
    except ValueError:
        return None
    return number if number > 0 else None


def apply_image_attributes(image: Any) -> bool:
    changed = False

    if not image.has_attr("alt"):
        image["alt"] = ""
        changed = True

    if not image.get("loading"):
        image["loading"] = "lazy"
        changed = True

    width = positive_int(image.get("width"))
    if width is None:
        width = positive_int(image.get("data-w"))
        if width is not None:
            image["width"] = str(width)
            changed = True

    if positive_int(image.get("height")) is None and width is not None:
        ratio = positive_float(image.get("data-ratio"))
        if ratio is not None:
            height = max(1, round(width * ratio))
            image["height"] = str(height)
            changed = True

    return changed


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

    soup = parse_html(article["content_html"])
    root = (
        soup.select_one("#js_content")
        or soup.select_one("article")
        or soup.select_one("main")
        or soup.body
        or soup.find("div")
    )
    if not root:
        return article

    image_dir = IMAGES_DIR / article["id"]
    image_dir.mkdir(parents=True, exist_ok=True)

    changed = False
    for image in root.select("img"):
        if apply_image_attributes(image):
            changed = True
        source = image.get("src") or image.get("data-src") or image.get("data-original") or image.get("data-lazy-src")
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


def clean_node(node: Any, base_url: str) -> None:
    for element in node.select("script, style, noscript"):
        element.decompose()
    for element in node.select("mp-common-miniprogram, mp-sponsor-ad, mp-style-type"):
        element.decompose()
    for element in node.select("section:empty, p:empty"):
        element.decompose()
    for element in node.select("a.js_weapp_entry, a.weapp_image_link, a.weapp_text_link"):
        element.unwrap()
    for element in node.select("[hidden]"):
        element.attrs.pop("hidden", None)
    for image in node.select("img"):
        source = image.get("src") or image.get("data-src") or image.get("data-original") or image.get("data-lazy-src")
        if source:
            image["src"] = urljoin(base_url, source)
        apply_image_attributes(image)
    for link in node.select("a[href]"):
        link["href"] = urljoin(base_url, link.get("href", ""))
    remove_empty_blocks(node)


def remove_empty_blocks(node: Any) -> None:
    for element in list(node.select("section, p, div")):
        if element.select_one("img, video, iframe"):
            continue
        if not clean_text(element.get_text(" ", strip=True)):
            element.decompose()


PROMO_MARKERS = (
    "点击直达",
    "长按识别二维码",
    "百亿补贴",
    "同款好物",
    "拼多多搜",
    "二维码",
)

PROMO_SOFT_MARKERS = (
    "官网价",
    "大促价",
    "元起",
    "补贴",
    "券包",
    "会场",
)


def block_promo_score(text: str) -> int:
    score = sum(3 for marker in PROMO_MARKERS if marker in text)
    score += sum(1 for marker in PROMO_SOFT_MARKERS if marker in text)
    if "拼多多" in text:
        score += 2
    if "iPhone" in text or "MacBook" in text or "茅台" in text:
        score += 1
    return score


def prune_wechat_tail(node: Any) -> None:
    blocks = [child for child in node.children if getattr(child, "name", None)]
    if not blocks:
        return

    cumulative_text = 0
    promo_run = 0
    cutoff = None

    for index, block in enumerate(blocks):
        text = clean_text(block.get_text(" ", strip=True))
        text_len = len(text)
        score = block_promo_score(text)

        if score > 0:
            promo_run += score
        else:
            promo_run = 0

        if cumulative_text >= 1200 and (score >= 5 or promo_run >= 8):
            cutoff = index
            break

        cumulative_text += text_len

    if cutoff is None:
        return

    for block in blocks[cutoff:]:
        block.decompose()

def extract_wechat_content(soup: BeautifulSoup, page: str, url: str) -> dict[str, Any]:
    title_el = soup.select_one("#activity-name")
    account_el = soup.select_one("#js_name")
    content_el = soup.select_one("#js_content")

    title = clean_text(title_el.get_text(" ", strip=True)) if title_el else ""
    if not title:
        title = meta_content(soup, 'meta[property="og:title"]')
    account_name = clean_text(account_el.get_text(" ", strip=True)) if account_el else ""
    if not account_name:
        account_name = extract_script_string(page, "nickname")

    content_html = ""
    content_text = ""
    if content_el:
        clean_node(content_el, url)
        prune_wechat_tail(content_el)
        remove_empty_blocks(content_el)
        content_html = str(content_el)
        content_text = clean_text(content_el.get_text(" ", strip=True))

    return {
        "title": title or "未命名文章",
        "account_name": account_name,
        "publish_time": parse_publish_time(page),
        "content_text": content_text,
        "content_html": content_html,
        "success": bool(content_el),
        "error": "" if content_el else "未找到微信公众号正文内容 #js_content",
        "source_name": "微信公众号",
        "source_host": source_host(url),
    }


def first_meta_content(soup: BeautifulSoup, selectors: list[str]) -> str:
    for selector in selectors:
        value = meta_content(soup, selector)
        if value:
            return value
    return ""


def extract_generic_content(soup: BeautifulSoup, url: str) -> dict[str, Any]:
    title = first_meta_content(soup, [
        'meta[property="og:title"]',
        'meta[name="twitter:title"]',
    ])
    if not title and soup.title and soup.title.string:
        title = clean_text(soup.title.string)

    author = first_meta_content(soup, [
        'meta[name="author"]',
        'meta[property="article:author"]',
    ])
    publish_time = first_meta_content(soup, [
        'meta[property="article:published_time"]',
        'meta[name="publish_date"]',
        'meta[name="pubdate"]',
        'meta[itemprop="datePublished"]',
        'time[datetime]',
    ])

    candidates = [
        "article",
        "main article",
        "[itemprop='articleBody']",
        ".post-content",
        ".entry-content",
        ".article-content",
        ".article-body",
        ".rich-text",
        "main",
        ".content",
        "#content",
        "body",
    ]
    content_el = None
    for selector in candidates:
        candidate = soup.select_one(selector)
        if candidate and len(clean_text(candidate.get_text(" ", strip=True))) >= 80:
            content_el = candidate
            break

    content_html = ""
    content_text = ""
    if content_el:
        clean_node(content_el, url)
        content_html = str(content_el)
        content_text = clean_text(content_el.get_text(" ", strip=True))

    return {
        "title": title or "未命名文章",
        "account_name": author,
        "publish_time": publish_time,
        "content_text": content_text,
        "content_html": content_html,
        "success": bool(content_el),
        "error": "" if content_el else "未找到可归档的正文内容",
        "source_name": source_host(url),
        "source_host": source_host(url),
    }

def parse_html(page: str) -> BeautifulSoup:
    try:
        return BeautifulSoup(page, "lxml")
    except FeatureNotFound:
        return BeautifulSoup(page, "html.parser")


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
        "source_name": "",
        "source_host": source_host(url),
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

    soup = parse_html(response.text)
    article = extract_wechat_content(soup, response.text, url) if is_wechat_url(url) else extract_generic_content(soup, url)
    base.update(article)
    return base




def ensure_dirs() -> None:
    ARTICLES_DIR.mkdir(parents=True, exist_ok=True)
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DATA_DIR.mkdir(parents=True, exist_ok=True)
    remove_public_articles_json()
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

.toolbar-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.panel-header {
  margin-bottom: 18px;
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
  padding: 24px 0;
  border-bottom: 1px solid var(--line);
}

.article-item:first-child {
  padding-top: 0;
}

.article-item:last-child {
  border-bottom: 0;
  padding-bottom: 0;
}

.article-title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.article-item h2 {
  margin: 0;
  font-size: 22px;
  line-height: 1.35;
}

.source-badge {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: #ecfdf5;
  color: var(--accent-dark);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin: 8px 0;
  font-size: 14px;
}

.article-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0;
  font-size: 13px;
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  background: #f8fafc;
  color: var(--text);
}

.meta-key {
  color: var(--muted);
}

.meta-value {
  color: var(--text);
}

.error-note {
  margin: 10px 0 0;
  color: var(--danger);
  font-size: 14px;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 14px;
}

.links a {
  font-weight: 500;
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

.source-card {
  margin: 16px 0 20px;
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fafc;
}

.source-card strong {
  display: block;
  margin-bottom: 6px;
}

.source-card span,
.source-card a {
  display: block;
  margin-top: 4px;
  overflow-wrap: anywhere;
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

.visitor-ip-panel {
  margin-bottom: 24px;
}

.visitor-ip-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-title {
  margin: 0 0 6px;
  font-size: 22px;
  line-height: 1.35;
}

.visitor-ip-result {
  margin-top: 14px;
}

.visitor-ip-block + .visitor-ip-block {
  margin-top: 22px;
}

.visitor-ip-block-header {
  margin-bottom: 12px;
}

.visitor-ip-block-header .help,
.visitor-ip-inline-note {
  margin: 6px 0 0;
}

.visitor-ip-summary-grid {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.visitor-ip-summary-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fafc;
  padding: 14px 16px;
}

.visitor-ip-summary-label {
  display: block;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}

.visitor-ip-summary-value {
  display: block;
  margin-top: 6px;
  font-size: 18px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.ip-check-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.ip-check-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fafc;
  padding: 16px;
}

.ip-check-card h3 {
  margin: 0 0 10px;
  font-size: 16px;
  line-height: 1.35;
}

.ip-check-value {
  margin: 0 0 8px;
  font-size: 24px;
  line-height: 1.2;
  font-weight: 700;
  color: var(--accent-dark);
}

.visitor-ip-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.visitor-ip-tag {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  background: #f8fafc;
  color: var(--text);
  font-size: 14px;
  line-height: 1.3;
}

.visitor-ip-tag.empty {
  color: var(--muted);
}

.visitor-ip-provider-grid,
.visitor-ip-explainer-grid {
  display: grid;
  gap: 14px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

.visitor-ip-iplark-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}

.visitor-ip-iplark-frame {
  display: block;
  width: 100%;
  min-height: 720px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
}

.visitor-ip-provider-card,
.visitor-ip-explainer-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #f8fafc;
  padding: 16px;
}

.visitor-ip-provider-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.visitor-ip-provider-head h3,
.visitor-ip-explainer-card h3 {
  margin: 0;
  font-size: 16px;
  line-height: 1.35;
}

.visitor-ip-provider-state {
  display: inline-flex;
  align-items: center;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  background: #fff;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
}

.visitor-ip-provider-state.ok {
  border-color: #99f6e4;
  background: #ecfdf5;
  color: var(--accent-dark);
}

.visitor-ip-provider-state.not_configured {
  border-color: #fde68a;
  background: #fffbeb;
  color: #92400e;
}

.visitor-ip-provider-state.error {
  border-color: #fecaca;
  background: #fef2f2;
  color: var(--danger);
}

.visitor-ip-provider-summary {
  margin: 10px 0 0;
}

.visitor-ip-detail-list {
  margin: 14px 0 0;
}

.visitor-ip-detail-row {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid #e5e7eb;
}

.visitor-ip-detail-row:first-of-type {
  padding-top: 0;
  border-top: 0;
}

.visitor-ip-detail-row dt {
  color: var(--muted);
}

.visitor-ip-detail-row dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.visitor-ip-detail-empty {
  margin-top: 14px;
  color: var(--muted);
  font-size: 14px;
}

.visitor-ip-explainer-card .help {
  margin: 8px 0 0;
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

  .visitor-ip-provider-head {
    align-items: flex-start;
  }

  .visitor-ip-detail-row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
"""
    (ASSETS_DIR / "style.css").write_text(css, encoding="utf-8")




def format_stat_label(value: int, unit: str) -> str:
    return f"{value} {unit}"


def build_summary_stats(articles: list[dict[str, Any]]) -> str:
    total = len(articles)
    success = sum(1 for article in articles if article.get("success"))
    wechat = sum(1 for article in articles if (article.get("source_host") or source_host(article.get("url", ""))) == "mp.weixin.qq.com")
    return "\n        ".join([
        f'<div class="summary-stat"><strong>{format_stat_label(total, "条")}</strong><span>已收录链接</span></div>',
        f'<div class="summary-stat"><strong>{format_stat_label(success, "篇")}</strong><span>成功归档</span></div>',
        f'<div class="summary-stat"><strong>{format_stat_label(wechat, "篇")}</strong><span>微信公众号</span></div>',
    ])



def write_article_page(article: dict[str, Any]) -> None:
    title = html.escape(article.get("title") or "未命名文章")
    original_href = html.escape(article["url"], quote=True)
    content_html = article.get("content_html") or ""
    source_card = detail_source_card(article)
    source_card_html = f"      <div class=\"source-card\">\n        {source_card}\n      </div>" if source_card else ""
    source_title = article.get("account_name") or article.get("source_host") or "公开文章归档"
    page_title = f"{article.get('title') or '文章详情'} - {source_title} - 公开文章归档"
    if not article.get("success"):
        error = html.escape(article.get("error") or "抓取失败")
        content_html = f'<p class="result error">{error}</p>'

    body = f"""    <article class="article">
      <p><a href="/">返回首页</a></p>
      <h1 class="site-title">{title}</h1>
      <div class="meta">
        {article_meta(article)}
      </div>
{source_card_html}
      <div class="article-body">
{content_html}
      </div>
      <p class="links"><a href="{original_href}" target="_blank" rel="noopener noreferrer">查看原文链接</a></p>
    </article>"""
    (ARTICLES_DIR / article["filename"]).write_text(
        page_shell(
            page_title,
            body,
            description=f"{article.get('title') or '文章详情'} 的归档页，保留原文来源与抓取信息。",
        ),
        encoding="utf-8",
    )



def write_submit_page() -> None:
    body = """    <section class="panel">
      <header class="site-header">
        <h1 class="site-title">管理员提交文章链接</h1>
        <p class="site-desc">用于维护公开文章归档链接库。请输入管理密码后批量提交公开文章链接，系统稍后会自动重新生成归档页面。</p>
      </header>

      <form id="submit-form">
        <label for="password">管理密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>

        <label for="links">文章链接</label>
        <textarea id="links" name="links" placeholder="https://example.com/article" required></textarea>

        <div class="toolbar">
          <button id="submit-button" type="submit">提交链接</button>
          <a class="button secondary" href="/">返回首页</a>
        </div>
        <div id="result" class="result" role="status" aria-live="polite"></div>
      </form>
    </section>"""

    script = """    <script>
      const form = document.querySelector(\"#submit-form\");
      const button = document.querySelector(\"#submit-button\");
      const result = document.querySelector(\"#result\");

      function isValidLink(value) {
        try {
          const url = new URL(value);
          return url.protocol === \"http:\" || url.protocol === \"https:\";
        } catch {
          return false;
        }
      }

      function setResult(message, ok) {
        result.textContent = message;
        result.className = ok ? \"result ok\" : \"result error\";
      }

      form.addEventListener(\"submit\", async (event) => {
        event.preventDefault();
        const password = document.querySelector(\"#password\").value;
        const rawLinks = document.querySelector(\"#links\").value
          .split(/\\r?\\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const links = [...new Set(rawLinks)];
        const invalid = links.filter((link) => !isValidLink(link));

        if (!password) {
          setResult(\"请输入管理密码。\", false);
          return;
        }
        if (links.length === 0) {
          setResult(\"请至少输入一个文章链接。\", false);
          return;
        }
        if (invalid.length > 0) {
          setResult(\"存在无效链接，请检查后重试。\", false);
          return;
        }

        button.disabled = true;
        setResult(\"正在提交...\", true);

        try {
          const response = await fetch(\"/api/submit\", {
            method: \"POST\",
            headers: {\"Content-Type\": \"application/json\"},
            body: JSON.stringify({password, links})
          });
          const text = await response.text();
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            throw new Error(`提交接口没有返回 JSON，HTTP ${response.status}。请检查站点后端接口是否已正确部署。`);
          }
          if (!response.ok || !data.success) {
            throw new Error(data.message || `提交失败，HTTP ${response.status}。`);
          }
          setResult(`${data.message} 新增 ${data.added} 条，当前共 ${data.total} 条。`, true);
          document.querySelector(\"#links\").value = \"\";
        } catch (error) {
          setResult(error.message || \"提交失败，请稍后重试。\", false);
        } finally {
          button.disabled = false;
        }
      });
    </script>"""

    html_text = page_shell(
        "管理员提交文章链接",
        body,
        script,
        description="用于维护公开文章归档链接库，支持批量提交公开网页与微信公众号文章链接。",
    )
    (PUBLIC / "submit.html").write_text(html_text, encoding="utf-8")


def remove_public_articles_json() -> None:
    if PUBLIC_ARTICLES_JSON.exists():
        PUBLIC_ARTICLES_JSON.unlink()


def write_articles_cache(articles: list[dict[str, Any]]) -> None:
    ARTICLES_CACHE_JSON.parent.mkdir(parents=True, exist_ok=True)
    ARTICLES_CACHE_JSON.write_text(
        json.dumps({"articles": articles}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def page_shell(title: str, body: str, extra_scripts: str = "", description: str = "") -> str:
    meta_description = (
        f'\n  <meta name="description" content="{html.escape(description, quote=True)}">'
        if description
        else ""
    )
    return f"""<!doctype html>
<html lang=\"zh-CN\">
<head>
  <meta charset=\"utf-8\">
  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">{meta_description}
  <title>{html.escape(title)}</title>
  <link rel=\"stylesheet\" href=\"/assets/style.css\">
</head>
<body>
  <main class=\"site\">
{body}
  </main>
{extra_scripts}
</body>
</html>
"""


def article_detail_path(article: dict[str, Any]) -> str:
    filename = article.get("filename") or ""
    article_slug = Path(filename).stem if filename else article.get("id") or ""
    return f"/articles/{html.escape(article_slug)}"



def article_meta(article: dict[str, Any]) -> str:
    items = []
    if article.get("account_name"):
        items.append(
            f'<span class="meta-item"><span class="meta-key">公众号</span><span class="meta-value">{html.escape(article["account_name"])}</span></span>'
        )
    if article.get("publish_time"):
        items.append(
            f'<span class="meta-item"><span class="meta-key">发布时间</span><span class="meta-value">{html.escape(article["publish_time"])}</span></span>'
        )
    if article.get("fetched_at"):
        items.append(
            f'<span class="meta-item"><span class="meta-key">抓取时间</span><span class="meta-value">{html.escape(article["fetched_at"])}</span></span>'
        )
    return "\n        ".join(items)



def list_source_label(article: dict[str, Any]) -> str:
    source_name = clean_text(article.get("source_name") or article.get("source_host") or "来源站点")
    return html.escape(source_name)



def detail_source_card(article: dict[str, Any]) -> str:
    rows = ["<strong>原文来源</strong>"]
    if article.get("account_name"):
        rows.append(f'<span>公众号：{html.escape(article["account_name"])}</span>')
    if article.get("source_host"):
        rows.append(f'<span>站点：{html.escape(article["source_host"])}</span>')
    rows.append(
        f'<a href="{html.escape(article["url"], quote=True)}" target="_blank" rel="noopener noreferrer">查看原文</a>'
    )
    return "\n        ".join(rows)



def visitor_ip_card() -> str:
    return """    <section class="panel visitor-ip-panel">
      <header class="panel-header">
        <h1 class="site-title">访问 IP 检测</h1>
        <p class="site-desc">手动检测当前访问者公网 IP，并汇总 AbuseIPDB、IP2Location、ipdata 返回的风险与线路信息。</p>
      </header>
      <div class="visitor-ip-header">
        <div>
          <h2 class="section-title">开始检测</h2>
          <p class="help">仅在点击后才会调用第三方检测服务并加载 iplark.com 复核页面，页面不会自动检测。</p>
        </div>
        <button id="visitor-ip-refresh" type="button" class="button">开始检测</button>
      </div>
      <div id="visitor-ip-status" class="result" role="status" aria-live="polite">点击上方按钮后开始检测。</div>
      <section id="visitor-ip-iplark-panel" class="visitor-ip-block visitor-ip-iplark-panel" hidden>
        <div class="visitor-ip-block-header">
          <h2 class="section-title">iplark.com 复核</h2>
          <p class="help">点击“开始检测”后会加载 iplark.com 页面供你复核；如果对方站点不允许嵌入，请使用新窗口打开。</p>
        </div>
        <div class="visitor-ip-iplark-actions">
          <a class="button secondary" href="https://iplark.com/" target="_blank" rel="noopener noreferrer">新窗口打开 iplark.com</a>
        </div>
        <iframe id="visitor-ip-iplark-frame" class="visitor-ip-iplark-frame" title="iplark.com IP 检测" loading="lazy" referrerpolicy="no-referrer" data-src="https://iplark.com/"></iframe>
      </section>
      <div id="visitor-ip-result" class="visitor-ip-result" hidden>
        <section class="visitor-ip-block">
          <h2 class="section-title">检测摘要</h2>
          <div class="visitor-ip-summary-grid">
            <article class="visitor-ip-summary-card">
              <span class="visitor-ip-summary-label">当前 IP</span>
              <strong id="visitor-ip-value" class="visitor-ip-summary-value">-</strong>
            </article>
            <article class="visitor-ip-summary-card">
              <span class="visitor-ip-summary-label">位置</span>
              <strong id="visitor-ip-location" class="visitor-ip-summary-value">-</strong>
            </article>
            <article class="visitor-ip-summary-card">
              <span class="visitor-ip-summary-label">运营商</span>
              <strong id="visitor-ip-isp" class="visitor-ip-summary-value">-</strong>
            </article>
            <article class="visitor-ip-summary-card">
              <span class="visitor-ip-summary-label">ASN</span>
              <strong id="visitor-ip-asn" class="visitor-ip-summary-value">-</strong>
            </article>
            <article class="visitor-ip-summary-card">
              <span class="visitor-ip-summary-label">网络类型</span>
              <strong id="visitor-ip-network-type" class="visitor-ip-summary-value">-</strong>
            </article>
            <article class="visitor-ip-summary-card">
              <span class="visitor-ip-summary-label">连接协议</span>
              <strong id="visitor-ip-protocol" class="visitor-ip-summary-value">-</strong>
            </article>
            <article class="visitor-ip-summary-card">
              <span class="visitor-ip-summary-label">检测时间</span>
              <strong id="visitor-ip-checked-at" class="visitor-ip-summary-value">-</strong>
            </article>
          </div>
          <p id="visitor-ip-provider-summary" class="help visitor-ip-inline-note">-</p>
          <p id="visitor-ip-notice" class="help visitor-ip-inline-note">-</p>
        </section>

        <section class="visitor-ip-block">
          <h2 class="section-title">核心结论</h2>
          <div class="ip-check-grid">
            <article class="ip-check-card">
              <h3>是否滥用</h3>
              <p id="visitor-ip-abuse-label" class="ip-check-value">-</p>
              <p id="visitor-ip-abuse-summary" class="help">-</p>
            </article>
            <article class="ip-check-card">
              <h3>是否家宽</h3>
              <p id="visitor-ip-residential-label" class="ip-check-value">-</p>
              <p id="visitor-ip-residential-summary" class="help">-</p>
            </article>
            <article class="ip-check-card">
              <h3>IP 风险</h3>
              <p id="visitor-ip-risk-label" class="ip-check-value">-</p>
              <p id="visitor-ip-risk-summary" class="help">-</p>
            </article>
          </div>
        </section>

        <section class="visitor-ip-block">
          <div class="visitor-ip-block-header">
            <h2 class="section-title">风险标签</h2>
            <p class="help">把风险等级拆成更具体的命中项，方便判断是否是 VPN、代理或机房线路。</p>
          </div>
          <div id="visitor-ip-risk-tags" class="visitor-ip-tag-list"></div>
        </section>

        <section class="visitor-ip-block">
          <div class="visitor-ip-block-header">
            <h2 class="section-title">浏览器环境</h2>
            <p class="help">参考 IP 检测站常见信息维度，本区只读取浏览器本地可见信息，不会额外发送到第三方服务。</p>
          </div>
          <div class="visitor-ip-provider-grid">
            <article class="visitor-ip-provider-card">
              <div class="visitor-ip-provider-head">
                <h3>浏览器与系统</h3>
              </div>
              <dl id="visitor-ip-browser-details" class="visitor-ip-detail-list"></dl>
            </article>
            <article class="visitor-ip-provider-card">
              <div class="visitor-ip-provider-head">
                <h3>语言与时间</h3>
              </div>
              <dl id="visitor-ip-locale-details" class="visitor-ip-detail-list"></dl>
            </article>
            <article class="visitor-ip-provider-card">
              <div class="visitor-ip-provider-head">
                <h3>屏幕与设备</h3>
              </div>
              <dl id="visitor-ip-device-details" class="visitor-ip-detail-list"></dl>
            </article>
            <article class="visitor-ip-provider-card">
              <div class="visitor-ip-provider-head">
                <h3>隐私与网络能力</h3>
              </div>
              <dl id="visitor-ip-capability-details" class="visitor-ip-detail-list"></dl>
            </article>
          </div>
        </section>

        <section class="visitor-ip-block">
          <div class="visitor-ip-block-header">
            <h2 class="section-title">WebRTC 暴露检测</h2>
            <p class="help">检测浏览器本地 ICE 候选地址；默认不配置 STUN 服务器，因此不会为了检测 WebRTC 而连接额外第三方服务。</p>
          </div>
          <div class="visitor-ip-provider-grid">
            <article class="visitor-ip-provider-card">
              <div class="visitor-ip-provider-head">
                <h3>检测结果</h3>
                <span id="visitor-ip-webrtc-status" class="visitor-ip-provider-state">等待检测</span>
              </div>
              <p id="visitor-ip-webrtc-summary" class="help visitor-ip-provider-summary">点击开始检测后会读取本地 WebRTC 候选信息。</p>
              <dl id="visitor-ip-webrtc-details" class="visitor-ip-detail-list"></dl>
            </article>
            <article class="visitor-ip-provider-card">
              <div class="visitor-ip-provider-head">
                <h3>ICE 候选</h3>
              </div>
              <p class="help visitor-ip-provider-summary">现代浏览器通常会用 mDNS 隐藏真实本地地址。</p>
              <dl id="visitor-ip-webrtc-candidates" class="visitor-ip-detail-list"></dl>
            </article>
          </div>
        </section>

        <section class="visitor-ip-block">
          <div class="visitor-ip-block-header">
            <h2 class="section-title">检测明细</h2>
            <p class="help">保留每个来源的状态、摘要和关键字段，便于核对结论来自哪里。</p>
          </div>
          <div class="visitor-ip-provider-grid">
            <article class="visitor-ip-provider-card">
              <div class="visitor-ip-provider-head">
                <h3>AbuseIPDB</h3>
                <span id="visitor-ip-abuse-status" class="visitor-ip-provider-state">-</span>
              </div>
              <p id="visitor-ip-abuse-provider-summary" class="help visitor-ip-provider-summary">-</p>
              <dl id="visitor-ip-abuse-details" class="visitor-ip-detail-list"></dl>
            </article>
            <article class="visitor-ip-provider-card">
              <div class="visitor-ip-provider-head">
                <h3>IP2Location</h3>
                <span id="visitor-ip-residential-status" class="visitor-ip-provider-state">-</span>
              </div>
              <p id="visitor-ip-residential-provider-summary" class="help visitor-ip-provider-summary">-</p>
              <dl id="visitor-ip-residential-details" class="visitor-ip-detail-list"></dl>
            </article>
            <article class="visitor-ip-provider-card">
              <div class="visitor-ip-provider-head">
                <h3>ipdata</h3>
                <span id="visitor-ip-risk-status" class="visitor-ip-provider-state">-</span>
              </div>
              <p id="visitor-ip-risk-provider-summary" class="help visitor-ip-provider-summary">-</p>
              <dl id="visitor-ip-risk-details" class="visitor-ip-detail-list"></dl>
            </article>
          </div>
        </section>

        <section class="visitor-ip-block visitor-ip-explainer">
          <h2 class="section-title">说明</h2>
          <div class="visitor-ip-explainer-grid">
            <article class="visitor-ip-explainer-card">
              <h3>是否家宽是什么意思？</h3>
              <p class="help">“是”表示更像普通家庭宽带或移动运营商网络；“否”通常更接近数据中心、云服务或企业专线。</p>
            </article>
            <article class="visitor-ip-explainer-card">
              <h3>风险高 / 中 / 低怎么理解？</h3>
              <p class="help">高风险通常意味着命中 Tor、代理、匿名网络或已知滥用标记；中风险多为数据中心、iCloud Relay 等软标记；低风险表示未发现明显风险标签。</p>
            </article>
            <article class="visitor-ip-explainer-card">
              <h3>“有记录”是不是等于恶意？</h3>
              <p class="help">不是。它只表示该 IP 曾在公开滥用情报库中出现过记录，仍需结合举报次数、线路类型和当前访问场景综合判断。</p>
            </article>
            <article class="visitor-ip-explainer-card">
              <h3>WebRTC 检测准确吗？</h3>
              <p class="help">它只能检测当前浏览器暴露的 ICE 候选。现代浏览器常用 mDNS 隐藏本地 IP，因此“未暴露”不代表没有 WebRTC，也不等同完整 DNS 泄漏检测。</p>
            </article>
            <article class="visitor-ip-explainer-card">
              <h3>浏览器环境检测会上传吗？</h3>
              <p class="help">不会。User-Agent、语言、时区、屏幕、Cookie、DNT 等信息只在当前页面本地渲染，用来辅助判断访问环境。</p>
            </article>
            <article class="visitor-ip-explainer-card">
              <h3>隐私说明</h3>
              <p class="help">只有点击“开始检测”后，当前访问者公网 IP 才会发送到第三方服务查询；页面默认不会自动上报。</p>
            </article>
          </div>
        </section>
      </div>
    </section>"""



def visitor_ip_script() -> str:
    return """    <script>
      const visitorIpStatus = document.querySelector("#visitor-ip-status");
      const visitorIpResult = document.querySelector("#visitor-ip-result");
      const visitorIpRefresh = document.querySelector("#visitor-ip-refresh");
      const visitorIpElements = {
        ip: document.querySelector("#visitor-ip-value"),
        location: document.querySelector("#visitor-ip-location"),
        isp: document.querySelector("#visitor-ip-isp"),
        asn: document.querySelector("#visitor-ip-asn"),
        networkType: document.querySelector("#visitor-ip-network-type"),
        protocol: document.querySelector("#visitor-ip-protocol"),
        checkedAt: document.querySelector("#visitor-ip-checked-at"),
        providerSummary: document.querySelector("#visitor-ip-provider-summary"),
        notice: document.querySelector("#visitor-ip-notice"),
        riskTags: document.querySelector("#visitor-ip-risk-tags"),
        abuseLabel: document.querySelector("#visitor-ip-abuse-label"),
        abuseSummary: document.querySelector("#visitor-ip-abuse-summary"),
        residentialLabel: document.querySelector("#visitor-ip-residential-label"),
        residentialSummary: document.querySelector("#visitor-ip-residential-summary"),
        riskLabel: document.querySelector("#visitor-ip-risk-label"),
        riskSummary: document.querySelector("#visitor-ip-risk-summary"),
        abuseStatus: document.querySelector("#visitor-ip-abuse-status"),
        abuseProviderSummary: document.querySelector("#visitor-ip-abuse-provider-summary"),
        abuseDetails: document.querySelector("#visitor-ip-abuse-details"),
        residentialStatus: document.querySelector("#visitor-ip-residential-status"),
        residentialProviderSummary: document.querySelector("#visitor-ip-residential-provider-summary"),
        residentialDetails: document.querySelector("#visitor-ip-residential-details"),
        riskStatus: document.querySelector("#visitor-ip-risk-status"),
        riskProviderSummary: document.querySelector("#visitor-ip-risk-provider-summary"),
        riskDetails: document.querySelector("#visitor-ip-risk-details"),
        iplarkPanel: document.querySelector("#visitor-ip-iplark-panel"),
        iplarkFrame: document.querySelector("#visitor-ip-iplark-frame"),
        browserDetails: document.querySelector("#visitor-ip-browser-details"),
        localeDetails: document.querySelector("#visitor-ip-locale-details"),
        deviceDetails: document.querySelector("#visitor-ip-device-details"),
        capabilityDetails: document.querySelector("#visitor-ip-capability-details"),
        webrtcStatus: document.querySelector("#visitor-ip-webrtc-status"),
        webrtcSummary: document.querySelector("#visitor-ip-webrtc-summary"),
        webrtcDetails: document.querySelector("#visitor-ip-webrtc-details"),
        webrtcCandidates: document.querySelector("#visitor-ip-webrtc-candidates"),
      };

      const riskFlagLabels = {
        isTor: "Tor",
        isProxy: "代理",
        isAnonymous: "匿名网络",
        isKnownAttacker: "已知攻击者",
        isKnownAbuser: "已知滥用者",
        isDatacenter: "数据中心",
        isIcloudRelay: "iCloud Relay",
        isBogon: "bogon",
      };

      function setVisitorIpStatus(message, ok) {
        visitorIpStatus.textContent = message;
        visitorIpStatus.className = ok ? "result ok" : "result error";
      }

      function textOrFallback(value, fallback = "未知") {
        const text = String(value || "").trim();
        return text || fallback;
      }

      function formatCheckedAt(value) {
        if (!value) {
          return "未知";
        }
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
      }

      function formatLocation(network) {
        if (!network) {
          return "未知";
        }
        const parts = [network.country, network.city, network.colo].filter((part) => part && part !== "未知");
        return parts.length > 0 ? parts.join(" / ") : "未知";
      }

      function formatIpProtocol(ip) {
        const value = String(ip || "").trim();
        if (!value) {
          return "未知";
        }
        if (value.includes(":")) {
          return "IPv6";
        }
        if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
          return "IPv4";
        }
        return "未知";
      }

      function providerStateLabel(payload) {
        if (!payload || !payload.status) {
          return "未知";
        }
        if (payload.status === "ok") {
          return "已完成";
        }
        if (payload.status === "not_configured") {
          return "未配置";
        }
        if (payload.status === "error") {
          return "查询失败";
        }
        return payload.status;
      }

      function providerStateClass(payload) {
        if (!payload || !payload.status) {
          return "visitor-ip-provider-state";
        }
        return `visitor-ip-provider-state ${payload.status}`;
      }

      function fillProvider(labelElement, summaryElement, payload) {
        if (!payload) {
          labelElement.textContent = "未知";
          summaryElement.textContent = "暂无结果。";
          return;
        }
        labelElement.textContent = payload.label || "未知";
        summaryElement.textContent = payload.summary || "暂无结果。";
      }

      function setProviderMeta(statusElement, summaryElement, payload) {
        statusElement.textContent = providerStateLabel(payload);
        statusElement.className = providerStateClass(payload);
        summaryElement.textContent = payload && payload.summary ? payload.summary : "暂无结果。";
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      function renderDetailList(listElement, rows) {
        const items = rows.filter((row) => row && row.value !== undefined && row.value !== null && String(row.value).trim() !== "");
        if (items.length === 0) {
          listElement.innerHTML = '<div class="visitor-ip-detail-empty">暂无更多字段。</div>';
          return;
        }
        listElement.innerHTML = items.map((row) => `
          <div class="visitor-ip-detail-row">
            <dt>${escapeHtml(row.label)}</dt>
            <dd>${escapeHtml(row.value)}</dd>
          </div>
        `).join("");
      }

      function boolText(value) {
        if (value === true) {
          return "是";
        }
        if (value === false) {
          return "否";
        }
        return "未知";
      }

      function buildRiskTags(riskPayload) {
        if (!riskPayload || riskPayload.status !== "ok") {
          return [];
        }
        if (Array.isArray(riskPayload.flags) && riskPayload.flags.length > 0) {
          return riskPayload.flags;
        }
        const threat = riskPayload.threat && typeof riskPayload.threat === "object" ? riskPayload.threat : {};
        return Object.entries(riskFlagLabels)
          .filter(([key]) => threat[key] === true)
          .map(([, label]) => label);
      }

      function renderRiskTags(tags) {
        if (!Array.isArray(tags) || tags.length === 0) {
          visitorIpElements.riskTags.innerHTML = '<span class="visitor-ip-tag empty">未发现明显风险标记</span>';
          return;
        }
        visitorIpElements.riskTags.innerHTML = tags.map((tag) => `<span class="visitor-ip-tag">${tag}</span>`).join("");
      }

      function pickPrimaryNetworkType(checks) {
        const residential = checks && checks.residential ? checks.residential : null;
        if (!residential) {
          return "未知";
        }
        const candidates = [residential.usageType, residential.category, residential.connectionType].filter(Boolean);
        return candidates.length > 0 ? candidates.join(" / ") : (residential.label || "未知");
      }

      function pickPrimaryIsp(checks) {
        const candidates = [
          checks && checks.residential && checks.residential.isp,
          checks && checks.abuse && checks.abuse.isp,
        ].filter(Boolean);
        return candidates[0] || "未知";
      }

      function pickPrimaryAsn(checks) {
        return textOrFallback(checks && checks.residential && checks.residential.asn, "未知");
      }

      function parseBrowserInfo(userAgent) {
        const ua = String(userAgent || "");
        const browserRules = [
          [/Edg\/(\d+)/, "Microsoft Edge"],
          [/OPR\/(\d+)/, "Opera"],
          [/Chrome\/(\d+)/, "Chrome"],
          [/Firefox\/(\d+)/, "Firefox"],
          [/Version\/(\d+).+Safari\//, "Safari"],
        ];
        const osRules = [
          [/Windows NT 10/, "Windows 10/11"],
          [/Windows NT/, "Windows"],
          [/Mac OS X/, "macOS"],
          [/iPhone|iPad|iPod/, "iOS / iPadOS"],
          [/Android/, "Android"],
          [/Linux/, "Linux"],
        ];
        const browser = browserRules.find(([pattern]) => pattern.test(ua));
        const os = osRules.find(([pattern]) => pattern.test(ua));
        return {
          browser: browser ? browser[1] : "未知",
          os: os ? os[1] : "未知",
        };
      }

      function formatLanguages(languages) {
        if (!Array.isArray(languages) || languages.length === 0) {
          return navigator.language || "未知";
        }
        return languages.join(" / ");
      }

      function formatTimezoneOffset() {
        const offset = new Date().getTimezoneOffset();
        const sign = offset <= 0 ? "+" : "-";
        const absolute = Math.abs(offset);
        const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
        const minutes = String(absolute % 60).padStart(2, "0");
        return `UTC${sign}${hours}:${minutes}`;
      }

      function formatScreenSize() {
        if (!window.screen) {
          return "未知";
        }
        return `${screen.width} × ${screen.height}`;
      }

      function formatViewportSize() {
        return `${window.innerWidth} × ${window.innerHeight}`;
      }

      function formatColorDepth() {
        return window.screen && screen.colorDepth ? `${screen.colorDepth} bit` : "未知";
      }

      function formatDeviceMemory() {
        return navigator.deviceMemory ? `${navigator.deviceMemory} GB` : "未知";
      }

      function formatConnection() {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!connection) {
          return "未知";
        }
        const parts = [connection.effectiveType, connection.type, connection.downlink ? `${connection.downlink} Mbps` : ""].filter(Boolean);
        return parts.length > 0 ? parts.join(" / ") : "未知";
      }

      function formatDoNotTrack() {
        const value = navigator.doNotTrack || window.doNotTrack || navigator.msDoNotTrack;
        if (value === "1" || value === "yes") {
          return "已开启";
        }
        if (value === "0" || value === "no") {
          return "未开启";
        }
        return "未知";
      }

      function renderBrowserEnvironment() {
        const browserInfo = parseBrowserInfo(navigator.userAgent);
        renderDetailList(visitorIpElements.browserDetails, [
          { label: "浏览器", value: browserInfo.browser },
          { label: "操作系统", value: browserInfo.os },
          { label: "平台", value: navigator.platform || "未知" },
          { label: "User-Agent", value: navigator.userAgent || "未知" },
        ]);
        renderDetailList(visitorIpElements.localeDetails, [
          { label: "首选语言", value: navigator.language || "未知" },
          { label: "语言列表", value: formatLanguages(navigator.languages) },
          { label: "时区", value: Intl.DateTimeFormat().resolvedOptions().timeZone || "未知" },
          { label: "UTC 偏移", value: formatTimezoneOffset() },
          { label: "本地时间", value: new Date().toLocaleString("zh-CN", { hour12: false }) },
        ]);
        renderDetailList(visitorIpElements.deviceDetails, [
          { label: "屏幕", value: formatScreenSize() },
          { label: "视口", value: formatViewportSize() },
          { label: "像素比", value: window.devicePixelRatio ? String(window.devicePixelRatio) : "未知" },
          { label: "颜色深度", value: formatColorDepth() },
          { label: "CPU 线程", value: navigator.hardwareConcurrency ? String(navigator.hardwareConcurrency) : "未知" },
          { label: "设备内存", value: formatDeviceMemory() },
        ]);
        renderDetailList(visitorIpElements.capabilityDetails, [
          { label: "Cookie", value: navigator.cookieEnabled ? "已启用" : "未启用" },
          { label: "Do Not Track", value: formatDoNotTrack() },
          { label: "线上状态", value: navigator.onLine ? "在线" : "离线" },
          { label: "连接", value: formatConnection() },
          { label: "HTTPS", value: location.protocol === "https:" ? "是" : "否" },
          { label: "WebRTC", value: "RTCPeerConnection" in window ? "可用" : "不可用" },
          { label: "本地存储", value: "localStorage" in window ? "可用" : "不可用" },
        ]);
      }
      async function renderWebRtcExposure() {
        const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
        if (!PeerConnection) {
          visitorIpElements.webrtcStatus.textContent = "不可用";
          visitorIpElements.webrtcStatus.className = "visitor-ip-provider-state not_configured";
          visitorIpElements.webrtcSummary.textContent = "当前浏览器不支持 RTCPeerConnection，无法读取 WebRTC 候选信息。";
          renderDetailList(visitorIpElements.webrtcDetails, [
            { label: "支持状态", value: "不可用" },
          ]);
          renderDetailList(visitorIpElements.webrtcCandidates, []);
          return;
        }

        visitorIpElements.webrtcStatus.textContent = "检测中";
        visitorIpElements.webrtcStatus.className = "visitor-ip-provider-state";
        visitorIpElements.webrtcSummary.textContent = "正在读取本地 WebRTC ICE 候选信息...";

        const candidates = [];
        let connection;
        try {
          connection = new PeerConnection({ iceServers: [] });
          connection.createDataChannel("visitor-ip-check");
          connection.onicecandidate = (event) => {
            if (event.candidate && event.candidate.candidate) {
              candidates.push(event.candidate.candidate);
            }
          };
          const offer = await connection.createOffer();
          await connection.setLocalDescription(offer);
          await new Promise((resolve) => setTimeout(resolve, 1200));
        } catch (error) {
          visitorIpElements.webrtcStatus.textContent = "检测失败";
          visitorIpElements.webrtcStatus.className = "visitor-ip-provider-state error";
          visitorIpElements.webrtcSummary.textContent = error && error.message ? error.message : "WebRTC 候选信息读取失败。";
          renderDetailList(visitorIpElements.webrtcDetails, [
            { label: "支持状态", value: "可用" },
            { label: "检测结果", value: "失败" },
          ]);
          renderDetailList(visitorIpElements.webrtcCandidates, []);
          return;
        } finally {
          if (connection) {
            connection.onicecandidate = null;
            connection.close();
          }
        }

        const uniqueCandidates = [...new Set(candidates)];
        const addresses = [...new Set(uniqueCandidates.map(extractWebRtcAddress).filter(Boolean))];
        const mdnsCount = addresses.filter((address) => address.endsWith(".local")).length;
        const ipCount = addresses.length - mdnsCount;
        const exposedPrivate = addresses.filter(isPrivateCandidateAddress).length;
        const exposedPublic = addresses.filter(isPublicCandidateAddress).length;

        visitorIpElements.webrtcStatus.textContent = uniqueCandidates.length > 0 ? "已完成" : "未发现";
        visitorIpElements.webrtcStatus.className = "visitor-ip-provider-state ok";
        visitorIpElements.webrtcSummary.textContent = uniqueCandidates.length > 0
          ? `发现 ${uniqueCandidates.length} 条 ICE 候选，地址 ${addresses.length} 个。`
          : "未发现浏览器暴露 WebRTC ICE 候选地址。";
        renderDetailList(visitorIpElements.webrtcDetails, [
          { label: "支持状态", value: "可用" },
          { label: "候选数量", value: `${uniqueCandidates.length} 条` },
          { label: "地址数量", value: `${addresses.length} 个` },
          { label: "mDNS 隐藏", value: mdnsCount > 0 ? `${mdnsCount} 个` : "未发现" },
          { label: "私网地址", value: exposedPrivate > 0 ? `${exposedPrivate} 个` : "未发现" },
          { label: "公网地址", value: exposedPublic > 0 ? `${exposedPublic} 个` : "未发现" },
        ]);
        renderDetailList(visitorIpElements.webrtcCandidates, uniqueCandidates.map((candidate, index) => ({
          label: `#${index + 1}`,
          value: candidate,
        })));
      }

      function extractWebRtcAddress(candidate) {
        const parts = String(candidate || "").split(/\s+/);
        const hostIndex = parts.findIndex((part) => part === "typ");
        const address = parts[4] || "";
        if (address && (address.includes(".") || address.includes(":"))) {
          return address;
        }
        const local = parts.find((part) => part.endsWith(".local"));
        if (local) {
          return local;
        }
        if (hostIndex > 0 && parts[hostIndex - 1]) {
          return parts[hostIndex - 1];
        }
        return "";
      }

      function isPrivateCandidateAddress(address) {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
          return false;
        }
        const [a, b] = address.split(".").map(Number);
        return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      }

      function isPublicCandidateAddress(address) {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
          return false;
        }
        return !isPrivateCandidateAddress(address);
      }

      function renderProviderDetails(checks) {
        const abuse = checks && checks.abuse ? checks.abuse : null;
        const residential = checks && checks.residential ? checks.residential : null;
        const risk = checks && checks.risk ? checks.risk : null;

        setProviderMeta(visitorIpElements.abuseStatus, visitorIpElements.abuseProviderSummary, abuse);
        renderDetailList(visitorIpElements.abuseDetails, [
          { label: "状态", value: providerStateLabel(abuse) },
          { label: "结论", value: abuse && abuse.label },
          { label: "置信分", value: abuse && abuse.abuseConfidenceScore !== null && abuse.abuseConfidenceScore !== undefined ? String(abuse.abuseConfidenceScore) : "" },
          { label: "举报次数", value: abuse && abuse.totalReports !== null && abuse.totalReports !== undefined ? `${abuse.totalReports} 次` : "" },
          { label: "最近上报", value: abuse && abuse.lastReportedAt },
          { label: "线路类型", value: abuse && abuse.usageType },
          { label: "运营商", value: abuse && abuse.isp },
          { label: "国家代码", value: abuse && abuse.countryCode },
        ]);

        setProviderMeta(visitorIpElements.residentialStatus, visitorIpElements.residentialProviderSummary, residential);
        renderDetailList(visitorIpElements.residentialDetails, [
          { label: "状态", value: providerStateLabel(residential) },
          { label: "结论", value: residential && residential.label },
          { label: "用途类型", value: residential && residential.usageType },
          { label: "分类", value: residential && residential.category },
          { label: "连接类型", value: residential && residential.connectionType },
          { label: "运营商", value: residential && residential.isp },
          { label: "ASN", value: residential && residential.asn },
          { label: "国家", value: residential && residential.countryName },
        ]);

        setProviderMeta(visitorIpElements.riskStatus, visitorIpElements.riskProviderSummary, risk);
        renderDetailList(visitorIpElements.riskDetails, [
          { label: "状态", value: providerStateLabel(risk) },
          { label: "风险等级", value: risk && risk.level },
          { label: "是否高风险", value: risk ? boolText(risk.isThreat) : "" },
          { label: "Tor", value: risk && risk.threat ? boolText(risk.threat.isTor) : "" },
          { label: "代理", value: risk && risk.threat ? boolText(risk.threat.isProxy) : "" },
          { label: "匿名网络", value: risk && risk.threat ? boolText(risk.threat.isAnonymous) : "" },
          { label: "已知攻击者", value: risk && risk.threat ? boolText(risk.threat.isKnownAttacker) : "" },
          { label: "已知滥用者", value: risk && risk.threat ? boolText(risk.threat.isKnownAbuser) : "" },
          { label: "数据中心", value: risk && risk.threat ? boolText(risk.threat.isDatacenter) : "" },
          { label: "iCloud Relay", value: risk && risk.threat ? boolText(risk.threat.isIcloudRelay) : "" },
          { label: "bogon", value: risk && risk.threat ? boolText(risk.threat.isBogon) : "" },
        ]);
      }

      function loadIplarkFrame() {
        if (!visitorIpElements.iplarkPanel || !visitorIpElements.iplarkFrame) {
          return;
        }
        visitorIpElements.iplarkPanel.hidden = false;
        if (!visitorIpElements.iplarkFrame.src) {
          visitorIpElements.iplarkFrame.src = visitorIpElements.iplarkFrame.dataset.src;
        }
      }

      async function loadVisitorIpCheck() {
        visitorIpRefresh.disabled = true;
        visitorIpResult.hidden = true;
        loadIplarkFrame();
        setVisitorIpStatus("正在检测当前访问 IP...", true);

        try {
          const response = await fetch("/api/visitor-ip-check", {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          });
          const text = await response.text();
          let data = {};
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            throw new Error(`检测接口没有返回 JSON，HTTP ${response.status}。`);
          }
          if (!response.ok) {
            throw new Error(data.message || `检测失败，HTTP ${response.status}。`);
          }

          visitorIpElements.ip.textContent = data.ip || "未知";
          visitorIpElements.location.textContent = formatLocation(data.visitor_network);
          visitorIpElements.isp.textContent = pickPrimaryIsp(data.checks);
          visitorIpElements.asn.textContent = pickPrimaryAsn(data.checks);
          visitorIpElements.networkType.textContent = pickPrimaryNetworkType(data.checks);
          visitorIpElements.protocol.textContent = formatIpProtocol(data.ip);
          visitorIpElements.checkedAt.textContent = formatCheckedAt(data.checked_at);
          visitorIpElements.providerSummary.textContent = data.provider_summary || "暂无来源摘要。";
          visitorIpElements.notice.textContent = data.notice || "";

          fillProvider(visitorIpElements.abuseLabel, visitorIpElements.abuseSummary, data.checks && data.checks.abuse);
          fillProvider(visitorIpElements.residentialLabel, visitorIpElements.residentialSummary, data.checks && data.checks.residential);
          fillProvider(visitorIpElements.riskLabel, visitorIpElements.riskSummary, data.checks && data.checks.risk);
          renderRiskTags(buildRiskTags(data.checks && data.checks.risk));
          renderBrowserEnvironment();
          await renderWebRtcExposure();
          renderProviderDetails(data.checks || {});

          visitorIpResult.hidden = false;
          setVisitorIpStatus(data.message || "已完成当前访问 IP 检测。", true);
        } catch (error) {
          visitorIpResult.hidden = true;
          setVisitorIpStatus(error.message || "当前访问 IP 检测失败，请稍后重试。", false);
        } finally {
          visitorIpRefresh.disabled = false;
        }
      }

      visitorIpRefresh.addEventListener("click", loadVisitorIpCheck);
    </script>"""



def write_visitor_ip_page() -> None:
    body = f"""    <div class="toolbar">
      <a class="button secondary" href="/">返回首页</a>
    </div>
{visitor_ip_card()}"""
    html_text = page_shell(
        "我的 IP 是什么？访问 IP 风险 / 家宽 / 代理检测",
        body,
        visitor_ip_script(),
        description="手动检测当前访问者公网 IP，查看位置、运营商、ASN、家宽判断，以及代理、Tor、数据中心等风险标记。",
    )
    (PUBLIC / "visitor-ip.html").write_text(html_text, encoding="utf-8")


def write_index(articles: list[dict[str, Any]]) -> None:
    successful_articles = [article for article in articles if article.get("success")]
    failed_count = len(articles) - len(successful_articles)
    items = []
    for article in successful_articles:
        title = html.escape(article.get("title") or "未命名文章")
        detail_href = article_detail_path(article)
        original_href = html.escape(article["url"], quote=True)
        meta_html = article_meta(article)
        meta_block = f'<div class="article-meta">\n          {meta_html}\n        </div>' if meta_html else ""
        source_label = list_source_label(article)
        items.append(
            f"""      <li class="article-item">
        <div class="article-title-row">
          <h2><a href="{detail_href}">{title}</a></h2>
          <span class="source-badge">{source_label}</span>
        </div>
        {meta_block}
        <div class="links">
          <a href="{detail_href}">查看归档页</a>
          <a href="{original_href}" target="_blank" rel="noopener noreferrer">查看原文</a>
        </div>
      </li>"""
        )

    if items:
        list_html = '<ul class="article-list">\n' + "\n".join(items) + "\n    </ul>"
    else:
        list_html = '<p class="empty">暂无成功归档的文章。请通过管理员提交页添加公开文章链接。</p>'

    failure_note = (
        f'<p class="help">另有 {failed_count} 条链接暂未归档成功，已从公开列表中隐藏。</p>'
        if failed_count > 0
        else ""
    )

    body = f"""    <header class="site-header">
      <h1 class="site-title">公开文章归档</h1>
      <p class="site-desc">手动收录公开文章链接，优先适配微信公众号文章，提供更稳定的归档阅读页与原文入口。</p>
      <div class="toolbar">
        <span class="meta">共 {len(articles)} 条链接，成功归档 {len(successful_articles)} 篇</span>
        <div class="toolbar-actions">
          <a class="button secondary" href="/visitor-ip">访问 IP 检测工具</a>
          <a class="button secondary" href="/submit">管理员入口</a>
        </div>
      </div>
      {failure_note}
    </header>
    <section class="panel">
      <header class="panel-header">
        <h2 class="section-title">最新归档</h2>
        <p class="help">首页仅展示成功归档的文章，原文链接会继续保留在详情页中。</p>
      </header>
{list_html}
    </section>"""
    (PUBLIC / "index.html").write_text(
        page_shell(
            "公开文章归档",
            body,
            description="手动收录公开文章链接，优先适配微信公众号文章，提供稳定的归档阅读页与原文入口。",
        ),
        encoding="utf-8",
    )


def cleanup_unused_image_dirs(articles: list[dict[str, Any]]) -> None:
    active_ids = {article.get("id") for article in articles if article.get("id")}
    if not IMAGES_DIR.exists():
        return

    for image_dir in IMAGES_DIR.iterdir():
        if image_dir.is_dir() and image_dir.name not in active_ids:
            shutil.rmtree(image_dir)


def build() -> None:
    cached_articles = load_cached_articles()
    ensure_dirs()
    write_style()
    write_submit_page()
    write_visitor_ip_page()

    urls = load_urls()
    articles = []
    for index, url in enumerate(urls):
        if not REFETCH_ALL and url in cached_articles:
            article = cached_articles[url]
        else:
            if index > 0:
                time.sleep(2)
            article = fetch_article(url)
            if not article.get("success") and url in cached_articles:
                article = cached_articles[url]
        article = localize_article_images(article)
        articles.append(article)
        write_article_page(article)

    articles = sort_articles_by_publish_time(articles)
    cleanup_unused_image_dirs(articles)
    write_index(articles)
    write_articles_cache(articles)


if __name__ == "__main__":
    build()
