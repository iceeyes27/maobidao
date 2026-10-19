import { CollectorError, assertImage, classifyCollectorError, collectorDiagnostic, resolvePublicHost, safeFetch, validatePublicUrl } from './collector-security.js';
import { SessionStore } from './collector-session.js';
import { fetchImageResource, imageResourceId, IMAGE_LIMIT } from './resources.js';
import { restoreLoginStorage } from './login-storage.js';
import { acquireBrowser } from './browser-acquisition.js';
import { summarizeBrowserUsage } from './browser-usage.js';
import { createWechatHttp } from './wechat-http.js';
import { parseArticleHtml } from './article-parser.js';
import { loadArticleVerification, saveArticleVerification } from './article-verification.js';
import { createRssSource, loadRssArticle, RSS_ACCOUNT_BIZ } from './rss-source.js';

export { CollectorError } from './collector-security.js';

const MP_ORIGIN = 'https://mp.weixin.qq.com';
const LOGIN_DOMAINS = ['mp.weixin.qq.com', 'res.wx.qq.com', 'res2.wx.qq.com', 'open.weixin.qq.com',
  'wx2.qq.com', 't.captcha.qq.com', 'ssl.captcha.qq.com', 'captcha.qcloud.com', 'turing.captcha.qcloud.com',
  '*.qpic.cn', '*.qlogo.cn', '*.gtimg.com'];
const HTML_LIMIT = 4 * 1024 * 1024;
// Leave headroom for DOM serialization, image decoding and publisher sanitization
// within a Worker's memory limit while returning all image bytes together.
const ARTICLE_IMAGE_LIMIT = 24 * 1024 * 1024;
const IMAGE_COUNT_LIMIT = 100;

function asCollectorError(error) {
  return classifyCollectorError(error);
}

function secondsToMillis(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 946684800 && n <= Date.now() / 1000 + 300 ? Math.floor(n * 1000) : null;
}

function jsonObject(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { throw new CollectorError('SOURCE_FORMAT_CHANGED', '来源文章列表格式已变化，需要检查采集适配器'); }
}

function extractRows(payload) {
  const body = jsonObject(payload.publish_page) || payload;
  const groups = body.publish_list ?? body.free_publish_list ?? body.app_msg_list;
  if (!Array.isArray(groups)) throw new CollectorError('SOURCE_FORMAT_CHANGED', '来源未返回已发表文章列表');
  const rows = groups.flatMap(group => {
    if (group.publish_info) {
      const info = jsonObject(group.publish_info);
      return Array.isArray(info?.appmsgex) ? info.appmsgex : info?.aid ? [info] : [];
    }
    return Array.isArray(group.appmsgex) ? group.appmsgex : [group];
  });
  if (groups.length && !rows.length) throw new CollectorError('SOURCE_FORMAT_CHANGED', '来源文章列表缺少可识别的文章');
  return { rows, groupCount: groups.length, total: Number(body.total_count ?? payload.total_count) };
}

