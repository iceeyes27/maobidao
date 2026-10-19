import { DomUtils, parseDocument } from 'htmlparser2';
import { parseArticleHtml } from './article-parser.js';
import { CollectorError, readLimited, resolvePublicHost, validatePublicUrl } from './collector-security.js';

export const WECHAT_READER_BIZ = 'MzE5ODk2NjUwOA==';
const ORIGIN = 'https://mp.weixin.qq.com';
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 100;
const RATE_WORDS = /访问过于频繁|操作过于频繁|频率限制|freq(?:uency)?\s*(?:limit|control)|too\s+(?:many|frequent)/i;
const LOGIN_WORDS = /请(?:先|重新)?登录|登录(?:已)?(?:失效|过期)|not\s*login|invalid\s*(?:session|key)|session\s*expired/i;
const VERIFY_WORDS = /当前环境异常|完成验证|安全验证|验证码|captcha|verify\s*(?:you|code)/i;

function fail(code, message, retryable = false) { throw new CollectorError(code, message, retryable); }
function invalid() { fail('READER_RESPONSE_INVALID', '微信阅读响应格式无效，未完成获取'); }
function officialUrl(value) {
  const url = validatePublicUrl(value);
  if (url.origin !== ORIGIN) fail('UNSAFE_URL', '微信阅读请求仅允许微信官方 HTTPS 地址');
  return url;
}

/** Return a canonical identity without authentication or tracking parameters. */
export function validateReaderArticleUrl(value) {
  const url = officialUrl(value);
  const params = url.searchParams;
  if (url.pathname !== '/s' || params.getAll('__biz').length !== 1 || params.get('__biz') !== WECHAT_READER_BIZ
      || params.getAll('mid').length !== 1 || !/^\d{1,32}$/.test(params.get('mid') || '')
      || params.getAll('idx').length > 1 || !/^[1-9]\d{0,2}$/.test(params.get('idx') || '1')
      || params.getAll('sn').length > 1 || params.has('sn') && !/^[a-f\d]{32}$/i.test(params.get('sn') || '')) {
    fail('READER_SOURCE_MISMATCH', '文章不属于指定公众号或缺少有效文章标识');
  }
  const mid = params.get('mid');
  const idx = params.get('idx') || '1';
  const sn = params.get('sn') || '';
  const canonical = new URL('/s', ORIGIN);
  for (const [key, value] of Object.entries({ __biz: WECHAT_READER_BIZ, mid, idx, ...(sn ? { sn } : {}) })) canonical.searchParams.set(key, value);
  return { url: canonical.href, source_key: `wechat:${WECHAT_READER_BIZ}:${mid}:${idx}`, account_biz: WECHAT_READER_BIZ, mid, idx, sn };
}

/** Reader credentials are a separate explicit type; backend login sessions are never reused. */
export function normalizeReaderCredentials(value, { now = Date.now() } = {}) {
  if (value == null) return null;
  const bad = () => fail('READER_LOGIN_REQUIRED', '微信阅读会话无效或已过期，请重新提供阅读授权');
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'wechat-reader') bad();
  if (value.account_biz != null && value.account_biz !== WECHAT_READER_BIZ || value.biz != null && value.biz !== WECHAT_READER_BIZ) bad();
  const string = (name, max, required = true) => {
    const input = value[name];
    if (input == null && !required) return undefined;
    if (typeof input !== 'string' || !input.trim() || input.length > max || /[^\x20-\x7e]/.test(input)) bad();
    return input;
  };
  const uin = string('uin', 48);
  if (!/^\d{1,32}$/.test(uin)) {
    let decoded = '';
    try { if (/^[A-Za-z\d+/]+={0,2}$/.test(uin)) decoded = atob(uin); } catch { /* Invalid base64 is an invalid reading identity. */ }
    if (!/^\d{1,32}$/.test(decoded)) bad();
  }
  const key = string('key', 4096);
  const pass_ticket = string('pass_ticket', 4096);
  const cookie = string('cookie', 8192, false);
  if (cookie && /(?:^|;)\s*slave_(?:sid|user|bizuin)\s*=/i.test(cookie)) bad();
  if (value.expires_at != null && (!Number.isSafeInteger(value.expires_at) || value.expires_at <= now)) bad();
  return { kind: 'wechat-reader', account_biz: WECHAT_READER_BIZ, uin, key, pass_ticket,
    ...(cookie ? { cookie } : {}), ...(value.appmsg_token ? { appmsg_token: string('appmsg_token', 4096) } : {}),
    ...(value.user_agent ? { user_agent: string('user_agent', 1024) } : {}),
    ...(value.expires_at != null ? { expires_at: value.expires_at } : {}) };
}

