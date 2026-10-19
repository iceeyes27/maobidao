import { sha256 } from './core.js';
import { CollectorError, validatePublicUrl } from './collector-security.js';
import { decryptSession, encryptSession, sessionCryptoKey } from './collector-session.js';

const TTL = 24 * 60 * 60 * 1000;
const MAX_PLAINTEXT = 4 * 1024 * 1024;
// AES-GCM adds 16 bytes; the encrypted session envelope stores Base64 plus small JSON metadata.
const MAX_CIPHERTEXT = Math.ceil((MAX_PLAINTEXT + 16) / 3) * 4 + 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRINGS = ['html', 'text', 'title', 'author', 'source_name', 'date', 'canonical'];
const FLAGS = ['invalid', 'challenge', 'removed', 'unsupported_background'];
const encoder = new TextEncoder();

function invalid() {
  throw new CollectorError('ARTICLE_VERIFICATION_INVALID', '文章验证记录无效或已损坏，请重新完成官方验证');
}

function tooLarge() {
  throw new CollectorError('RESOURCE_TOO_LARGE', '文章验证内容超过允许大小，采集未完成');
}

function clock(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(value + TTL)) invalid();
  return value;
}

async function identity({ url, version, loginId } = {}) {
  const parsed = validatePublicUrl(url);
  if (parsed.hostname !== 'mp.weixin.qq.com' || !/^\/s(?:\/[\w-]+\/?)?$/.test(parsed.pathname)) {
    throw new CollectorError('INVALID_URL', '文章验证仅支持微信官方文章链接');
  }
  if (!Number.isSafeInteger(version) || version < 1 || typeof loginId !== 'string' || !UUID.test(loginId)) invalid();
  const id = loginId.toLowerCase();
  return { url: parsed.href, version, loginId: id,
    key: `private/wechat-articles/${version}/${id}/${await sha256(parsed.href)}.json` };
}

function documentValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || STRINGS.some(key => typeof value[key] !== 'string')
      || FLAGS.some(key => value[key] !== false)
      || !value.html.trim() || !value.title.trim()
      || !Array.isArray(value.images) || value.images.length > 100
      || value.images.some(image => typeof image !== 'string' || !image.trim() || image.length > 8192)
      || !value.text.trim() && !value.images.length
      || value.created_seconds !== null && (!Number.isSafeInteger(value.created_seconds) || value.created_seconds < 0)) invalid();
  // Copy only the extraction contract. Browser storage, arbitrary source fields
  // and caller-owned objects must not become part of a reusable verification.
  return {
    ...Object.fromEntries(FLAGS.map(key => [key, false])),
    ...Object.fromEntries(STRINGS.map(key => [key, value[key]])),
    images: [...value.images], created_seconds: value.created_seconds,
  };
}

function boundedJson(value) {
  const serialized = JSON.stringify(value);
  if (encoder.encode(serialized).byteLength > MAX_PLAINTEXT) tooLarge();
  return serialized;
}

function bucket(env) {
  if (!env.ARCHIVE_BUCKET) throw new CollectorError('CONFIG_MISSING', '请配置文章存储后再完成验证');
  return env.ARCHIVE_BUCKET;
}

/** Stage before the caller commits this human-verified login generation by CAS. */
export async function saveArticleVerification(env, input, nowMs = Date.now()) {
  const timestamp = clock(nowMs);
  const expected = await identity(input);
  const snapshot = { kind: 'wechat-article-verification', format: 1, url: expected.url,
    version: expected.version, loginId: expected.loginId, created_at: timestamp, expires_at: timestamp + TTL,
    document: documentValue(input.document) };
  boundedJson(snapshot);
  const encrypted = await encryptSession(snapshot, await sessionCryptoKey(env));
  try {
    await bucket(env).put(expected.key, encrypted, {
      httpMetadata: { contentType: 'application/json', cacheControl: 'no-store, private' },
    });
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    throw new CollectorError('STORAGE_WRITE_FAILED', '文章验证内容保存失败，请稍后重试', true);
  }
  return { expires_at: snapshot.expires_at };
}

/** The caller supplies only the version/login ID obtained from its current SessionStore.load(). */
export async function loadArticleVerification(env, input, nowMs = Date.now()) {
  const timestamp = clock(nowMs);
  const expected = await identity(input);
  const object = await bucket(env).get(expected.key);
  if (!object) return null;
  // Trust neither a forged size field nor an oversized encrypted envelope. R2
  // reports size before text() allocates the body; check the actual text again.
  if (!Number.isSafeInteger(object.size) || object.size < 1) invalid();
  if (object.size > MAX_CIPHERTEXT) tooLarge();
  if (typeof object.text !== 'function') invalid();
  const encrypted = await object.text();
  if (typeof encrypted !== 'string') invalid();
  if (encoder.encode(encrypted).byteLength > MAX_CIPHERTEXT) tooLarge();
  const key = await sessionCryptoKey(env);
  let snapshot;
  try { snapshot = await decryptSession(encrypted, key); }
  catch { invalid(); }
  if (!snapshot || snapshot.kind !== 'wechat-article-verification' || snapshot.format !== 1
      || snapshot.url !== expected.url || snapshot.version !== expected.version || snapshot.loginId !== expected.loginId
      || !Number.isSafeInteger(snapshot.created_at) || snapshot.created_at <= 0 || snapshot.created_at > timestamp
      || !Number.isSafeInteger(snapshot.expires_at) || snapshot.expires_at !== snapshot.created_at + TTL) invalid();
  if (snapshot.expires_at <= timestamp) return null;
  boundedJson(snapshot);
  return documentValue(snapshot.document);
}