/** Preserve upstream creation time; update_time is never a publication-time fallback. */
export function normalizeSourcePage(payload, source, cursor, count) {
  const { rows, groupCount, total } = extractRows(payload);
  if (groupCount === 0 && Number.isFinite(total) && total > cursor) {
    throw new CollectorError('SOURCE_FORMAT_CHANGED', '来源分页返回空页，尚未越过该页继续采集');
  }
  const seen = new Set();
  const articles = rows.map(row => {
    const url = validatePublicUrl(String(row.link || row.url || '')).href;
    if (new URL(url).hostname !== 'mp.weixin.qq.com') throw new CollectorError('SOURCE_FORMAT_CHANGED', '来源列表包含非微信文章地址');
    const parsed = new URL(url);
    if (source.account_biz && parsed.searchParams.has('__biz') && parsed.searchParams.get('__biz') !== source.account_biz) {
      throw new CollectorError('SOURCE_FORMAT_CHANGED', '来源列表中的公众号标识与目标不一致');
    }
    const mid = parsed.searchParams.get('mid');
    const identity = row.aid || row.appmsgid && `${row.appmsgid}_${row.itemidx || 1}` ||
      mid && `${parsed.searchParams.get('__biz') || source.fakeid}:${mid}:${parsed.searchParams.get('idx') || 1}` ||
      /^\/s\/[\w-]+$/.test(parsed.pathname) && parsed.pathname;
    if (!identity || !row.title) throw new CollectorError('SOURCE_FORMAT_CHANGED', '来源文章缺少稳定标识或标题');
    const publishedAt = secondsToMillis(row.create_time);
    const aidParts = /^(\d+)_(\d+)$/.exec(String(row.aid || ''));
    const biz = parsed.searchParams.get('__biz') || source.account_biz;
    const articleMid = mid || row.appmsgid || aidParts?.[1];
    const articleIdx = parsed.searchParams.get('idx') || row.itemidx || aidParts?.[2] || '1';
    const sourceKey = biz && articleMid ? `wechat:${biz}:${articleMid}:${articleIdx}` : `wechat:${source.fakeid}:${identity}`;
    return {
      source_key: sourceKey, url, title: String(row.title),
      author: String(row.author || ''), published_at: publishedAt, time_trusted: publishedAt !== null,
      ...(row.cover ? { cover: String(row.cover) } : {}),
    };
  }).filter(row => !seen.has(row.source_key) && seen.add(row.source_key));
  return {
    articles, next_cursor: cursor + groupCount,
    has_more: Number.isFinite(total) ? cursor + groupCount < total : groupCount >= count,
  };
}

