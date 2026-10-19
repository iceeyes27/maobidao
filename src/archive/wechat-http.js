import { SessionStore } from './collector-session.js';
import { CollectorError, readLimited, resolvePublicHost, validatePublicUrl } from './collector-security.js';
import { WechatThrottle } from './wechat-throttle.js';

const MP_ORIGIN = 'https://mp.weixin.qq.com';
const MP_HOST = 'mp.weixin.qq.com';
const BODY_LIMIT = 4 * 1024 * 1024;
const COOKIE_LIMIT = 16 * 1024;
const API_PATHS = new Set(['/cgi-bin/searchbiz', '/cgi-bin/appmsgpublish']);
const HOME_PATHS = new Set(['/', '/cgi-bin/home']);
const COOKIE_DOMAINS = new Set([MP_HOST, 'weixin.qq.com', 'qq.com']);
const TOKEN = /^\d{1,32}$/;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE_NAME = /^[!#$%&'*+.^_`|~\da-z-]+$/i;
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

const fail = (code, message, retryable = false) => { throw new CollectorError(code, message, retryable); };

function officialUrl(value, base = MP_ORIGIN) {
  const url = validatePublicUrl(value, base);
  if (url.origin !== MP_ORIGIN) fail('UNSAFE_URL', '微信登录请求发生不允许的跳转');
  return url;
}

function apiUrl(path, params, token) {
  const url = officialUrl(path);
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('INVALID_QUERY', '微信请求参数格式无效');
  const allowed = path === '/cgi-bin/searchbiz' ? ['action', 'begin', 'count', 'query']
    : ['sub', 'sub_action', 'begin', 'count', 'fakeid'];
  if (Object.keys(params).some(key => !allowed.includes(key))) fail('INVALID_QUERY', '微信请求包含不支持的参数');
  const begin = String(params.begin ?? 0);
  const count = String(params.count ?? (path === '/cgi-bin/searchbiz' ? 10 : 5));
  if (!/^\d+$/.test(begin) || !Number.isSafeInteger(Number(begin))
      || !/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 20) fail('INVALID_QUERY', '微信分页参数无效');
  const values = { begin, count, token, lang: 'zh_CN', f: 'json', ajax: '1' };
  if (path === '/cgi-bin/searchbiz') {
    if (typeof params.query !== 'string' || !params.query.trim() || params.query.length > 100) fail('INVALID_QUERY', '公众号搜索词须为 1 到 100 个字符');
    Object.assign(values, { action: 'search_biz', query: params.query });
  } else {
    if (typeof params.fakeid !== 'string' || !/^[\w=+/-]{1,256}$/.test(params.fakeid)) fail('INVALID_QUERY', '公众号标识无效');
    Object.assign(values, { sub: 'list', sub_action: 'list_ex', fakeid: params.fakeid });
  }
  url.search = new URLSearchParams(values).toString();
  return officialUrl(url.href);
}

function domain(cookie) { return typeof cookie.domain === 'string' ? cookie.domain.replace(/^\./, '').toLowerCase() : ''; }
function pathMatches(path, cookiePath) {
  return path === cookiePath || path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/');
}

function cookieHeader(cookies, url, timestamp) {
  const selected = cookies.filter(cookie => {
    if (!cookie || !COOKIE_DOMAINS.has(domain(cookie)) || !COOKIE_NAME.test(cookie.name || '')
        || typeof cookie.value !== 'string' || !COOKIE_VALUE.test(cookie.value)) return false;
    // Playwright preserves a leading dot for domain cookies. A parent-domain
    // host-only cookie must not gain access to this account subdomain.
    if (domain(cookie) !== MP_HOST && !cookie.domain.startsWith('.')) return false;
    if (cookie.expires !== undefined && cookie.expires !== -1
        && (!Number.isFinite(cookie.expires) || cookie.expires * 1000 <= timestamp)) return false;
    return typeof cookie.path === 'string' && cookie.path.startsWith('/') && pathMatches(url.pathname, cookie.path);
  }).sort((a, b) => b.path.length - a.path.length);
  const header = selected.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  if (header.length > COOKIE_LIMIT) fail('INVALID_STORAGE_STATE', '保存的微信登录信息超过允许大小，请重新登录');
  return header;
}

function updateCookies(cookies, response, url, timestamp) {
  const headers = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie()
    : typeof response.headers.getAll === 'function' ? response.headers.getAll('set-cookie') : [];
  for (const header of headers) {
    if (typeof header !== 'string' || header.length > 4096 || /[\r\n]/.test(header)) continue;
    const [pair, ...attributes] = header.split(';');
    const equals = pair.indexOf('=');
    if (equals < 1) continue;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) continue;
    const options = new Map(attributes.map(attribute => {
      const index = attribute.indexOf('=');
      return index < 0 ? [attribute.trim().toLowerCase(), '']
        : [attribute.slice(0, index).trim().toLowerCase(), attribute.slice(index + 1).trim()];
    }));
    const host = (options.get('domain') || MP_HOST).replace(/^\./, '').toLowerCase();
    if (!COOKIE_DOMAINS.has(host)) continue;
    const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf('/')) || '/';
    const path = options.get('path')?.startsWith('/') ? options.get('path') : defaultPath;
    if (/[\u0000-\u0020\u007f]/.test(path)) continue;
    const secure = options.has('secure');
    if (name.startsWith('__Secure-') && !secure || name.startsWith('__Host-') && (!secure || options.has('domain') || path !== '/')) continue;
    let expires = -1;
    if (options.has('max-age') && /^-?\d+$/.test(options.get('max-age'))) {
      const seconds = Number(options.get('max-age'));
      if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(timestamp + seconds * 1000)) continue;
      expires = Math.floor(timestamp / 1000) + seconds;
    } else if (options.has('expires')) {
      const date = Date.parse(options.get('expires'));
      if (Number.isFinite(date)) expires = date / 1000;
    }
    const index = cookies.findIndex(cookie => cookie?.name === name && domain(cookie) === host && cookie.path === path);
    if (index >= 0) cookies.splice(index, 1);
    if (expires !== -1 && expires * 1000 <= timestamp) continue;
    cookies.push({ name, value, domain: options.has('domain') ? `.${host}` : host, path, expires,
      httpOnly: options.has('httponly'), secure,
      sameSite: ['strict', 'lax', 'none'].includes(options.get('samesite')?.toLowerCase())
        ? options.get('samesite')[0].toUpperCase() + options.get('samesite').slice(1).toLowerCase() : 'Lax' });
  }
}

