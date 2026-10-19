import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptSession, encryptSession, sessionCryptoKey } from '../src/archive/collector-session.js';
import { clearReaderSession, loadReaderSession, readerSessionStatus, saveReaderSession } from '../src/archive/reader-session.js';
import { WECHAT_READER_BIZ } from '../src/archive/wechat-reader.js';

const NOW = Date.parse('2026-10-19T14:00:00Z');
const KEY = 'private/wechat-reader/session.json';
const BACKEND_KEY = 'private/wechat-state/1-synthetic.json';
const TTL = 25 * 60 * 1000;
const credentials = (patch = {}) => ({ kind: 'wechat-reader', account_biz: WECHAT_READER_BIZ,
  uin: '12345678', key: 'synthetic-reader-key', pass_ticket: 'synthetic-pass-ticket', ...patch });
const article = () => {
  const url = new URL('https://mp.weixin.qq.com/s');
  for (const [name, value] of Object.entries({ __biz: WECHAT_READER_BIZ, mid: '2247498657', idx: '1',
    sn: '5cdfb9d08d7f6844b121f8618cd9dba3', uin: '12345678', key: 'synthetic-reader-key', pass_ticket: 'synthetic-pass-ticket' })) url.searchParams.set(name, value);
  return url.href;
};

function fixture() {
  const objects = new Map([[BACKEND_KEY, 'unchanged backend state']]);
  const gets = [];
  const puts = [];
  const deletes = [];
  const env = { ARCHIVE_SESSION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    ARCHIVE_BUCKET: {
      async get(key) {
        gets.push(key);
        const body = objects.get(key);
        return body == null ? null : { size: new TextEncoder().encode(body).byteLength, text: async () => body };
      },
      async put(key, body, metadata) { puts.push({ key, metadata }); objects.set(key, body); },
      async delete(key) { deletes.push(key); objects.delete(key); },
    } };
  Object.defineProperty(env, 'ARCHIVE_DB', { get() { assert.fail('Reader sessions must never access the publisher database'); } });
  return { env, objects, gets, puts, deletes };
}

const code = expected => error => error.code === expected;
async function stored(f) { return decryptSession(f.objects.get(KEY), await sessionCryptoKey(f.env)); }
async function replace(f, payload) { f.objects.set(KEY, await encryptSession(payload, await sessionCryptoKey(f.env))); }

test('independent reader credentials are encrypted and status contains no credentials', async () => {
  const f = fixture();
  const result = await saveReaderSession(f.env, credentials({ cookie: 'reader_cookie=synthetic', appmsg_token: 'synthetic-appmsg-token' }), { now: () => NOW });
  assert.deepEqual(result, { configured: true, expired: false, saved_at: NOW, expires_at: NOW + TTL, revision: result.revision });
  assert.match(result.revision, /^[a-f\d-]{36}$/);
  assert.deepEqual(await readerSessionStatus(f.env, { now: NOW + 1 }), result);
  const encrypted = f.objects.get(KEY);
  for (const privateValue of ['12345678', 'synthetic-reader-key', 'synthetic-pass-ticket', 'reader_cookie', 'synthetic-appmsg-token']) {
    assert.ok(!encrypted.includes(privateValue));
    assert.ok(!JSON.stringify(result).includes(privateValue));
  }
  assert.deepEqual(Object.keys(result).sort(), ['configured', 'expired', 'expires_at', 'revision', 'saved_at']);
  const loaded = await loadReaderSession(f.env, { now: () => NOW + 1 });
  assert.deepEqual(loaded, credentials({ cookie: 'reader_cookie=synthetic', appmsg_token: 'synthetic-appmsg-token', expires_at: NOW + TTL }));
  const payload = await stored(f);
  assert.match(payload.revision, /^[a-f\d-]{36}$/);
  assert.equal(payload.kind, 'wechat-reader-session');
  assert.equal(payload.account_biz, WECHAT_READER_BIZ);
  assert.deepEqual(f.puts, [{ key: KEY, metadata: { httpMetadata: { contentType: 'application/json', cacheControl: 'private, no-store' } } }]);
  assert.equal(f.objects.get(BACKEND_KEY), 'unchanged backend state');
  assert.ok(f.gets.every(key => key === KEY));
});

