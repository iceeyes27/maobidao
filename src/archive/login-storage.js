import { CollectorError, validatePublicUrl } from './collector-security.js';
import { restoreOriginStorage } from './vendor/playwright-storage-1.3.6.js';

const OFFICIAL_HOSTS = ['mp.weixin.qq.com', 'res.wx.qq.com', 'res2.wx.qq.com', 'open.weixin.qq.com',
  'wx2.qq.com', 't.captcha.qq.com', 'ssl.captcha.qq.com', 'captcha.qcloud.com', 'turing.captcha.qcloud.com'];
const OFFICIAL_SUFFIXES = ['qpic.cn', 'qlogo.cn', 'gtimg.com'];

function invalidState() {
  return new CollectorError('INVALID_STORAGE_STATE', '保存的微信登录状态格式或来源无效，请重新登录');
}

function allowedOfficialOrigin(origin) {
  const host = new URL(origin).hostname;
  return OFFICIAL_HOSTS.includes(host) || OFFICIAL_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`));
}

function allowedOfficialCookie(host) {
  return OFFICIAL_HOSTS.some((official) => official === host || official.endsWith(`.${host}`))
    || OFFICIAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function storageOrigin(value) {
  if (typeof value !== 'string') throw invalidState();
  const parsed = validatePublicUrl(value);
  if (parsed.protocol !== 'https:' || ![parsed.origin, `${parsed.origin}/`].includes(value)) throw invalidState();
  return parsed.origin;
}

/** Restore into a fresh persistent default context before its first real navigation. */
export async function restoreLoginStorage(context, storageState, { isAllowedOrigin = allowedOfficialOrigin } = {}) {
  if (!storageState || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)
      || typeof isAllowedOrigin !== 'function') throw invalidState();
  const origins = [];
  const seen = new Set();
  // Validate everything before changing cookies or creating pages. No origin is fetched.
  for (const state of storageState.origins) {
    const origin = storageOrigin(state?.origin);
    if (seen.has(origin) || !await isAllowedOrigin(origin) || !Array.isArray(state.localStorage)
        || state.indexedDB !== undefined && !Array.isArray(state.indexedDB)
        || state.localStorage.some((entry) => typeof entry?.name !== 'string' || typeof entry?.value !== 'string')) throw invalidState();
    seen.add(origin);
    origins.push({ ...state, origin });
  }
  for (const cookie of storageState.cookies) {
    if (typeof cookie?.domain !== 'string' || typeof cookie.name !== 'string' || typeof cookie.value !== 'string') throw invalidState();
    const host = cookie.domain.replace(/^\./, '');
    const origin = storageOrigin(`https://${host}`);
    const allowed = isAllowedOrigin === allowedOfficialOrigin ? allowedOfficialCookie(host) : await isAllowedOrigin(origin);
    if (!allowed) throw invalidState();
  }
  await context.clearCookies();
  if (storageState.cookies.length) await context.addCookies(storageState.cookies);
  if (!origins.length) return;

  let page;
  let targetOrigin;
  const route = async (requestRoute) => {
    const request = requestRoute.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame() && request.url() === `${targetOrigin}/`) {
      return requestRoute.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html></html>' });
    }
    return requestRoute.abort();
  };
  try {
    page = await context.newPage();
    await page.route('**/*', route);
    for (const state of origins) {
      targetOrigin = state.origin;
      await page.goto(`${targetOrigin}/`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
      await page.evaluate(restoreOriginStorage, state);
    }
  } finally {
    try { if (page) await page.unroute('**/*', route); }
    finally { if (page) await page.close(); }
  }
}
