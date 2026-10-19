import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saveArticleVerification, loadArticleVerification } from '../src/archive/article-verification.js';
import { decryptSession, encryptSession, sessionCryptoKey } from '../src/archive/collector-session.js';
import { sha256 } from '../src/archive/core.js';

const NOW = Date.parse('2026-10-20T00:00:00Z');
const DAY = 86_400_000;
const URL = 'https://mp.weixin.qq.com/s/article-one';
const LOGIN = '11111111-2222-4333-8444-555555555555';
const identity = { url: URL, version: 3, loginId: LOGIN };
const doc = () => ({ invalid: false, challenge: false, removed: false, unsupported_background: false,
  html: '<p>已验证的正文</p><img src="https://mmbiz.qpic.cn/image.png">', text: '已验证的正文',
  images: ['https://mmbiz.qpic.cn/image.png'], title: '真实标题', author: '真实作者', source_name: '真实来源',
  date: '', canonical: 'https://mp.weixin.qq.com/s?__biz=ABC&mid=42&idx=1', created_seconds: 1792454400 });
const code = expected => error => error.name === 'CollectorError' && error.code === expected;

class Bucket {
  values = new Map();
  reads = 0;
  async put(key, value, options) { this.values.set(key, { value, options }); }
  async get(key) {
    const value = this.values.get(key);
    return !value ? null : { size: new TextEncoder().encode(value.value).byteLength, text: async () => { this.reads++; return value.value; } };
  }
}
function environment() { return { ARCHIVE_BUCKET: new Bucket(), ARCHIVE_SESSION_KEY: btoa('v'.repeat(32)) }; }
async function keyFor(input = identity) { return `private/wechat-articles/${input.version}/${input.loginId.toLowerCase()}/${await sha256(input.url)}.json`; }
async function tamper(env, mutate) {
  const entry = env.ARCHIVE_BUCKET.values.get(await keyFor());
  const key = await sessionCryptoKey(env);
  const snapshot = await decryptSession(entry.value, key);
  mutate(snapshot);
  entry.value = await encryptSession(snapshot, key);
}

test('a verified article is encrypted in a private URL/version/login namespace and round trips exactly', async () => {
  const env = environment();
  const value = doc();
  value.storageState = { cookies: [{ value: 'must-not-store' }] };
  assert.deepEqual(await saveArticleVerification(env, { ...identity, document: value }, NOW), { expires_at: NOW + DAY });
  const [key, entry] = [...env.ARCHIVE_BUCKET.values][0];
  assert.equal(key, await keyFor());
  assert.ok(!entry.value.includes('已验证的正文'));
  assert.ok(!entry.value.includes(URL));
  assert.ok(!entry.value.includes('must-not-store'));
  assert.equal(entry.options.httpMetadata.cacheControl, 'no-store, private');
  const loaded = await loadArticleVerification(env, identity, NOW + 1);
  assert.deepEqual(loaded, doc());
  assert.notEqual(loaded.images, value.images);
});

test('each save uses a fresh encryption IV and does not expose article text or metadata', async () => {
  const env = environment();
  await saveArticleVerification(env, { ...identity, document: doc() }, NOW);
  const before = env.ARCHIVE_BUCKET.values.get(await keyFor()).value;
  await saveArticleVerification(env, { ...identity, document: doc() }, NOW);
  assert.notEqual(env.ARCHIVE_BUCKET.values.get(await keyFor()).value, before);
});