/** Fixed-host transport never follows redirects or exposes upstream authentication values. */
export async function readerFetch(value, {
  fetchImpl = fetch, resolveHost = resolvePublicHost, maxBytes = MAX_JSON_BYTES,
  accept = 'application/json', credentials = null, now = Date.now(),
} = {}) {
  const url = officialUrl(value);
  const session = normalizeReaderCredentials(credentials, { now });
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_HTML_BYTES) invalid();
  if (session) {
    if (url.pathname === '/s') validateReaderArticleUrl(url.href);
    else if (!['/mp/profile_ext', '/mp/appmsg_comment', '/mp/getappmsgext'].includes(url.pathname)) fail('UNSAFE_URL', '微信阅读授权不能用于此请求');
    for (const key of ['uin', 'key', 'pass_ticket', 'appmsg_token']) if (session[key]) url.searchParams.set(key, session[key]);
  }
  const headers = { accept, referer: `${ORIGIN}/`, 'user-agent': session?.user_agent || 'Mozilla/5.0' };
  if (session?.cookie) headers.cookie = session.cookie;
  let response;
  try {
    await resolveHost(url.hostname, fetchImpl);
    response = await fetchImpl(url.href, { redirect: 'manual', headers, signal: AbortSignal.timeout(25000) });
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    fail('UPSTREAM_ERROR', '微信阅读请求暂时失败，请稍后重试', true);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    fail('CHALLENGE_REQUIRED', '微信阅读请求需要在微信中完成安全验证');
  }
  if (response.status === 429) { await response.body?.cancel(); fail('RATE_LIMITED', '微信暂时限制阅读访问频率', true); }
  if (response.status === 401) { await response.body?.cancel(); fail('READER_LOGIN_REQUIRED', '微信阅读会话已失效，请重新提供阅读授权'); }
  if (response.status === 403) { await response.body?.cancel(); fail('CHALLENGE_REQUIRED', '微信阅读请求需要安全验证'); }
  if (!response.ok) { await response.body?.cancel(); fail('UPSTREAM_ERROR', '微信阅读服务暂时不可用', response.status >= 500); }
  let bytes;
  try { bytes = await readLimited(response, maxBytes); }
  catch (error) {
    if (error instanceof CollectorError) throw error;
    fail('UPSTREAM_ERROR', '微信阅读响应未完整返回，请稍后重试', true);
  }
  return { bytes, contentType: response.headers.get('content-type') || '', status: response.status };
}

function responseFailure(input, { authenticated = false } = {}) {
  const ret = input?.ret ?? input?.base_resp?.ret;
  const message = String(input?.errmsg || input?.err_msg || input?.base_resp?.err_msg || '').slice(0, 1000);
  if (ret != null && !/^-?\d{1,12}$/.test(String(ret))) invalid();
  if (Number(ret) === 200013 || RATE_WORDS.test(message)) fail('RATE_LIMITED', '微信暂时限制阅读访问频率', true);
  if (VERIFY_WORDS.test(message)) fail('CHALLENGE_REQUIRED', '微信阅读请求需要在微信中完成安全验证');
  if ([-3, -6, 200003].includes(Number(ret)) || LOGIN_WORDS.test(message)) fail('READER_LOGIN_REQUIRED', '微信阅读通道需要有效的微信阅读授权');
  if (ret != null && Number(ret) !== 0) {
    if (!authenticated) fail('READER_LOGIN_REQUIRED', '微信文章列表无法匿名读取，需要微信阅读授权');
    fail('UPSTREAM_ERROR', '微信阅读通道未能返回文章列表', true);
  }
  if (ret == null) invalid();
}

function jsonBody(text, { authenticated = false } = {}) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) invalid();
  let body;
  try { body = JSON.parse(text); } catch {
    if (RATE_WORDS.test(text.slice(0, 6000))) fail('RATE_LIMITED', '微信暂时限制阅读访问频率', true);
    if (VERIFY_WORDS.test(text.slice(0, 6000))) fail('CHALLENGE_REQUIRED', '微信阅读请求需要在微信中完成安全验证');
    if (!authenticated || LOGIN_WORDS.test(text.slice(0, 6000))) fail('READER_LOGIN_REQUIRED', '微信文章列表需要有效的微信阅读授权');
    invalid();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  responseFailure(body, { authenticated });
  return body;
}