function sourceRateLimit(reason) {
  const error = new CollectorError('RATE_LIMITED', '微信暂时限制访问频率', true);
  error.status = 429;
  error.diagnostic = `wechat_http: ${reason}`;
  throw error;
}

function statusError(response) {
  if (response.status === 429) sourceRateLimit('http_429');
  if (response.status === 401) fail('LOGIN_EXPIRED', '公众号后台登录已失效，请重新扫码');
  if (response.status === 403) fail('CHALLENGE_REQUIRED', '微信要求安全验证，请通过管理员入口完成验证');
  if (!response.ok) fail('UPSTREAM_ERROR', `微信返回 HTTP ${response.status}`, response.status >= 500);
}

function tokenFromHtml(html) {
  return /(?:[?&]|&amp;)token=(\d{1,32})(?=[&#"'\s<>]|$)/i.exec(html)?.[1]
    || /(?:["']token["']|\btoken)\s*[:=]\s*["'](\d{1,32})["']/i.exec(html)?.[1] || null;
}

function isChallenge(text) { return /当前环境异常|完成验证|安全验证|验证码|captcha|wappoc_appmsgcaptcha/i.test(text); }

/** Only the official account host receives credentials; no browser is created. */
export function createWechatHttp({ fetchImpl = fetch, resolveHost = resolvePublicHost, now = Date.now,
  sessionStoreFactory = (env, clock) => new SessionStore(env, clock),
  throttleFactory = (env, clock) => new WechatThrottle(env.ARCHIVE_DB, clock) } = {}) {
  async function request(env, path, params) {
    let phase = 'validate';
    let throttle;
    try {
      if (!API_PATHS.has(path)) fail('INVALID_QUERY', '不支持此微信请求路径');
      // Validate caller parameters before reading private account state.
      apiUrl(path, params, '1');
      phase = 'load';
      const store = sessionStoreFactory(env, now);
      const saved = await store.load();
      const state = structuredClone(saved.storageState);
      if (!Array.isArray(state?.cookies)) fail('INVALID_STORAGE_STATE', '保存的微信登录状态格式无效，请重新登录');
      const userAgent = saved.httpAuth?.userAgent === undefined ? DEFAULT_USER_AGENT : saved.httpAuth.userAgent;
      if (typeof userAgent !== 'string' || !userAgent.trim() || userAgent.length > 512 || /[\u0000-\u001f\u007f]/.test(userAgent)) {
        fail('INVALID_STORAGE_STATE', '保存的微信客户端信息格式无效，请重新登录');
      }
      phase = 'throttle';
      throttle = throttleFactory(env, now);
      await throttle.reserve();
      const checkedHosts = new Set();
      async function send(url, accept) {
        officialUrl(url.href);
        if (!checkedHosts.has(url.hostname)) { await resolveHost(url.hostname, fetchImpl); checkedHosts.add(url.hostname); }
        const cookie = cookieHeader(state.cookies, url, now());
        if (!cookie) fail('LOGIN_EXPIRED', '保存的微信登录信息已失效，请重新扫码');
        const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual',
          headers: { accept, cookie, referer: `${MP_ORIGIN}/`, 'cache-control': 'no-cache', 'user-agent': userAgent },
          signal: AbortSignal.timeout(25_000) });
        updateCookies(state.cookies, response, url, now());
        return response;
      }
      async function restoreToken() {
        let url = officialUrl('/');
        for (let hop = 0; hop <= 5; hop++) {
          const response = await send(url, 'text/html,application/xhtml+xml');
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (!location || hop === 5) fail('LOGIN_EXPIRED', '微信登录跳转未完成，请重新扫码');
            const target = officialUrl(location, url.href);
            if (!HOME_PATHS.has(target.pathname)) fail('CHALLENGE_REQUIRED', '微信要求重新登录或安全验证，请通过管理员入口完成');
            const token = target.searchParams.get('token');
            if (TOKEN.test(token || '')) return token;
            url = target;
            continue;
          }
          if (!response.ok) { await response.body?.cancel(); statusError(response); }
          const bytes = await readLimited(response, BODY_LIMIT);
          const html = new TextDecoder().decode(bytes);
          const token = tokenFromHtml(html);
          if (token) return token;
          if (isChallenge(html)) fail('CHALLENGE_REQUIRED', '微信要求安全验证，请通过管理员入口完成验证');
          fail('LOGIN_EXPIRED', '无法恢复公众号后台登录，请重新扫码');
        }
      }
      phase = 'token';
      const token = typeof saved.httpAuth?.token === 'string' && TOKEN.test(saved.httpAuth.token) ? saved.httpAuth.token : await restoreToken();
      phase = 'source';
      const response = await send(apiUrl(path, params, token), 'application/json,text/plain');
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (location) officialUrl(location, MP_ORIGIN);
        fail('CHALLENGE_REQUIRED', '微信要求重新登录或安全验证，请通过管理员入口完成');
      }
      if (!response.ok) { await response.body?.cancel(); statusError(response); }
      const bytes = await readLimited(response, BODY_LIMIT);
      const text = new TextDecoder().decode(bytes);
      let body;
      try { body = JSON.parse(text); }
      catch { fail('CHALLENGE_REQUIRED', '微信未返回数据，请检查扫码登录或安全验证'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('SOURCE_FORMAT_CHANGED', '公众号数据格式已变化');
      const code = Number(body.base_resp?.ret);
      if ([200003, 200004, 200005].includes(code)) fail('LOGIN_EXPIRED', '公众号后台登录已失效，请重新扫码');
      if (code === 200013 || code === 45009) sourceRateLimit(`mp_ret_${code}`);
      if (code === -1) fail('UPSTREAM_ERROR', '微信服务暂时繁忙，请稍后重试', true);
      if (code !== 0) fail('SOURCE_FORMAT_CHANGED', `微信采集接口当前不可用（${Number.isFinite(code) ? code : '未知状态'}）`);
      phase = 'save';
      if (token !== saved.httpAuth?.token || JSON.stringify(state) !== JSON.stringify(saved.storageState)) {
        await store.save(state, saved.version, null, { token, userAgent });
      }
      Object.defineProperty(body, 'transport', { value: 'http', enumerable: false });
      return body;
    } catch (error) {
      let safe = error instanceof CollectorError ? error : new CollectorError('UPSTREAM_ERROR', '微信请求暂时失败，请稍后重试', true);
      if (throttle && /^wechat_http: (?:http_429|mp_ret_200013|mp_ret_45009)$/.test(safe.diagnostic || '')) {
        try { safe.retry_at = (await throttle.cooldown()).next_allowed_at; }
        catch (cooldownError) {
          phase = 'cooldown';
          safe = cooldownError instanceof CollectorError ? cooldownError
            : new CollectorError('UPSTREAM_ERROR', '微信请求等待记录暂时无法更新，请稍后重试', true);
        }
      }
      safe.transport = 'http';
      safe.phase = `http_${phase}`;
      // Preserve only this module's fixed upstream classifications, never raw
      // response text or arbitrary diagnostics from dependencies.
      if (!/^wechat_http: (?:http_429|mp_ret_200013|mp_ret_45009|local_cooldown)$/.test(safe.diagnostic || '')) {
        safe.diagnostic = `wechat_http: ${phase}; ${safe.code}`;
      }
      throw safe;
    }
  }
  return { request };
}
