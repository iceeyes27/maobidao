import { isIP } from 'node:net';

export class CollectorError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.name = 'CollectorError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Private server diagnostics never contain navigation URLs or authentication values. */
export function collectorDiagnostic(error) {
  return String(error?.message || error || '')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\?[^\s"'<>]*/g, '[query]')
    .replace(/\b(?:token|jwt|authorization|set-cookie|cookies?|session[_-]?id)\b["']?\s*[:=][^\r\n]*/gi, '[private]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [private]')
    .replace(/[A-Za-z0-9_+\/=\-]{24,}(?:\.[A-Za-z0-9_+\/=\-]+)*/g, '[private]')
    .slice(0, 400);
}

/** SDK 1.3.x wraps browser HTTP errors in a normal Error with status in its message. */
export function classifyCollectorError(error, now = Date.now()) {
  if (error instanceof CollectorError) return error;
  const message = `${error?.message || error || ''} ${error?.cause?.message || ''}`;
  if (/browser\s+time\s+limit\s+exceeded(?:\s+for\s+today)?/i.test(message)) {
    const quota = new CollectorError('BROWSER_QUOTA_EXCEEDED', '云端浏览器今日可用时长已用完，任务将等待下一 UTC 日继续');
    quota.quota = 'browser_time';
    quota.retry_at = (Math.floor(now / 86400000) + 1) * 86400000;
    return quota;
  }
  if (Number(error?.status) === 429 || /\b(?:code|status)\s*:?\s*429\b|too many (?:requests|concurrent|browser)/i.test(message)) {
    return new CollectorError('RATE_LIMITED', '云端浏览器暂时限制请求频率，请稍后重试', true);
  }
  return new CollectorError('UPSTREAM_ERROR', '云端采集暂时失败，请稍后重试', true);
}

const fail = (code, message, retryable = false) => { throw new CollectorError(code, message, retryable); };
const PRIVATE_V4 = [
  [0, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24],
  [0xc0000200, 24], [0xc0586300, 24], [0xc0a80000, 16],
  [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 3],
];

export function isPublicAddress(address) {
  const value = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(value) === 4) {
    const ip = value.split('.').reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
    return !PRIVATE_V4.some(([base, bits]) => (ip >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (isIP(value) !== 6) return false;
  // Accept only ordinary global unicast; deny mapped IPv4, 6to4 and Teredo.
  if (!/^[23][0-9a-f]{3}:/.test(value) || /^(?:2002|3fff):/.test(value)) return false;
  const second = Number.parseInt(value.split(':')[1] || '0', 16);
  return !(value.startsWith('2001:') && (second < 0x200 || second === 0xdb8));
}

export function validatePublicUrl(value, base) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) {
    fail('INVALID_URL', '文章或图片地址格式不正确');
  }
  let url;
  try { url = new URL(value, base); } catch { fail('INVALID_URL', '文章或图片地址格式不正确'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    fail('UNSAFE_URL', '仅支持标准 HTTP 或 HTTPS 公开地址');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (isIP(host)) {
    if (!isPublicAddress(host)) fail('UNSAFE_URL', '不允许访问内网或保留地址');
  } else if (!host.includes('.') || /(?:^|\.)(?:localhost|local|internal|lan|home|onion|invalid|test)$/.test(host)) {
    fail('UNSAFE_URL', '不允许访问本机或内网名称');
  }
  url.hostname = isIP(host) === 6 ? `[${host}]` : host;
  url.hash = '';
  return url;
}

export async function resolvePublicHost(hostname, fetchImpl = fetch) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) fail('UNSAFE_URL', '不允许访问内网地址');
    return;
  }
  const replies = await Promise.all(['A', 'AAAA'].map(async type => {
    const response = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' }, redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
    // Workers supports follow/manual only. Never follow a resolver redirect.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      fail('UPSTREAM_ERROR', '公开域名解析发生不允许的跳转', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail('UPSTREAM_ERROR', '公开域名解析暂时失败', true);
    }
    const answer = await response.json();
    if (answer.Status !== 0 && answer.Status !== 3) fail('UPSTREAM_ERROR', '公开域名解析暂时失败', true);
    return (answer.Answer || []).filter(row => row.type === 1 || row.type === 28).map(row => row.data);
  }));
  const addresses = replies.flat();
  if (!addresses.length) fail('UPSTREAM_ERROR', '目标域名没有可用的公开地址', true);
  if (addresses.some(ip => !isPublicAddress(ip))) fail('UNSAFE_URL', '目标域名解析到了内网或保留地址');
}

export async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel(); fail('RESOURCE_TOO_LARGE', '文章或图片超过允许大小'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) fail('RESOURCE_TOO_LARGE', '文章或图片超过允许大小');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function safeFetch(value, {
  fetchImpl = fetch, resolveHost = resolvePublicHost, maxBytes = 4 * 1024 * 1024,
  accept = 'text/html,application/xhtml+xml', maxRedirects = 5,
} = {}) {
  let url = validatePublicUrl(value);
  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    await resolveHost(url.hostname, fetchImpl);
    let response;
    try {
      response = await fetchImpl(url.href, {
        redirect: 'manual', headers: { accept }, signal: AbortSignal.timeout(25000),
      });
    } catch (error) {
      if (error instanceof CollectorError) throw error;
      fail('UPSTREAM_ERROR', '文章或图片请求失败，请稍后重试', true);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirect === maxRedirects) fail('INVALID_URL', '地址重定向过多或目标无效');
      url = validatePublicUrl(location, url.href);
      continue;
    }
    if (response.status === 429) { await response.body?.cancel(); fail('RATE_LIMITED', '来源暂时限制访问频率', true); }
    if (!response.ok) {
      await response.body?.cancel();
      fail('UPSTREAM_ERROR', `来源返回 HTTP ${response.status}`, response.status >= 500);
    }
    const bytes = await readLimited(response, maxBytes);
    return { url: url.href, bytes, contentType: response.headers.get('content-type') || '' };
  }
}

export function assertImage(bytes, type) {
  const mime = type.split(';')[0].trim().toLowerCase();
  const b = bytes;
  const signature = {
    'image/jpeg': b[0] === 255 && b[1] === 216 && b[2] === 255,
    'image/png': b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71,
    'image/gif': new TextDecoder().decode(b.slice(0, 6)).match(/^GIF8[79]a$/),
    'image/webp': new TextDecoder().decode(b.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(b.slice(8, 12)) === 'WEBP',
    'image/avif': b.length > 16 && new TextDecoder().decode(b.slice(4, 8)) === 'ftyp' && /avif|avis/.test(new TextDecoder().decode(b.slice(8, 32))),
  };
  if (!signature[mime] || bytes.length < 12) fail('IMAGE_INCOMPLETE', '文章包含无法完整读取或不支持的图片');
  return mime;
}