test('only complete official target reading URLs are accepted and only normalized credentials are saved', async () => {
  const f = fixture();
  await saveReaderSession(f.env, article() + '&unused_tracking=ignored', { now: NOW });
  assert.deepEqual(await loadReaderSession(f.env, { now: NOW }), credentials({ expires_at: NOW + TTL }));
  assert.ok(!JSON.stringify(await stored(f)).includes('unused_tracking'));
  assert.ok(!JSON.stringify(await stored(f)).includes('https://'));
  const original = f.objects.get(KEY);
  for (const input of [article().replace('&key=synthetic-reader-key', ''), article().replace('mp.weixin.qq.com', 'evil.example'),
    article().replace(encodeURIComponent(WECHAT_READER_BIZ), 'OtherAccount'), article() + '&uin=99',
    article() + '&key=duplicate-secret', 'https://mp.weixin.qq.com/s/ordinary-share-link', article().replace('https:', 'http:'),
    article().replace('pass_ticket=synthetic-pass-ticket', 'pass_ticket='), article().replace('uin=12345678', 'uin=not-numeric')]) {
    await assert.rejects(saveReaderSession(f.env, input, { now: NOW }), error => {
      assert.equal(error.code, 'READER_LOGIN_REQUIRED');
      assert.ok(!error.message.includes(input));
      assert.ok(!error.message.includes('synthetic-reader-key'));
      return true;
    });
    assert.equal(f.objects.get(KEY), original);
  }
});

test('missing and exactly expired sessions are distinct and expiry status stays readable', async () => {
  const f = fixture();
  assert.deepEqual(await readerSessionStatus(f.env, { now: NOW }), { configured: false, expired: false, expires_at: null, saved_at: null, revision: null });
  await assert.rejects(loadReaderSession(f.env, { now: NOW }), code('READER_LOGIN_REQUIRED'));
  const saved = await saveReaderSession(f.env, credentials(), { now: NOW });
  assert.equal((await loadReaderSession(f.env, { now: NOW + TTL - 1 })).expires_at, NOW + TTL);
  await assert.rejects(loadReaderSession(f.env, { now: NOW + TTL }), code('READER_SESSION_EXPIRED'));
  assert.deepEqual(await readerSessionStatus(f.env, { now: NOW + TTL }), { configured: true, expired: true, expires_at: NOW + TTL, saved_at: NOW, revision: saved.revision });
  assert.ok(f.objects.has(KEY), 'Expired state is not silently erased by a read');
});

test('expiry is short by default, bounded to two hours and random revision changes with each save', async () => {
  const f = fixture();
  await saveReaderSession(f.env, credentials({ expires_at: NOW + 2 * 60 * 60 * 1000 }), { now: NOW });
  const before = await stored(f);
  assert.equal(before.expires_at, NOW + 2 * 60 * 60 * 1000);
  for (const expires_at of [NOW - 1, NOW, NOW + 2 * 60 * 60 * 1000 + 1, 'invalid', Infinity, NaN]) {
    const prior = f.objects.get(KEY);
    await assert.rejects(saveReaderSession(f.env, credentials({ expires_at }), { now: NOW }), code('READER_LOGIN_REQUIRED'));
    assert.equal(f.objects.get(KEY), prior);
  }
  await saveReaderSession(f.env, credentials(), { now: NOW });
  assert.notEqual((await stored(f)).revision, before.revision);
});

test('malformed credentials, backend cookies and hostile objects do not replace saved reader credentials', async () => {
  const f = fixture();
  await saveReaderSession(f.env, credentials(), { now: NOW });
  const before = f.objects.get(KEY);
  const hostile = Object.defineProperty({}, 'kind', { get() { throw new Error('synthetic private value'); } });
  for (const input of [null, [], {}, { kind: 'account', uin: '1', key: 'x', pass_ticket: 'x' },
    credentials({ account_biz: 'OtherAccount' }), credentials({ cookie: 'slave_sid=publisher-session' }),
    credentials({ cookie: 'reader=x; slave_bizuin=backend' }), credentials({ key: 'x'.repeat(4097) }),
    credentials({ pass_ticket: 'line\nbreak' }), hostile]) {
    await assert.rejects(saveReaderSession(f.env, input, { now: NOW }), error => error.code === 'READER_LOGIN_REQUIRED' && !error.message.includes('synthetic private'));
    assert.equal(f.objects.get(KEY), before);
  }
});

