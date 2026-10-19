import { DomHandler, DomUtils, Parser, parseDocument } from 'htmlparser2';
import { parseArticleHtml } from './article-parser.js';
import { CollectorError, resolvePublicHost, safeFetch, validatePublicUrl } from './collector-security.js';

export const RSS_FEED_URL = 'https://wechat2rss.xlab.app/feed/33d986064f59be5263de2ca822fb3e0bdd59eb81.xml';
export const RSS_ACCOUNT_BIZ = 'MzE5ODk2NjUwOA==';
export const RSS_STATE_KEY = 'private/rss/source-state.json';
const SOURCE_NAME = '猫笔刀';
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 100;
const IMAGE_HOSTS = new Set(['mmbiz.qpic.cn', 'res.wx.qq.com']);
const SNAPSHOT_KEY = /^private\/rss\/articles\/([a-f0-9]{64})\.json$/;
const encoder = new TextEncoder();

function fail(code = 'RSS_INVALID', message = 'RSS 内容格式无效，未完成存档', retryable = false) {
  throw new CollectorError(code, message, retryable);
}

async function hash(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function bucket(env) {
  if (!env.ARCHIVE_BUCKET?.put || !env.ARCHIVE_BUCKET?.get) fail('CONFIG_MISSING', '请配置 RSS 正文存储');
  return env.ARCHIVE_BUCKET;
}

function children(node, name) { return (node.children || []).filter(child => child.name === name); }
function one(node, name, required = true) {
  const values = children(node, name);
  if (values.length > 1 || required && values.length !== 1) fail();
  return values[0];
}
function value(node, name, required = true) {
  const element = one(node, name, required);
  return element ? DomUtils.textContent(element).trim() : '';
}

function xmlDocument(xml) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) fail('RSS_INVALID', 'RSS 不允许 DTD 或自定义实体');
  const handler = new DomHandler();
  let events = 0;
  let depth = 0;
  const count = () => { if (++events > 100_000) fail('RESOURCE_TOO_LARGE', 'RSS 结构超过安全解析范围'); };
  new Parser({
    onparserinit: parser => handler.onparserinit(parser),
    onopentag(name, attributes) {
      count();
      if (++depth > 128) fail('RESOURCE_TOO_LARGE', 'RSS 结构超过安全解析范围');
      handler.onopentag(name, attributes);
    },
    onclosetag() { handler.onclosetag(); depth--; },
    ontext(text) { count(); handler.ontext(text); },
    oncomment(text) { count(); handler.oncomment(text); },
    oncommentend: () => handler.oncommentend(),
    oncdatastart: () => handler.oncdatastart(),
    oncdataend: () => handler.oncdataend(),
    onprocessinginstruction(name, data) { count(); handler.onprocessinginstruction(name, data); },
    onend: () => handler.onend(),
  }, { xmlMode: true, decodeEntities: true }).end(xml);
  const root = one(handler.root, 'rss');
  if (root.attribs.version !== '2.0') fail();
  return one(root, 'channel');
}

function articleIdentity(input) {
  const url = validatePublicUrl(input);
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.pathname !== '/s'
      || url.searchParams.getAll('__biz').length !== 1 || url.searchParams.get('__biz') !== RSS_ACCOUNT_BIZ
      || url.searchParams.getAll('mid').length !== 1 || !/^\d{1,32}$/.test(url.searchParams.get('mid') || '')
      || url.searchParams.getAll('idx').length > 1 || !/^[1-9]\d{0,2}$/.test(url.searchParams.get('idx') || '1')) {
    fail('RSS_SOURCE_MISMATCH', 'RSS 文章不是指定公众号的有效文章');
  }
  return { url: url.href, source_key: `wechat:${RSS_ACCOUNT_BIZ}:${url.searchParams.get('mid')}:${url.searchParams.get('idx') || '1'}` };
}

function publishedTime(input) {
  // RSS dates must include an explicit timezone; server-local parsing is never a source timestamp.
  const parts = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UTC|[+-]\d{4})$/i.exec(input);
  if (!parts) fail('RSS_TIME_INVALID', 'RSS 文章缺少可信发布时间');
  const timestamp = Date.parse(input);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) fail('RSS_TIME_INVALID', 'RSS 文章缺少可信发布时间');
  const zone = parts[7];
  const hours = /^[+-]/.test(zone) ? Number(zone.slice(1, 3)) : 0;
  const minutes = /^[+-]/.test(zone) ? Number(zone.slice(3, 5)) : 0;
  if (hours > 23 || minutes > 59) fail('RSS_TIME_INVALID', 'RSS 文章缺少可信发布时间');
  const offset = (hours * 60 + minutes) * 60_000 * (zone[0] === '-' ? -1 : 1);
  const local = new Date(timestamp + offset);
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(parts[2].toLowerCase());
  if (local.getUTCDate() !== Number(parts[1]) || local.getUTCMonth() !== month || local.getUTCFullYear() !== Number(parts[3])
      || local.getUTCHours() !== Number(parts[4]) || local.getUTCMinutes() !== Number(parts[5])
      || local.getUTCSeconds() !== Number(parts[6] || 0)) fail('RSS_TIME_INVALID', 'RSS 文章缺少可信发布时间');
  return timestamp;
}