test('an absent, expired or different generation, login ID and URL snapshot cannot be reused', async () => {
  const env = environment();
  assert.equal(await loadArticleVerification(env, identity, NOW), null);
  await saveArticleVerification(env, { ...identity, document: doc() }, NOW);
  assert.deepEqual(await loadArticleVerification(env, identity, NOW + DAY - 1), doc());
  assert.equal(await loadArticleVerification(env, identity, NOW + DAY), null);
  assert.equal(await loadArticleVerification(env, { ...identity, version: 4 }, NOW + 1), null);
  assert.equal(await loadArticleVerification(env, { ...identity, loginId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, NOW + 1), null);
  assert.equal(await loadArticleVerification(env, { ...identity, url: `${URL}?different=1` }, NOW + 1), null);
});

test('URL fragments and UUID case normalize consistently without changing exact query parameters', async () => {
  const env = environment();
  const original = { url: `${URL}?a=1&b=2#section`, version: 1, loginId: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE' };
  await saveArticleVerification(env, { ...original, document: doc() }, NOW);
  assert.deepEqual(await loadArticleVerification(env, { ...original, url: `${URL}?a=1&b=2`, loginId: original.loginId.toLowerCase() }, NOW + 1), doc());
  assert.equal(await loadArticleVerification(env, { ...original, url: `${URL}?b=2&a=1` }, NOW + 1), null);
});

test('non-official paths, credentials, ports, malformed identities and clocks are rejected before storage', async () => {
  const env = environment();
  for (const url of ['https://evil.example/s/a', 'https://mp.weixin.qq.com.evil.example/s/a', 'https://mp.weixin.qq.com/cgi-bin/home', 'https://mp.weixin.qq.com/s/a/b', 'https://u:p@mp.weixin.qq.com/s/a', 'https://mp.weixin.qq.com:444/s/a', 'file:///s/a']) {
    await assert.rejects(saveArticleVerification(env, { ...identity, url, document: doc() }, NOW), error => ['INVALID_URL', 'UNSAFE_URL'].includes(error.code), url);
  }
  for (const version of [0, -1, 1.5, '3', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(saveArticleVerification(env, { ...identity, version, document: doc() }, NOW), code('ARTICLE_VERIFICATION_INVALID'));
  }
  for (const loginId of [null, '../other', 'abc', 'x'.repeat(36)]) {
    await assert.rejects(loadArticleVerification(env, { ...identity, loginId }, NOW), code('ARTICLE_VERIFICATION_INVALID'));
  }
  for (const timestamp of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(loadArticleVerification(env, identity, timestamp), code('ARTICLE_VERIFICATION_INVALID'));
  }
  assert.equal(env.ARCHIVE_BUCKET.values.size, 0);
});

test('only a complete, unchallenged extracted document can be staged', async () => {
  const env = environment();
  for (const patch of [{ invalid: true }, { challenge: true }, { removed: true }, { unsupported_background: true },
    { title: '' }, { html: '' }, { text: '', images: [] }, { images: [''] }, { images: [null] },
    { images: Array(101).fill('https://mmbiz.qpic.cn/a.png') }, { author: null }, { created_seconds: '123' }]) {
    await assert.rejects(saveArticleVerification(env, { ...identity, document: { ...doc(), ...patch } }, NOW), code('ARTICLE_VERIFICATION_INVALID'));
  }
  assert.equal(env.ARCHIVE_BUCKET.values.size, 0);
});

test('UTF8 size includes multibyte article text and encrypted reads allow Base64 expansion', async () => {
  const env = environment();
  const almost = { ...doc(), html: `<p>${'文'.repeat(1_100_000)}</p>` };
  await saveArticleVerification(env, { ...identity, document: almost }, NOW);
  assert.ok(new TextEncoder().encode(env.ARCHIVE_BUCKET.values.get(await keyFor()).value).byteLength > 4 * 1024 * 1024);
  assert.deepEqual(await loadArticleVerification(env, identity, NOW + 1), almost);
  const large = { ...doc(), html: '文'.repeat(1_400_000) };
  await assert.rejects(saveArticleVerification(env, { ...identity, document: large }, NOW), code('RESOURCE_TOO_LARGE'));
});

test('oversized or malformed R2 size metadata is rejected before text allocation', async () => {
  const env = environment();
  let reads = 0;
  for (const size of [10 * 1024 * 1024, -1, NaN, undefined]) {
    env.ARCHIVE_BUCKET.get = async () => ({ size, text: async () => { reads++; throw new Error('must not read'); } });
    await assert.rejects(loadArticleVerification(env, identity, NOW), error => ['RESOURCE_TOO_LARGE', 'ARTICLE_VERIFICATION_INVALID'].includes(error.code));
  }
  assert.equal(reads, 0);
});

test('a lying encrypted body size is checked again before decryption', async () => {
  const env = environment();
  env.ARCHIVE_BUCKET.get = async () => ({ size: 10, text: async () => 'x'.repeat(6 * 1024 * 1024) });
  await assert.rejects(loadArticleVerification(env, identity, NOW), code('RESOURCE_TOO_LARGE'));
});

test('authentication failures and unparseable encrypted envelopes fail explicitly', async () => {
  for (const corruption of ['not-json', '{"format":1,"iv":"bad","ciphertext":"bad"}']) {
    const env = environment();
    await saveArticleVerification(env, { ...identity, document: doc() }, NOW);
    env.ARCHIVE_BUCKET.values.get(await keyFor()).value = corruption;
    await assert.rejects(loadArticleVerification(env, identity, NOW + 1), code('ARTICLE_VERIFICATION_INVALID'));
  }
});

test('decrypted kind, URL, version, login identity, TTL and future timestamps must match', async () => {
  for (const mutate of [snapshot => { snapshot.kind = 'wechat-session'; }, snapshot => { snapshot.format = 2; },
    snapshot => { snapshot.url = `${URL}?other=1`; }, snapshot => { snapshot.version++; },
    snapshot => { snapshot.loginId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; },
    snapshot => { snapshot.expires_at++; }, snapshot => { snapshot.created_at += 100; snapshot.expires_at += 100; },
    snapshot => { snapshot.document.challenge = true; }]) {
    const env = environment();
    await saveArticleVerification(env, { ...identity, document: doc() }, NOW);
    await tamper(env, mutate);
    await assert.rejects(loadArticleVerification(env, identity, NOW + 1), code('ARTICLE_VERIFICATION_INVALID'));
  }
});

test('storage failures do not report a successful verification snapshot', async () => {
  const env = environment();
  env.ARCHIVE_BUCKET.put = async () => { throw new Error('private upstream detail'); };
  await assert.rejects(saveArticleVerification(env, { ...identity, document: doc() }, NOW), error => {
    assert.equal(error.code, 'STORAGE_WRITE_FAILED');
    assert.equal(error.retryable, true);
    assert.ok(!error.message.includes('private upstream detail'));
    return true;
  });
});