test('invalid ciphertext, replayed backend payloads and mismatched saved payloads never load', async () => {
  const f = fixture();
  await saveReaderSession(f.env, credentials(), { now: NOW });
  const valid = await stored(f);
  const bad = [null, { ...valid, kind: 'publisher-backend-session' }, { ...valid, account_biz: 'OtherAccount' },
    { ...valid, revision: 'not-random' }, { ...valid, saved_at: NOW + 1 }, { ...valid, saved_at: -1 },
    { ...valid, expires_at: NOW }, { ...valid, expires_at: NOW + 3 * 60 * 60 * 1000 },
    { ...valid, credentials: credentials({ account_biz: 'OtherAccount', expires_at: valid.expires_at }) },
    { ...valid, credentials: credentials({ expires_at: valid.expires_at + 1 }) },
    { ...valid, credentials: { ...valid.credentials, kind: 'backend' } }];
  for (const payload of bad) {
    await replace(f, payload);
    await assert.rejects(loadReaderSession(f.env, { now: NOW }), code('READER_SESSION_INVALID'));
  }
  for (const encrypted of ['not-json', '{"format":1}', '{"format":2}', '{}']) {
    f.objects.set(KEY, encrypted);
    await assert.rejects(loadReaderSession(f.env, { now: NOW }), code('READER_SESSION_INVALID'));
  }
  assert.equal(f.objects.get(BACKEND_KEY), 'unchanged backend state');
});

test('object byte limits apply before and after its body is read', async () => {
  const f = fixture();
  let read = false;
  f.env.ARCHIVE_BUCKET.get = async () => ({ size: 32769, text: async () => { read = true; return '{}'; } });
  await assert.rejects(loadReaderSession(f.env, { now: NOW }), code('READER_SESSION_INVALID'));
  assert.equal(read, false);
  f.env.ARCHIVE_BUCKET.get = async () => ({ size: 1, text: async () => '语'.repeat(11000) });
  await assert.rejects(loadReaderSession(f.env, { now: NOW }), code('READER_SESSION_INVALID'));
  assert.deepEqual(f.puts, []);
});

test('encryption and size validation finish before replacing an existing object', async () => {
  const f = fixture();
  await saveReaderSession(f.env, credentials(), { now: NOW });
  const before = f.objects.get(KEY);
  const large = credentials({ key: '"'.repeat(4096), pass_ticket: 'x'.repeat(4096), cookie: 'reader=' + 'x'.repeat(8185),
    appmsg_token: 'x'.repeat(4096), user_agent: 'x'.repeat(1024) });
  await assert.rejects(saveReaderSession(f.env, large, { now: NOW }), code('READER_SESSION_INVALID'));
  assert.equal(f.objects.get(KEY), before);
  assert.equal(f.puts.length, 1);
  f.env.ARCHIVE_SESSION_KEY = 'invalid-encryption-key';
  await assert.rejects(saveReaderSession(f.env, credentials(), { now: NOW }));
  assert.equal(f.objects.get(KEY), before);
  assert.equal(f.puts.length, 1);
});

test('clearing deletes only the fixed reader session and leaves publisher state untouched', async () => {
  const f = fixture();
  await saveReaderSession(f.env, credentials(), { now: NOW });
  assert.deepEqual(await clearReaderSession(f.env), { configured: false, expired: false, expires_at: null, saved_at: null, revision: null });
  assert.deepEqual(f.deletes, [KEY]);
  assert.equal(f.objects.has(KEY), false);
  assert.equal(f.objects.get(BACKEND_KEY), 'unchanged backend state');
  assert.deepEqual(await clearReaderSession(f.env), { configured: false, expired: false, expires_at: null, saved_at: null, revision: null });
  assert.deepEqual(f.deletes, [KEY, KEY]);
});