function metadataCommentId(html) {
  const document = parseDocument(html);
  const scripts = DomUtils.findAll(node => node.name === 'script' && !Object.hasOwn(node.attribs, 'src'), document.children);
  const ids = new Set();
  // Scan executable positions only, skipping quoted strings and comments. No source script is evaluated.
  const assignment = /(?:(?:var|let|const)\s+comment_id\s*=\s*|window\.(?:segment_)?comment_id\s*=\s*|comment_id\s*:\s*(?:JsDecode\(\s*)?)(?:'(\d{1,32})'|"(\d{1,32})")(?:\s*\))?/y;
  const xmlAssignment = /d\.comment_id\s*=\s*xml\s*\?\s*getXmlValue\(\s*['"]comment_id\.DATA['"]\s*\)\s*:\s*['"](\d{1,32})['"]/y;
  for (const script of scripts) {
    const text = DomUtils.textContent(script);
    for (let index = 0; index < text.length;) {
      const character = text[index];
      if (character === '/' && text[index + 1] === '/') {
        const end = text.indexOf('\n', index + 2); index = end < 0 ? text.length : end + 1;
      } else if (character === '/' && text[index + 1] === '*') {
        const end = text.indexOf('*/', index + 2); index = end < 0 ? text.length : end + 2;
      } else if (character === '/' && regexLiteralStart(text, index)) {
        let characterClass = false;
        for (index++; index < text.length; index++) {
          if (text[index] === '\\') index++;
          else if (text[index] === '[') characterClass = true;
          else if (text[index] === ']') characterClass = false;
          else if (text[index] === '/' && !characterClass) { index++; break; }
        }
      } else if (character === '"' || character === "'" || character === '`') {
        const quote = character;
        for (index++; index < text.length; index++) {
          if (text[index] === '\\') index++;
          else if (text[index] === quote) { index++; break; }
        }
      } else {
        if (!/[\w$.]/.test(text[index - 1] || '')) {
          assignment.lastIndex = index;
          xmlAssignment.lastIndex = index;
          const match = assignment.exec(text) || xmlAssignment.exec(text);
          if (match) {
            const id = match[1] || match[2];
            if (!/^0+$/.test(id)) ids.add(id);
            index += match[0].length;
            continue;
          }
        }
        index++;
      }
    }
  }
  if (ids.size > 1) fail('READER_RESPONSE_INVALID', '文章存在不一致的公开留言标识');
  return [...ids][0] || null;
}

function regexLiteralStart(text, position) {
  let index = position - 1;
  while (index >= 0 && /\s/.test(text[index])) index--;
  if (index < 0 || /[=([{,:;!?&|+*%^~<>-]/.test(text[index])) return true;
  // Division follows a value; a regular expression can follow these expression keywords.
  let start = index;
  while (start >= 0 && /[\w$]/.test(text[start])) start--;
  return /^(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|new)$/.test(text.slice(start + 1, index + 1));
}

export function parseReaderArticle(html, { url, now = Date.now() } = {}) {
  const identity = validateReaderArticleUrl(url);
  const doc = parseArticleHtml(html, { url: identity.url, wechat: true });
  if (doc.removed) fail('ARTICLE_REMOVED', '原文已删除或当前无法查看');
  if (doc.invalid) {
    if (RATE_WORDS.test(html.slice(0, 6000))) fail('RATE_LIMITED', '微信暂时限制阅读访问频率', true);
    if (doc.challenge || VERIFY_WORDS.test(html.slice(0, 6000))) fail('CHALLENGE_REQUIRED', '微信文章需要完成安全验证后读取');
    if (LOGIN_WORDS.test(html.slice(0, 6000))) fail('READER_LOGIN_REQUIRED', '微信文章需要有效的微信阅读授权');
    fail('ARTICLE_INVALID', '微信文章未返回可读取的完整正文');
  }
  if (doc.canonical && validateReaderArticleUrl(doc.canonical).source_key !== identity.source_key) fail('READER_SOURCE_MISMATCH', '文章页面标识与请求文章不一致');
  const publishedAt = doc.created_seconds == null ? null : doc.created_seconds * 1000;
  const trusted = Number.isSafeInteger(publishedAt) && publishedAt >= Date.UTC(2000, 0, 1) && publishedAt <= now + 300000;
  return { article_identity: identity, comment_id: metadataCommentId(html), title: doc.title, author: doc.author,
    source_name: doc.source_name || '猫笔刀', published_at: trusted ? publishedAt : null, time_trusted: trusted,
    html: doc.html, text: doc.text, images: doc.images, body_readable: true, image_count: doc.images.length,
    text_length: doc.text.length, unsupported_background: doc.unsupported_background };
}

/** Parse the mobile reader list, preserving the original publication time and stable article identity. */
export function parseReaderList(text, { cursor = 0, count = 10, now = Date.now(), authenticated = false } = {}) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 100000 || !Number.isSafeInteger(count) || count < 1 || count > 20) fail('INVALID_REQUEST', '文章列表分页参数不正确');
  const body = jsonBody(text, { authenticated });
  let messageList = body.general_msg_list;
  try { if (typeof messageList === 'string') messageList = JSON.parse(messageList); } catch { invalid(); }
  if (!messageList || !Array.isArray(messageList.list) || messageList.list.length > MAX_ITEMS) invalid();
  const articles = [];
  const keys = new Set();
  let itemCount = 0;
  for (const message of messageList.list) {
    if (!message || typeof message !== 'object') invalid();
    const main = message.app_msg_ext_info;
    if (!main) continue; // Non-article messages are not collectible article entries.
    if (typeof main !== 'object' || Array.isArray(main)) invalid();
    const siblings = main.multi_app_msg_item_list || [];
    if (!Array.isArray(siblings) || siblings.length > MAX_ITEMS) invalid();
    for (const item of [main, ...siblings]) {
      if (++itemCount > MAX_ITEMS) invalid();
      if (!item || typeof item !== 'object' || typeof item.content_url !== 'string') invalid();
      const rawUrl = item.content_url.replace(/&amp;/g, '&');
      let parsed;
      try { parsed = new URL(rawUrl, ORIGIN); } catch { invalid(); }
      // Mobile lists sometimes use the http scheme for the same official resource.
      if (parsed.protocol === 'http:' && parsed.hostname === 'mp.weixin.qq.com' && !parsed.port && !parsed.username && !parsed.password) parsed.protocol = 'https:';
      const identity = validateReaderArticleUrl(parsed.href);
      const seconds = message.comm_msg_info?.datetime;
      const publishedAt = Number.isSafeInteger(seconds) ? seconds * 1000 : null;
      if (!Number.isSafeInteger(publishedAt) || publishedAt < Date.UTC(2000, 0, 1) || publishedAt > now + 300000) fail('READER_TIME_INVALID', '微信文章列表缺少可信原文发布时间');
      if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 1000) invalid();
      if (keys.has(identity.source_key)) continue;
      keys.add(identity.source_key);
      articles.push({ source_key: identity.source_key, url: identity.url, title: item.title.trim(),
        author: typeof item.author === 'string' ? item.author.slice(0, 500) : '猫笔刀', published_at: publishedAt,
        time_trusted: true, metadata: { source_kind: 'wechat-reader' } });
    }
  }
  const canContinue = body.can_msg_continue;
  if (![0, 1, '0', '1'].includes(canContinue)) invalid();
  const hasMore = Number(canContinue) === 1;
  const next = Number(body.next_offset ?? cursor + messageList.list.length);
  if (!Number.isSafeInteger(next) || next < 0 || hasMore && next <= cursor) invalid();
  return { articles, next_cursor: hasMore ? next : null, has_more: hasMore, fetched_at: now };
}

export function createWechatReader({ fetchImpl = fetch, resolveHost = resolvePublicHost, now = Date.now, credentialsLoader } = {}) {
  async function loadCredentials(env, source) {
    try { return normalizeReaderCredentials(await credentialsLoader?.(env, source), { now: now() }); }
    catch (error) {
      if (error instanceof CollectorError) throw error;
      fail('READER_LOGIN_REQUIRED', '微信阅读授权暂时不可用，请重新授权');
    }
  }
  async function probeArticle(env, url) {
    const identity = validateReaderArticleUrl(url);
    const read = async credentials => {
      const response = await readerFetch(identity.url, { fetchImpl, resolveHost, credentials, maxBytes: MAX_HTML_BYTES, accept: 'text/html,application/xhtml+xml', now: now() });
      return parseReaderArticle(new TextDecoder().decode(response.bytes), { url: identity.url, now: now() });
    };
    try { return await read(null); }
    catch (error) {
      if (!['READER_LOGIN_REQUIRED', 'CHALLENGE_REQUIRED'].includes(error?.code) || !credentialsLoader) throw error;
      const credentials = await loadCredentials(env, { account_biz: WECHAT_READER_BIZ });
      if (!credentials) throw error;
      return read(credentials);
    }
  }
  async function listSourceArticles(env, source, { cursor = 0, count = 10 } = {}) {
    if (!source || source.account_biz !== WECHAT_READER_BIZ) fail('READER_SOURCE_MISMATCH', '微信阅读通道仅支持指定公众号');
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 100000 || !Number.isSafeInteger(count) || count < 1 || count > 20) fail('INVALID_REQUEST', '文章列表分页参数不正确');
    const credentials = await loadCredentials(env, source);
    const url = new URL('/mp/profile_ext', ORIGIN);
    const query = { action: 'getmsg', __biz: WECHAT_READER_BIZ, offset: String(cursor), count: String(count), f: 'json', is_ok: '1', scene: '124' };
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await readerFetch(url.href, { fetchImpl, resolveHost, credentials, now: now() });
    return parseReaderList(new TextDecoder().decode(response.bytes), { cursor, count, now: now(), authenticated: Boolean(credentials) });
  }
  async function probeSource(env, options) {
    return listSourceArticles(env, { account_biz: WECHAT_READER_BIZ }, options);
  }
  return { probeArticle, probeSource, listSourceArticles };
}
