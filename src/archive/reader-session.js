import { decryptSession, encryptSession, sessionCryptoKey } from './collector-session.js';
import { CollectorError } from './collector-security.js';
import { normalizeReaderCredentials, validateReaderArticleUrl, WECHAT_READER_BIZ } from './wechat-reader.js';

const SESSION_KEY = 'private/wechat-reader/session.json';
const SESSION_KIND = 'wechat-reader-session';
const MAX_BYTES = 32 * 1024;
const DEFAULT_TTL = 25 * 60 * 1000;
const MAX_TTL = 2 * 60 * 60 * 1000;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const encoder = new TextEncoder();

function invalid() {
  throw new CollectorError('READER_SESSION_INVALID', '保存的微信阅读授权无效，请重新提供阅读授权');
}

function loginRequired() {
  throw new CollectorError('READER_LOGIN_REQUIRED', '请先提供当前公众号文章的有效微信阅读授权');
}

function bucket(env) {
  if (!env.ARCHIVE_BUCKET) throw new CollectorError('CONFIG_MISSING', '微信阅读授权存储尚未配置');
  return env.ARCHIVE_BUCKET;
}

function time(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function inputCredentials(input, now) {
  try {
    if (typeof input === 'string') {
      validateReaderArticleUrl(input);
      const url = new URL(input);
      const result = { kind: 'wechat-reader', account_biz: WECHAT_READER_BIZ };
      for (const name of ['uin', 'key', 'pass_ticket', 'appmsg_token']) {
        if (url.searchParams.getAll(name).length > 1) loginRequired();
        const value = url.searchParams.get(name);
        if (value != null) result[name] = value;
      }
      input = result;
    }
    const credentials = normalizeReaderCredentials(input, { now });
    if (!credentials) loginRequired();
    return credentials;
  } catch {
    // Neither malformed URLs nor supplied authentication values may enter errors.
    loginRequired();
  }
}

function status(saved, now) {
  return saved ? { configured: true, expired: saved.expires_at <= now,
    expires_at: saved.expires_at, saved_at: saved.saved_at, revision: saved.revision }
    : { configured: false, expired: false, expires_at: null, saved_at: null, revision: null };
}

async function readSaved(env, now) {
  const object = await bucket(env).get(SESSION_KEY);
  if (!object) return null;
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_BYTES) invalid();
  const encrypted = await object.text();
  if (typeof encrypted !== 'string' || encoder.encode(encrypted).byteLength > MAX_BYTES) invalid();
  let saved;
  try {
    saved = await decryptSession(encrypted, await sessionCryptoKey(env));
  } catch (error) {
    if (error.code === 'CONFIG_MISSING' || error.code === 'CONFIG_INVALID' && !env.ARCHIVE_SESSION_KEY) throw error;
    invalid();
  }
  if (!saved || saved.kind !== SESSION_KIND || saved.account_biz !== WECHAT_READER_BIZ || !UUID.test(saved.revision || '')
      || !Number.isSafeInteger(saved.saved_at) || saved.saved_at < 0 || saved.saved_at > now
      || !Number.isSafeInteger(saved.expires_at) || saved.expires_at <= saved.saved_at
      || saved.expires_at - saved.saved_at > MAX_TTL || saved.credentials?.expires_at !== saved.expires_at) invalid();
  try {
    // Validate an expired session at its save time so status can report its expiry.
    saved.credentials = normalizeReaderCredentials(saved.credentials, { now: saved.saved_at });
    if (!saved.credentials) invalid();
  } catch { invalid(); }
  return saved;
}

/** This independent object never reads or replaces the publisher backend session. */
export async function saveReaderSession(env, input, { now = Date.now } = {}) {
  const savedAt = time(now);
  const credentials = inputCredentials(input, savedAt);
  const expiresAt = credentials.expires_at ?? savedAt + DEFAULT_TTL;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= savedAt || expiresAt - savedAt > MAX_TTL) loginRequired();
  const saved = { kind: SESSION_KIND, account_biz: WECHAT_READER_BIZ, revision: crypto.randomUUID(),
    saved_at: savedAt, expires_at: expiresAt, credentials: { ...credentials, expires_at: expiresAt } };
  if (encoder.encode(JSON.stringify(saved)).byteLength > MAX_BYTES) invalid();
  // All validation and encryption finish before the existing object is replaced.
  const encrypted = await encryptSession(saved, await sessionCryptoKey(env));
  if (encoder.encode(encrypted).byteLength > MAX_BYTES) invalid();
  await bucket(env).put(SESSION_KEY, encrypted, {
    httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' },
  });
  return status(saved, savedAt);
}

export async function loadReaderSession(env, { now = Date.now } = {}) {
  const current = time(now);
  const saved = await readSaved(env, current);
  if (!saved) loginRequired();
  if (saved.expires_at <= current) throw new CollectorError('READER_SESSION_EXPIRED', '微信阅读授权已过期，请重新提供阅读授权');
  return { ...saved.credentials };
}

export async function readerSessionStatus(env, { now = Date.now } = {}) {
  const current = time(now);
  return status(await readSaved(env, current), current);
}

export async function clearReaderSession(env) {
  await bucket(env).delete(SESSION_KEY);
  return status(null, 0);
}