function imageUrl(input) {
  let url = validatePublicUrl(input);
  if (url.origin === 'https://wechat2rss.xlab.app' && /^\/img-proxy\/?$/.test(url.pathname)) {
    if (url.searchParams.getAll('u').length !== 1) fail('IMAGE_INCOMPLETE', 'RSS 图片代理地址无效');
    url = validatePublicUrl(url.searchParams.get('u'));
  }
  if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname)) fail('IMAGE_INCOMPLETE', 'RSS 图片不是受支持的微信公开图片');
  return url.href;
}

function articleDocument(rawHtml, url) {
  if (typeof rawHtml !== 'string' || !rawHtml.trim()) fail('ARTICLE_INVALID', 'RSS 未包含完整正文');
  const doc = parseArticleHtml(`<article>${rawHtml}</article>`, { url, wechat: false });
  if (doc.invalid || doc.challenge || doc.removed) fail('ARTICLE_INVALID', 'RSS 正文不可用，采集未完成');
  if (doc.images.length > 100) fail('RESOURCE_TOO_LARGE', 'RSS 文章图片过多');
  const images = doc.images.map(imageUrl);
  // The parser has already selected each image's real data-src/data-original/src.
  const document = parseDocument(doc.html, { decodeEntities: true });
  let index = 0;
  const stack = [...document.children].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (node.name === 'img') node.attribs.src = images[index++];
    if (node.name === 'template') continue;
    for (let child = (node.children?.length || 0) - 1; child >= 0; child--) stack.push(node.children[child]);
  }
  return { html: DomUtils.getInnerHTML(document, { encodeEntities: 'utf8', emptyAttrs: true }), text: doc.text,
    images: [...new Set(images)], unsupported_background: doc.unsupported_background };
}

function snapshotValue(item, sourceName) {
  const identity = articleIdentity(value(item, 'link'));
  const title = value(item, 'title');
  if (!title || title.length > 1000) fail('ARTICLE_INVALID', 'RSS 文章标题无效');
  const rawHtml = value(item, 'content:encoded');
  const doc = articleDocument(rawHtml, identity.url);
  return { kind: 'wechat-rss-article', format: 1, feed_url: RSS_FEED_URL, account_biz: RSS_ACCOUNT_BIZ,
    ...identity, title, author: value(item, 'dc:creator', false) || value(item, 'author', false) || sourceName,
    source_name: sourceName, published_at: publishedTime(value(item, 'pubDate')),
    raw_html: rawHtml, ...doc };
}

async function putObject(storage, key, body, contentType) {
  try { await storage.put(key, body, { httpMetadata: { contentType, cacheControl: 'private, no-store' } }); }
  catch { fail('STORAGE_WRITE_FAILED', 'RSS 正文快照保存失败，请稍后重试', true); }
}

export function createRssSource({ fetchImpl = fetch, resolveHost = resolvePublicHost, now = Date.now } = {}) {
  async function fetchSource(env, source = {}) {
    const storage = bucket(env);
    if (source.account_biz && source.account_biz !== RSS_ACCOUNT_BIZ
        || source.rss_feed_url && source.rss_feed_url !== RSS_FEED_URL) fail('RSS_SOURCE_MISMATCH', 'RSS 来源配置与指定公众号不一致');
    const fetchedAt = now();
    if (!Number.isSafeInteger(fetchedAt) || fetchedAt <= 0) fail('CONFIG_INVALID', 'RSS 采集时钟无效');
    const response = await safeFetch(RSS_FEED_URL, { fetchImpl, resolveHost, maxBytes: MAX_BYTES, maxRedirects: 0,
      accept: 'application/rss+xml,application/xml,text/xml' });
    if (!/^(?:application\/(?:rss\+)?xml|text\/xml)(?:;|$)/i.test(response.contentType)) fail('RSS_INVALID', '来源未返回 RSS XML');
    let xml;
    try { xml = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes); } catch { fail(); }
    const channel = xmlDocument(xml);
    if (value(channel, 'title') !== SOURCE_NAME) fail('RSS_SOURCE_MISMATCH', 'RSS 频道不是指定公众号');
    const items = children(channel, 'item');
    if (!items.length) fail('RSS_INVALID', 'RSS 暂未包含文章，保留已有存档范围');
    if (items.length > MAX_ITEMS) fail('RESOURCE_TOO_LARGE', 'RSS 文章数量超过安全范围');
    const snapshots = items.map(item => snapshotValue(item, SOURCE_NAME));
    const seen = new Set();
    for (const snapshot of snapshots) {
      if (seen.has(snapshot.source_key)) fail('RSS_INVALID', 'RSS 包含重复文章标识');
      seen.add(snapshot.source_key);
    }
    const articles = [];
    // Await every immutable snapshot before exposing any article to scheduling.
    for (const snapshot of snapshots) {
      const body = JSON.stringify(snapshot);
      if (encoder.encode(body).byteLength > MAX_BYTES) fail('RESOURCE_TOO_LARGE', 'RSS 正文快照超过允许大小');
      const key = `private/rss/articles/${await hash(body)}.json`;
      await putObject(storage, key, body, 'application/json');
      articles.push({ source_key: snapshot.source_key, url: snapshot.url, title: snapshot.title,
        author: snapshot.author, published_at: snapshot.published_at, time_trusted: true,
        metadata: { source_kind: 'rss', rss_snapshot_key: key } });
    }
    const feedKey = `private/rss/feeds/${await hash(response.bytes)}.xml`;
    await putObject(storage, feedKey, response.bytes, 'application/rss+xml');
    const state = { kind: 'wechat-rss-source-state', format: 1, feed_url: RSS_FEED_URL, account_biz: RSS_ACCOUNT_BIZ,
      articles, snapshot_key: feedKey, fetched_at: fetchedAt,
      coverage_start: Math.min(...articles.map(article => article.published_at)),
      coverage_end: Math.max(...articles.map(article => article.published_at)) };
    // Publish the small recovery manifest only after every referenced object exists.
    await putObject(storage, RSS_STATE_KEY, JSON.stringify(state), 'application/json');
    return state;
  }
  return { fetchSource };
}