// Runs in an inert browser document. No source scripts or subresources are executed.
export function extractArticleDocument({ url, wechat }) {
  const meta = (...selectors) => selectors.map(s => document.querySelector(s)?.getAttribute('content')?.trim()).find(Boolean) || '';
  const textAt = (...selectors) => selectors.map(s => document.querySelector(s)?.textContent?.trim()).find(Boolean) || '';
  const root = wechat ? document.querySelector('#js_content') : document.querySelector('article, main, [role="main"]') || document.body;
  const pageText = document.body?.textContent || '';
  const challengeMarkers = /当前环境异常|完成验证后即可继续访问|访问过于频繁|请完成安全验证|verify you are human|checking your browser/i.test(pageText.slice(0, 6000));
  const challenge = challengeMarkers && (wechat ? !root : !document.querySelector('article') && pageText.length < 2000);
  const removed = /该内容已被发布者删除|此内容因违规无法查看|你暂无权限查看此页面内容|此内容已被删除/.test(pageText);
  if (!root) return { invalid: true, challenge, removed };
  // CSS images are not represented by <img> and the publisher strips CSS URLs.
  // Refuse the article until those assets have a supported archival path.
  let unsupportedBackground = false;
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const pseudo of [null, '::before', '::after']) {
      if (/url\s*\(/i.test(getComputedStyle(element, pseudo).backgroundImage || '')) {
        unsupportedBackground = true;
        break;
      }
    }
    if (unsupportedBackground) break;
  }
  // Preserve a deterministic original URL on each image so the publisher can rewrite it.
  const images = [];
  for (const img of root.querySelectorAll('img')) {
    const candidate = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src') || '';
    let src = candidate;
    if (candidate) {
      try { src = new URL(candidate, url).href; } catch { /* rejected by caller */ }
    }
    images.push(src);
    img.setAttribute('src', src);
    img.removeAttribute('srcset');
    img.removeAttribute('data-src');
    img.removeAttribute('data-original');
  }
  const textCopy = root.cloneNode(true);
  textCopy.querySelectorAll('script,style,nav,noscript,form').forEach(el => el.remove());
  const articleText = textCopy.textContent?.replace(/\s+/g, ' ').trim() || '';
  const hasContent = Boolean(articleText || images.length);
  let canonical = '';
  let createdSeconds = null;
  if (wechat) {
    const candidate = meta('meta[property="og:url"]') || document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
    try {
      const parsed = new URL(candidate, url);
      if (parsed.hostname === 'mp.weixin.qq.com' && parsed.searchParams.has('__biz') && parsed.searchParams.has('mid')) canonical = parsed.href;
    } catch { /* keep original URL when the source has no valid canonical */ }
    const scripts = [...document.querySelectorAll('script:not([src])')].map(s => s.textContent).join('\n');
    const ct = scripts.match(/\bvar\s+ct\s*=\s*["']?(\d{10})["']?\s*;/);
    if (ct) createdSeconds = Number(ct[1]);
  }
  return {
    invalid: !hasContent, challenge: wechat ? challengeMarkers && !hasContent : challenge, removed, html: root.innerHTML,
    text: articleText, images,
    title: textAt('#activity-name', 'h1') || meta('meta[property="og:title"]') || document.title,
    author: textAt('#js_author_name', '.rich_media_meta_text') || meta('meta[name="author"]'),
    source_name: textAt('#js_name', '#profileBt') || meta('meta[property="og:site_name"]'),
    date: meta('meta[property="article:published_time"]', 'meta[name="date"]') || document.querySelector('time[datetime]')?.getAttribute('datetime') || '',
    canonical, created_seconds: createdSeconds, unsupported_background: unsupportedBackground,
  };
}

function assertArticle(doc) {
  if (doc.removed) throw new CollectorError('ARTICLE_INVALID', '原文章已删除或无法查看');
  if (doc.challenge) throw new CollectorError('CHALLENGE_REQUIRED', '来源要求安全验证，采集未完成，请检查来源登录状态');
  if (doc.unsupported_background) throw new CollectorError('IMAGE_INCOMPLETE', '正文包含尚不支持保存的 CSS 背景图片，采集未完成');
  if (doc.invalid || !doc.title?.trim() || (!doc.text?.trim() && !doc.images?.length)) {
    throw new CollectorError('ARTICLE_INVALID', '来源没有完整可识别的文章正文');
  }
  if (doc.images.length > IMAGE_COUNT_LIMIT) throw new CollectorError('RESOURCE_TOO_LARGE', '文章图片数量超过允许范围');
}

/** Dependencies are injectable for deterministic tests; production uses the Cloudflare binding. */
export function createCollector({ playwright, fetchImpl = fetch, resolveHost, now = () => Date.now(), sleep, httpClient } = {}) {
  const wechatHttp = httpClient || createWechatHttp({ fetchImpl, resolveHost: resolveHost || resolvePublicHost, now });
  const browserTiming = env => {
    const configured = env.ARCHIVE_BROWSER_DAILY_BUDGET_SECONDS;
    const dailyBudgetSeconds = configured === undefined ? 0 : Number(configured);
    if (!Number.isFinite(dailyBudgetSeconds) || dailyBudgetSeconds < 0) {
      throw new CollectorError('CONFIG_INVALID', '每日浏览器运行预算配置无效');
    }
    return { now, dailyBudgetSeconds, ...(sleep ? { sleep } : {}) };
  };
  async function protectOfficialContext(context, resolver = resolveHost || resolvePublicHost) {
    const checked = new Map();
    const stats = { allowed: 0, blocked: 0, failures: [] };
    const failure = (host, stage, code, diagnostic) => {
      stats.blocked++;
      if (stats.failures.length < 3) stats.failures.push({ host, stage, code, ...(diagnostic ? { diagnostic } : {}) });
    };
    await context.route('**/*', async route => {
      let host = 'unknown';
      let stage = 'url';
      try {
        const url = validatePublicUrl(route.request().url());
        host = url.hostname;
        const allowed = LOGIN_DOMAINS.some(host => host.startsWith('*.') ? url.hostname.endsWith(host.slice(1)) : url.hostname === host);
        if (!allowed) { failure(host, 'allowlist', 'DOMAIN_NOT_ALLOWED'); return await route.abort(); }
        stage = 'dns';
        if (!checked.has(url.hostname)) checked.set(url.hostname, resolver(url.hostname, fetchImpl));
        await checked.get(url.hostname);
        stage = 'continue';
        await route.continue();
        stats.allowed++;
      } catch (error) {
        const known = ['UNSAFE_URL', 'INVALID_URL', 'UPSTREAM_ERROR', 'RATE_LIMITED'].includes(error?.code);
        failure(host, stage, known ? error.code : stage === 'dns' ? 'DNS_REQUEST_FAILED' : stage === 'continue' ? 'ROUTE_CONTINUE_FAILED' : 'URL_REJECTED',
          stage === 'dns' && !known ? collectorDiagnostic(error).slice(0, 150) : undefined);
        await route.abort().catch(() => {});
      }
    });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => socket.close());
    return stats;
  }
  function officialArticleUrl(value) {
    const url = validatePublicUrl(value);
    if (url.hostname !== 'mp.weixin.qq.com' || !/^\/s(?:\/[\w-]+\/?)?$/.test(url.pathname)) {
      throw new CollectorError('INVALID_URL', '文章验证仅支持微信官方文章链接');
    }
    return url.href;
  }
  async function api(env) {
    if (!env.ARCHIVE_BROWSER) throw new CollectorError('CONFIG_MISSING', '尚未配置 ARCHIVE_BROWSER 云端浏览器绑定');
    return playwright || import('@cloudflare/playwright');
  }
  async function close(browser) { if (browser) await browser.close().catch(() => {}); }
  async function terminate(browser) {
    if (!browser) return;
    try { const cdp = await browser.newBrowserCDPSession(); await cdp.send('Browser.close'); }
    catch { /* session can already have expired; its idle timeout also releases it */ }
    await close(browser);
  }
  async function mpRequest(page, path, params) {
    const token = new URL(page.url()).searchParams.get('token');
    if (!token || !/^\d+$/.test(token)) throw new CollectorError('LOGIN_EXPIRED', '公众号后台登录已失效，请重新扫码');
    const url = new URL(path, MP_ORIGIN);
    url.search = new URLSearchParams({ ...params, token, lang: 'zh_CN', f: 'json', ajax: '1' }).toString();
    const result = await page.evaluate(async href => {
      const response = await fetch(href, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      return { status: response.status, text: text.length <= 4 * 1024 * 1024 ? text : '' };
    }, url.href);
    if (result.status === 429) throw new CollectorError('RATE_LIMITED', '微信暂时限制访问频率', true);
    if (result.status !== 200) throw new CollectorError('UPSTREAM_ERROR', `微信返回 HTTP ${result.status}`, result.status >= 500);
    let body;
    try { body = JSON.parse(result.text); }
    catch { throw new CollectorError('CHALLENGE_REQUIRED', '微信未返回数据，请检查扫码登录或安全验证'); }
    const code = Number(body.base_resp?.ret);
    if ([200003, 200004, 200005].includes(code)) throw new CollectorError('LOGIN_EXPIRED', '公众号后台登录已失效，请重新扫码');
    if (code === -1) throw new CollectorError('UPSTREAM_ERROR', '微信服务暂时繁忙，请稍后重试', true);
    if (code === 200013 || code === 45009) throw new CollectorError('RATE_LIMITED', '微信暂时限制访问频率', true);
    if (code !== 0) throw new CollectorError('SOURCE_FORMAT_CHANGED', `微信采集接口当前不可用（${Number.isFinite(code) ? code : '未知状态'}）`);
    return body;
  }
  async function fetchCaptureImage(env, sourceUrl, resolver) {
    const normalizedUrl = validatePublicUrl(sourceUrl).href;
    // The fallback exists for isolated dependency-injection tests. Production
    // configuration requires the executor binding before tasks are accepted.
    if (!env.ARCHIVE_EXECUTOR) return fetchImageResource(normalizedUrl, { fetchImpl, resolveHost: resolver });
    const response = await env.ARCHIVE_EXECUTOR.getByName(await imageResourceId(normalizedUrl)).fetchImage(normalizedUrl);
    if (!response?.ok) {
      const remote = response?.error;
      const error = new CollectorError(remote?.code || 'UPSTREAM_ERROR', remote?.message || '文章图片暂时无法读取', remote?.retryable === true);
      if (Number.isSafeInteger(remote?.retry_at)) error.retry_at = remote.retry_at;
      if (Number.isInteger(remote?.status)) error.status = remote.status;
      throw error;
    }
    const image = response.value;
    const bytes = image?.bytes instanceof Uint8Array ? image.bytes
      : image?.bytes instanceof ArrayBuffer ? new Uint8Array(image.bytes) : null;
    if (!bytes || image.decoded !== true) throw new CollectorError('IMAGE_INCOMPLETE', '文章图片未通过完整解码校验');
    if (bytes.byteLength > IMAGE_LIMIT) throw new CollectorError('RESOURCE_TOO_LARGE', '文章图片超过允许大小');
    return { url: image.url, bytes, contentType: assertImage(bytes, image.contentType) };
  }
  async function searchSources(env, query) {
    const value = String(query || '').trim();
    if (!value || value.length > 100) throw new CollectorError('INVALID_QUERY', '公众号搜索词须为 1 到 100 个字符');
    const body = await wechatHttp.request(env, '/cgi-bin/searchbiz', { action: 'search_biz', begin: '0', count: '10', query: value });
    if (!Array.isArray(body.list)) throw new CollectorError('SOURCE_FORMAT_CHANGED', '公众号搜索结果格式已变化');
    const sources = body.list.map(row => ({
      name: String(row.nickname || row.name || ''), fakeid: String(row.fakeid || ''),
      ...(row.biz ? { account_biz: String(row.biz) } : {}),
      ...(row.round_head_img ? { avatar: String(row.round_head_img) } : {}),
    })).filter(row => row.name && row.fakeid);
    Object.defineProperty(sources, 'transport', { value: 'http' });
    return sources;
  }
  async function listSourceArticles(env, source, { cursor = 0, count = 5 } = {}) {
    if (source?.fakeid === `rss:${RSS_ACCOUNT_BIZ}`) {
      if (cursor !== 0) throw new CollectorError('INVALID_QUERY', 'RSS 文章列表仅支持完整快照');
      const feed = await createRssSource({ fetchImpl, resolveHost, now }).fetchSource(env, source);
      return { ...feed, next_cursor: feed.articles.length, has_more: false, transport: 'rss' };
    }
    if (!source?.fakeid || !/^[\w=+/-]{1,256}$/.test(source.fakeid) || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isInteger(count) || count < 1 || count > 20) {
      throw new CollectorError('INVALID_QUERY', '公众号标识或分页参数无效');
    }
    // This is WeRSS's published-list endpoint, not its draft/material endpoint.
    // https://github.com/rachelos/we-mp-rss/blob/main/core/wx/model/web.py
    const body = await wechatHttp.request(env, '/cgi-bin/appmsgpublish', {
      sub: 'list', sub_action: 'list_ex', begin: String(cursor), count: String(count), fakeid: source.fakeid,
      search_field: 'null', query: '', type: '101_1', free_publish_type: '1',
    });
    const page = normalizeSourcePage(body, source, cursor, count);
    Object.defineProperty(page, 'transport', { value: 'http' });
    return page;
  }
  async function captureArticle(env, article) {
    const url = validatePublicUrl(article?.url || '');
    // Reuse only this capture's DNS decision. Each redirect still passes URL
    // validation and every new hostname gets its own public-address check.
    const checkedHosts = new Map();
    const resolveCaptureHost = async (hostname, request) => {
      if (!checkedHosts.has(hostname)) checkedHosts.set(hostname, (resolveHost || resolvePublicHost)(hostname, request));
      await checkedHosts.get(hostname);
    };
    if (article?.metadata?.rss_snapshot_key) {
      const saved = await loadRssArticle(env, { ...article, published_at: article.first_published_at ?? article.published_at });
      assertArticle({ ...saved, images: saved.images.map(image => image.source_url) });
      const images = [];
      let totalBytes = 0;
      for (const { source_url: sourceUrl } of saved.images) {
        const image = await fetchCaptureImage(env, sourceUrl, resolveCaptureHost);
        totalBytes += image.bytes.byteLength;
        if (totalBytes > ARTICLE_IMAGE_LIMIT) throw new CollectorError('RESOURCE_TOO_LARGE', '文章图片总大小超过允许范围');
        images.push({ source_url: sourceUrl, bytes: image.bytes, content_type: image.contentType });
      }
      return { ...saved, images };
    }
    const fetched = await safeFetch(url.href, { fetchImpl, resolveHost: resolveCaptureHost, maxBytes: HTML_LIMIT });
    if (!/^text\/html|^application\/xhtml\+xml/i.test(fetched.contentType)) throw new CollectorError('ARTICLE_INVALID', '链接未返回 HTML 文章');
    try {
      let verifiedSnapshot = false;
      let doc = parseArticleHtml(new TextDecoder().decode(fetched.bytes), {
        url: fetched.url, wechat: new URL(fetched.url).hostname === 'mp.weixin.qq.com',
      });
      if (doc.challenge && !doc.removed && url.hostname === 'mp.weixin.qq.com') {
        const store = new SessionStore(env, now);
        try {
          const saved = await store.load();
          const verified = await loadArticleVerification(env, {
            url: url.href, version: saved.version, loginId: store.loadedLoginId,
          }, now());
          if (verified) { doc = verified; verifiedSnapshot = true; }
        } catch (error) {
          if (!['LOGIN_REQUIRED', 'LOGIN_EXPIRED'].includes(error.code)) throw error;
        }
      }
      assertArticle(doc);
      const images = [];
      let totalBytes = 0;
      for (const sourceUrl of new Set(doc.images)) {
        validatePublicUrl(sourceUrl);
        const image = await fetchCaptureImage(env, sourceUrl, resolveCaptureHost);
        totalBytes += image.bytes.byteLength;
        if (totalBytes > ARTICLE_IMAGE_LIMIT) throw new CollectorError('RESOURCE_TOO_LARGE', '文章图片总大小超过允许范围');
        const contentType = assertImage(image.bytes, image.contentType);
        images.push({ source_url: sourceUrl, bytes: image.bytes, content_type: contentType });
      }
      const date = /(?:Z|[+-]\d\d:?\d\d)$/i.test(doc.date || '') ? Date.parse(doc.date) : NaN;
      const createdAt = secondsToMillis(doc.created_seconds);
      const canonical = doc.canonical ? validatePublicUrl(doc.canonical).href : verifiedSnapshot ? url.href : fetched.url;
      const parsedCanonical = new URL(canonical);
      const biz = parsedCanonical.searchParams.get('__biz');
      const mid = parsedCanonical.searchParams.get('mid');
      return {
        title: doc.title.trim(), author: doc.author || '', source_name: doc.source_name || '',
        published_at: createdAt || (Number.isFinite(date) ? date : null),
        html: doc.html, text: doc.text, images, original_url: canonical,
        ...(parsedCanonical.hostname === 'mp.weixin.qq.com' && biz && mid ? { source_key: `wechat:${biz}:${mid}:${parsedCanonical.searchParams.get('idx') || '1'}` } : {}),
      };
    } catch (error) { throw asCollectorError(error); }
  }
  async function createLoginSession(env, { url } = {}) {
    const store = new SessionStore(env, now);
    const lib = await api(env);
    const targetUrl = url ? officialArticleUrl(url) : null;
    const purpose = targetUrl ? 'article' : 'account';
    let login;
    for (let rebuild = 0; rebuild <= 1; rebuild++) {
      login = await store.beginLogin({ purpose, target_url: targetUrl });
      if (!login.existing) break;
      if (login.status === 'creating') return { session_id: login.id, status: 'creating', expires_at: login.expires_at, purpose };
      const existing = await getLoginSession(env, login.id);
      if (!['expired', 'stale'].includes(existing.status)) return { session_id: login.id, ...existing, purpose };
      // Only a confirmed expired/stale task is replaced. Network errors propagate unchanged.
      await store.mark(login.id, existing.status);
      if (rebuild === 1) throw new CollectorError('LOGIN_EXPIRED', '扫码入口再次失效，请稍后重新打开');
    }
    let browser;
    let phase = 'acquire';
    let routeStats;
    try {
      const acquired = await acquireBrowser(lib, env.ARCHIVE_BROWSER, { keep_alive: 60000, guardrails: { allowedDomains: LOGIN_DOMAINS } }, browserTiming(env));
      phase = 'connect';
      browser = await lib.connect(env.ARCHIVE_BROWSER, { sessionId: acquired.sessionId, persistent: true });
      let storageState;
      if (purpose === 'article') {
        try { storageState = (await store.load()).storageState; }
        catch (error) { if (!['LOGIN_REQUIRED', 'LOGIN_EXPIRED'].includes(error.code)) throw error; }
      }
      phase = 'new_context';
      // Incognito contexts are disposed when their creating CDP connection
      // detaches. Human login must live in the browser's persistent default context.
      const context = browser.contexts()[0];
      if (!context) throw new CollectorError('LOGIN_EXPIRED', '云端验证环境尚未准备好，请重新打开');
      await context.addInitScript(() => {
        if (navigator.serviceWorker) navigator.serviceWorker.register = async () => {};
      });
      phase = 'protect';
      routeStats = await protectOfficialContext(context);
      if (storageState) {
        phase = 'restore_state';
        await restoreLoginStorage(context, storageState);
      }
      phase = 'page';
      const page = await context.newPage();
      phase = 'goto';
      await page.goto(targetUrl || MP_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });
      phase = 'liveview';
      const cdp = await context.newCDPSession(page);
      // Manual detection uses a full Live View; no volatile handoff event is awaited.
      const result = await cdp.send('Cloudflare.getLiveView', { mode: 'full', expiresInMs: 600000 });
      phase = 'attach';
      await store.attachBrowser(login, acquired.sessionId, result.devtoolsFrontendUrl);
      return { session_id: login.id, live_view_url: result.devtoolsFrontendUrl, expires_at: login.expires_at, status: 'waiting', purpose };
    } catch (error) {
      await store.mark(login.id, 'failed').catch(() => {});
      await terminate(browser);
      const classified = asCollectorError(error);
      classified.phase = phase;
      const diagnostic = collectorDiagnostic(error);
      classified.diagnostic = routeStats ? collectorDiagnostic(`${diagnostic.slice(0, 100)}; routes=${JSON.stringify(routeStats)}`) : diagnostic;
      throw classified;
    } finally { await close(browser); }
  }
  async function withLogin(env, sessionId, callback) {
    const store = new SessionStore(env, now);
    const confirmation = value => ({ authenticated: true, version: value.version, status: 'authenticated', expires_at: value.expires_at, purpose: value.purpose });
    const completedWhilePolling = async () => {
      try {
        const latest = await store.get(sessionId);
        return latest.status === 'authenticated' ? confirmation(latest) : null;
      } catch (error) {
        if (['LOGIN_EXPIRED', 'LOGIN_STALE'].includes(error.code)) return null;
        throw error;
      }
    };
    const row = await store.get(sessionId);
    if (row.status === 'authenticated') return confirmation(row);
    if (row.status === 'creating') return { status: 'creating', expires_at: row.expires_at, purpose: row.purpose };
    const lib = await api(env);
    let browser;
    let selectedContext;
    let selectedPage;
    try {
      browser = await lib.connect(env.ARCHIVE_BROWSER, { sessionId: row.browser_session_id, persistent: true });
      const selected = browser.contexts().flatMap(context => context.pages().map(page => ({ context, page })))
        .filter(({ page }) => { try { return new URL(page.url()).origin === MP_ORIGIN; } catch { return false; } }).at(-1);
      if (!selected) throw new CollectorError('LOGIN_EXPIRED', '云端扫码浏览器已关闭，请重新创建入口');
      selectedContext = selected.context;
      selectedPage = selected.page;
    } catch (error) {
      await close(browser);
      const completed = await completedWhilePolling();
      if (completed) return completed;
      if (error.code === 'LOGIN_EXPIRED' || /(?:session|browser).*(?:not found|expired|closed)|code:\s*404/i.test(String(error.message))) {
        await store.mark(row.id, 'expired');
        const committed = await completedWhilePolling();
        if (committed) return committed;
        throw new CollectorError('LOGIN_EXPIRED', '云端扫码浏览器已关闭，请重新创建入口');
      }
      throw asCollectorError(error);
    }
    try {
      await protectOfficialContext(selectedContext);
      return await callback({ browser, context: selectedContext, page: selectedPage, row, store });
    } catch (error) {
      const completed = await completedWhilePolling();
      if (completed) return completed;
      throw asCollectorError(error);
    }
    finally { await close(browser); }
  }
  async function getLoginSession(env, sessionId) {
    try {
      return await withLogin(env, sessionId, async ({ context, page, row }) => {
        const cdp = await context.newCDPSession(page);
        const result = await cdp.send('Cloudflare.getLiveView', { mode: 'full', expiresInMs: Math.min(600000, row.expires_at - now()) });
        return { status: 'waiting', live_view_url: result.devtoolsFrontendUrl, expires_at: row.expires_at, purpose: row.purpose };
      });
    } catch (error) {
      if (['LOGIN_EXPIRED', 'LOGIN_STALE'].includes(error.code)) return { status: error.code === 'LOGIN_STALE' ? 'stale' : 'expired', expires_at: now() };
      throw error;
    }
  }
  async function finishLoginSession(env, sessionId) {
    return withLogin(env, sessionId, async ({ browser, context, page, row, store }) => {
      let httpAuth = null;
      let verifiedDocument;
      if (row.purpose === 'article') {
        await page.goto(officialArticleUrl(row.target_url), { waitUntil: 'domcontentloaded', timeout: 30000 });
        const doc = await page.evaluate(extractArticleDocument, { url: row.target_url, wechat: true });
        try { assertArticle(doc); }
        catch (error) { if (['CHALLENGE_REQUIRED', 'ARTICLE_INVALID'].includes(error.code)) return { authenticated: false, version: row.version, purpose: 'article' }; throw error; }
        verifiedDocument = doc;
        try { httpAuth = (await store.load()).httpAuth || null; }
        catch (error) { if (!['LOGIN_REQUIRED', 'LOGIN_EXPIRED'].includes(error.code)) throw error; }
      } else {
        try { await mpRequest(page, '/cgi-bin/searchbiz', { action: 'search_biz', begin: '0', count: '1', query: '微信' }); }
        catch (error) { if (['LOGIN_EXPIRED', 'CHALLENGE_REQUIRED'].includes(error.code)) return { authenticated: false, version: row.version, purpose: 'account' }; throw error; }
        httpAuth = { token: new URL(page.url()).searchParams.get('token') };
        const userAgent = await page.evaluate(() => navigator.userAgent);
        if (typeof userAgent === 'string') httpAuth.userAgent = userAgent;
      }
      const storageState = await context.storageState({ indexedDB: true });
      if (verifiedDocument) await saveArticleVerification(env, {
        url: row.target_url, version: row.version + 1, loginId: row.id, document: verifiedDocument,
      }, now());
      const version = await store.save(storageState, row.version, row.id, httpAuth);
      await terminate(browser);
      return { authenticated: true, version, purpose: row.purpose };
    });
  }
  async function getLoginScreenshot(env, sessionId) {
    const result = await withLogin(env, sessionId, async ({ page }) => {
      await page.bringToFront();
      return new Response(await page.screenshot({ type: 'png', timeout: 15000 }), {
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff' },
      });
    });
    if (result?.authenticated) {
      const error = new CollectorError('LOGIN_ALREADY_AUTHENTICATED', '微信验证已完成，无需再次获取二维码');
      error.status = 409;
      throw error;
    }
    if (!(result instanceof Response)) throw new CollectorError('LOGIN_STALE', '该扫码任务已结束或尚未准备好');
    return result;
  }
  async function getBrowserStatus(env) {
    const lib = await api(env);
    const limits = await lib.limits(env.ARCHIVE_BROWSER);
    const history = typeof lib.history === 'function' ? await lib.history(env.ARCHIVE_BROWSER) : [];
    const usage = summarizeBrowserUsage(history, now());
    // Operator diagnostics retain counts only; browser IDs and login data stay private.
    const number = value => Number.isFinite(value) && value >= 0 ? value : null;
    return {
      active_sessions: Array.isArray(limits.activeSessions) ? limits.activeSessions.length : null,
      max_concurrent_sessions: number(limits.maxConcurrentSessions),
      allowed_acquisitions: number(limits.allowedBrowserAcquisitions),
      next_acquisition_wait: number(limits.timeUntilNextAllowedBrowserAcquisition),
      recent_history_entries: usage.entries,
      recent_browser_seconds_today: Math.floor(usage.normalClosedSecondsToday),
    };
  }
  return { searchSources, listSourceArticles, captureArticle, createLoginSession, getLoginSession, finishLoginSession, getLoginScreenshot, getBrowserStatus };
}

const collector = createCollector();
export const searchSources = (...args) => collector.searchSources(...args);
export const getBrowserStatus = (...args) => collector.getBrowserStatus(...args);
export const listSourceArticles = (...args) => collector.listSourceArticles(...args);
export const captureArticle = (...args) => collector.captureArticle(...args);
export const createLoginSession = (...args) => collector.createLoginSession(...args);
export const getLoginSession = (...args) => collector.getLoginSession(...args);
export const finishLoginSession = (...args) => collector.finishLoginSession(...args);
export const getLoginScreenshot = (...args) => collector.getLoginScreenshot(...args);