export async function fetchSource(env, source) { return createRssSource().fetchSource(env, source); }

/** A saved body remains usable after its entry disappears from the rolling feed. */
export async function loadRssArticle(env, article) {
  const key = article?.metadata?.rss_snapshot_key;
  const digest = typeof key === 'string' && SNAPSHOT_KEY.exec(key)?.[1];
  if (!digest) fail('RSS_SNAPSHOT_INVALID', 'RSS 正文快照标识无效');
  const object = await bucket(env).get(key);
  if (!object) fail('RSS_SNAPSHOT_MISSING', 'RSS 正文快照不存在，未完成采集');
  if (!Number.isSafeInteger(object.size) || object.size < 1 || typeof object.text !== 'function') fail('RSS_SNAPSHOT_INVALID', 'RSS 正文快照格式无效');
  if (object.size > MAX_BYTES) fail('RESOURCE_TOO_LARGE', 'RSS 正文快照超过允许大小');
  const body = await object.text();
  if (typeof body !== 'string' || encoder.encode(body).byteLength > MAX_BYTES) fail('RESOURCE_TOO_LARGE', 'RSS 正文快照超过允许大小');
  if (await hash(body) !== digest) fail('RSS_SNAPSHOT_INVALID', 'RSS 正文快照校验失败');
  let snapshot;
  try { snapshot = JSON.parse(body); } catch { fail('RSS_SNAPSHOT_INVALID', 'RSS 正文快照格式无效'); }
  if (!snapshot || snapshot.kind !== 'wechat-rss-article' || snapshot.format !== 1 || snapshot.feed_url !== RSS_FEED_URL
      || snapshot.account_biz !== RSS_ACCOUNT_BIZ || snapshot.source_name !== SOURCE_NAME
      || typeof snapshot.title !== 'string' || !snapshot.title.trim() || snapshot.title.length > 1000
      || typeof snapshot.author !== 'string' || !Number.isSafeInteger(snapshot.published_at) || snapshot.published_at <= 0) fail('RSS_SNAPSHOT_INVALID', 'RSS 正文快照格式无效');
  const identity = articleIdentity(snapshot.url);
  const expected = articleIdentity(article.url);
  if (snapshot.source_key !== identity.source_key || identity.source_key !== expected.source_key
      || article.source_key && article.source_key !== identity.source_key
      || article.published_at != null && article.published_at !== snapshot.published_at) fail('RSS_SNAPSHOT_INVALID', 'RSS 正文快照与文章记录不一致');
  const doc = articleDocument(snapshot.raw_html, identity.url);
  if (doc.unsupported_background) fail('IMAGE_INCOMPLETE', 'RSS 正文包含尚未支持保存的背景图片，采集未完成');
  if (doc.html !== snapshot.html || doc.text !== snapshot.text || JSON.stringify(doc.images) !== JSON.stringify(snapshot.images)
      || snapshot.unsupported_background !== false) fail('RSS_SNAPSHOT_INVALID', 'RSS 正文快照内容校验失败');
  return { title: snapshot.title, author: snapshot.author, source_name: snapshot.source_name,
    published_at: snapshot.published_at, html: doc.html, text: doc.text,
    images: doc.images.map(source_url => ({ source_url })), original_url: identity.url,
    source_key: identity.source_key, metadata: { source_kind: 'rss', rss_snapshot_key: key } };
}
