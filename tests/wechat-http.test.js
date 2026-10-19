import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createWechatHttp } from '../src/archive/wechat-http.js';
import { CollectorError } from '../src/archive/collector-security.js';
import { SessionStore } from '../src/archive/collector-session.js';
import { REQUEST_INTERVAL_MS, SOURCE_COOLDOWN_MS } from '../src/archive/wechat-throttle.js';

const ORIGIN = 'https://mp.weixin.qq.com';
const TIME = Date.parse('2026-10-19T01:00:00Z');
const search = { action: 'search_biz', begin: '0', count: '10', query: 'Synthetic source' };
const cookie = (name = 'session', value = 'synthetic-cookie', options = {}) => ({ name, value,
  domain: 'mp.weixin.qq.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax', ...options });
const state = cookies => ({ cookies: cookies || [cookie()], origins: [] });
const json = (body = { base_resp: { ret: 0 }, list: [] }, options) => new Response(JSON.stringify(body), options);
const hasCode = code => error => error instanceof CollectorError && error.code === code && error.transport === 'http';

function fixture({ httpAuth = { token: '123456' }, storageState = state(), fetchImpl } = {}) {
  const saved = { version: 1, storageState, ...(httpAuth ? { httpAuth } : {}) };
  const saves = [];
  const calls = [];
  let loads = 0;
  const transport = createWechatHttp({ now: () => TIME, resolveHost: async () => {},
    throttleFactory: () => ({ reserve: async () => ({ next_allowed_at: TIME + REQUEST_INTERVAL_MS }),
      cooldown: async () => ({ next_allowed_at: TIME + SOURCE_COOLDOWN_MS }) }),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return fetchImpl ? fetchImpl(url, options, calls.length) : json(); },
    sessionStoreFactory: () => ({ load: async () => { loads++; return structuredClone(saved); },
      save: async (...args) => { saves.push(args); return 1; } }),
  });
  return { transport, saves, calls, saved, loads: () => loads };
}

test('saved HTTP authentication makes one normal fetch and never creates a browser', async () => {
  const f = fixture();
  const body = await f.transport.request({}, '/cgi-bin/searchbiz', search);
  assert.equal(body.transport, 'http');
  assert.equal(JSON.stringify(body), '{"base_resp":{"ret":0},"list":[]}');
  assert.equal(f.calls.length, 1);
  const url = new URL(f.calls[0].url);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, '/cgi-bin/searchbiz');
  assert.equal(url.searchParams.get('token'), '123456');
  assert.equal(url.searchParams.get('action'), 'search_biz');
  assert.equal(f.calls[0].options.redirect, 'manual');
  assert.equal(f.calls[0].options.headers.cookie, 'session=synthetic-cookie');
  assert.match(f.calls[0].options.headers['user-agent'], /^Mozilla\/5\.0/);
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(f.saves, []);
});

test('legacy state recovers a token from a same-origin redirect and persists rotated cookies with CAS arguments', async () => {
  const f = fixture({ httpAuth: null, fetchImpl: async (_url, _options, call) => call === 1
    ? new Response('', { status: 302, headers: { location: '/cgi-bin/home?token=234567',
      'set-cookie': 'session=rotated; Path=/; Secure; HttpOnly; SameSite=Lax' } }) : json() });
  await f.transport.request({}, '/cgi-bin/searchbiz', search);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, `${ORIGIN}/`);
  assert.equal(f.calls[1].options.headers.cookie, 'session=rotated');
  assert.equal(new URL(f.calls[1].url).searchParams.get('token'), '234567');
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.saves[0].slice(1), [1, null, { token: '234567', userAgent: f.calls[0].options.headers['user-agent'] }]);
  assert.equal(f.saves[0][0].cookies[0].value, 'rotated');
  assert.equal(f.saved.storageState.cookies[0].value, 'synthetic-cookie');
});

test('HTML token recovery reads a bounded document without executing scripts', async () => {
  const f = fixture({ httpAuth: null, fetchImpl: async (_url, _options, call) => call === 1
    ? new Response('<script>throw new Error("never execute"); window.wx={token:"345678"};</script>') : json() });
  await f.transport.request({}, '/cgi-bin/appmsgpublish', { fakeid: 'synthetic', begin: 5, count: 5 });
  assert.equal(f.calls.length, 2);
  const target = new URL(f.calls[1].url);
  assert.equal(target.searchParams.get('token'), '345678');
  assert.equal(target.searchParams.get('sub_action'), 'list_ex');
  assert.equal(target.searchParams.get('begin'), '5');
});

test('published article requests contain the exact fixed list profile including literal null and an empty query', async () => {
  const profile = { sub: 'list', sub_action: 'list_ex', search_field: 'null', query: '', type: '101_1', free_publish_type: '1' };
  // Older internal callers may omit fixed fields; the transport still supplies
  // the complete published-list profile instead of forwarding arbitrary values.
  for (const fixed of [profile, {}]) {
    const f = fixture();
    await f.transport.request({}, '/cgi-bin/appmsgpublish', Object.freeze({ ...fixed, fakeid: 'source/+=abc', begin: '5', count: '5' }));
    assert.equal(f.calls.length, 1);
    const target = new URL(f.calls[0].url);
    assert.equal(target.origin, ORIGIN);
    assert.equal(target.pathname, '/cgi-bin/appmsgpublish');
    assert.deepEqual(Object.fromEntries(target.searchParams), {
      begin: '5', count: '5', token: '123456', lang: 'zh_CN', f: 'json', ajax: '1', ...profile, fakeid: 'source/+=abc',
    });
    assert.equal([...target.searchParams].length, 13);
    assert.ok(target.searchParams.has('query'));
    assert.equal(target.searchParams.get('query'), '');
    assert.match(target.search, /search_field=null/);
    assert.match(target.search, /(?:[?&])query=(?:&|$)/);
    assert.equal(f.calls[0].options.redirect, 'manual');
    assert.equal(f.calls[0].options.headers.cookie, 'session=synthetic-cookie');
  }
});

test('published list profile changes and unsupported fields are rejected before account state or requests', async () => {
  for (const patch of [{ sub: 'search' }, { sub_action: 'list' }, { search_field: '7' }, { search_field: null },
    { query: 'keyword' }, { type: '9' }, { type: 101 }, { free_publish_type: '0' }, { free_publish_type: 1 },
    { token: 'injected' }, { lang: 'en_US' }, { ajax: '0' }, { action: 'list_ex' }, { scene: 'draft' }]) {
    const f = fixture();
    await assert.rejects(f.transport.request({}, '/cgi-bin/appmsgpublish', { fakeid: 'source', ...patch }), hasCode('INVALID_QUERY'));
    assert.equal(f.loads(), 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.saves.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', { ...search, action: 'list_ex' }), hasCode('INVALID_QUERY'));
  assert.equal(f.loads(), 0);
  assert.equal(f.calls.length, 0);
});

test('a saved browser user agent is used consistently and retained when HTTP cookies rotate', async () => {
  const userAgent = 'SyntheticBrowser/1.0';
  const f = fixture({ httpAuth: { token: '123456', userAgent }, fetchImpl: async () => json(undefined,
    { headers: { 'set-cookie': 'session=rotated; Path=/; Secure' } }) });
  await f.transport.request({}, '/cgi-bin/searchbiz', search);
  assert.equal(f.calls[0].options.headers['user-agent'], userAgent);
  assert.deepEqual(f.saves[0][3], { token: '123456', userAgent });
});

test('invalid saved user agents are rejected before they can enter authenticated headers', async () => {
  for (const userAgent of [null, '', ' ', 'x'.repeat(513), 'Browser\r\nCookie: injected', 'Browser\u0000']) {
    const f = fixture({ httpAuth: { token: '123456', userAgent } });
    await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', search), hasCode('INVALID_STORAGE_STATE'));
    assert.equal(f.calls.length, 0);
  }
});

test('cookie sending respects domain, path, expiry and header character boundaries', async () => {
  const f = fixture({ storageState: state([cookie(), cookie('deep', 'yes', { path: '/cgi-bin' }),
    cookie('wrongpath', 'no', { path: '/cgi' }), cookie('expired', 'no', { expires: TIME / 1000 }),
    cookie('foreign', 'no', { domain: 'external.example' }), cookie('parent', 'yes', { domain: '.weixin.qq.com' }),
    cookie('host-only-parent', 'no', { domain: 'weixin.qq.com' }), cookie('host-only-root', 'no', { domain: 'qq.com' }),
    cookie('publicsuffix', 'no', { domain: '.com' }), cookie('injected', 'no\r\nx-secret: yes'), cookie('bad name', 'no')]) });
  await f.transport.request({}, '/cgi-bin/searchbiz', search);
  assert.equal(f.calls[0].options.headers.cookie, 'deep=yes; session=synthetic-cookie; parent=yes');
});

test('Set-Cookie rotates, expires and scopes cookies while rejecting unrelated domains and invalid prefixes', async () => {
  const headers = new Headers();
  for (const entry of ['session=; Max-Age=0; Path=/', 'fresh=one; Secure; HttpOnly',
    'parent=two; Domain=.weixin.qq.com; Path=/; Secure', 'foreign=no; Domain=external.example; Path=/',
    'suffix=no; Domain=.com; Path=/', '__Host-bad=no; Domain=mp.weixin.qq.com; Path=/; Secure']) headers.append('set-cookie', entry);
  const f = fixture({ fetchImpl: async () => json(undefined, { headers }) });
  await f.transport.request({}, '/cgi-bin/searchbiz', search);
  const cookies = f.saves[0][0].cookies;
  assert.deepEqual(cookies.map(item => item.name), ['fresh', 'parent']);
  assert.equal(cookies[0].path, '/cgi-bin');
  assert.equal(cookies[0].secure, true);
  assert.equal(cookies[0].httpOnly, true);
});

test('off-origin, insecure, private and credential-bearing redirects never receive a second request or credentials', async () => {
  for (const location of ['https://external.example/steal', 'http://mp.weixin.qq.com/cgi-bin/home?token=1',
    'http://127.0.0.1/', 'https://mp.weixin.qq.com@external.example/', 'https://mp.weixin.qq.com:444/']) {
    const f = fixture({ httpAuth: null, fetchImpl: async () => new Response('', { status: 302, headers: { location } }) });
    await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', search), hasCode('UNSAFE_URL'));
    assert.equal(f.calls.length, 1);
    assert.equal(new URL(f.calls[0].url).origin, ORIGIN);
    assert.equal(f.saves.length, 0);
  }
});

test('an API redirect cannot forward cookies even when its target is another official page', async () => {
  const f = fixture({ fetchImpl: async () => new Response('', { status: 302, headers: { location: '/cgi-bin/home?token=999999' } }) });
  await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', search), hasCode('CHALLENGE_REQUIRED'));
  assert.equal(f.calls.length, 1);
});

test('token recovery has a finite same-origin redirect limit', async () => {
  const f = fixture({ httpAuth: null, fetchImpl: async () => new Response('', { status: 302, headers: { location: '/cgi-bin/home' } }) });
  await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', search), hasCode('LOGIN_EXPIRED'));
  assert.equal(f.calls.length, 6);
});

test('invalid paths or parameters fail before private state is loaded', async () => {
  for (const [path, params] of [['https://external.example/', search], ['/cgi-bin/../searchbiz', search],
    ['/cgi-bin/searchbiz', { ...search, count: 21 }], ['/cgi-bin/searchbiz', { ...search, token: '999999' }],
    ['/cgi-bin/searchbiz', { ...search, query: 'q'.repeat(101) }], ['/cgi-bin/appmsgpublish', { fakeid: 'bad&fakeid' }]]) {
    const f = fixture();
    await assert.rejects(f.transport.request({}, path, params), hasCode('INVALID_QUERY'));
    assert.equal(f.loads(), 0);
    assert.equal(f.calls.length, 0);
  }
});

test('DNS rejection prevents an authenticated network request', async () => {
  let calls = 0;
  const f = fixture();
  const transport = createWechatHttp({ resolveHost: async () => { throw new CollectorError('UNSAFE_URL', 'unsafe address'); },
    throttleFactory: () => ({ reserve: async () => ({ next_allowed_at: TIME + 10_000 }) }),
    fetchImpl: async () => { calls++; return json(); }, sessionStoreFactory: () => ({ load: async () => f.saved }) });
  await assert.rejects(transport.request({}, '/cgi-bin/searchbiz', search), hasCode('UNSAFE_URL'));
  assert.equal(calls, 0);
});

test('expired sessions, verification shells, source throttling and upstream failures retain distinct classifications', async () => {
  for (const [response, code] of [
    [() => json({ base_resp: { ret: 200003 } }), 'LOGIN_EXPIRED'],
    [() => json({ base_resp: { ret: 200004 } }), 'LOGIN_EXPIRED'],
    [() => json({ base_resp: { ret: 200005 } }), 'LOGIN_EXPIRED'],
    [() => json({ base_resp: { ret: 200013 } }), 'RATE_LIMITED'],
    [() => json({ base_resp: { ret: 45009 } }), 'RATE_LIMITED'],
    [() => json({ base_resp: { ret: -1 } }), 'UPSTREAM_ERROR'],
    [() => json({ base_resp: { ret: 1234 } }), 'SOURCE_FORMAT_CHANGED'],
    [() => json({}), 'SOURCE_FORMAT_CHANGED'],
    [() => new Response('<html>当前环境异常，完成验证后继续访问</html>'), 'CHALLENGE_REQUIRED'],
    [() => new Response('', { status: 401 }), 'LOGIN_EXPIRED'],
    [() => new Response('', { status: 403 }), 'CHALLENGE_REQUIRED'],
    [() => new Response('', { status: 429 }), 'RATE_LIMITED'],
    [() => new Response('', { status: 502 }), 'UPSTREAM_ERROR'],
  ]) {
    const f = fixture({ fetchImpl: async () => response() });
    await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', search), hasCode(code));
    assert.equal(f.saves.length, 0);
  }
});

test('rate-limit diagnostics distinguish HTTP throttling from WeChat response codes without exposing account values', async () => {
  for (const [response, reason] of [
    [() => new Response('private response token=123456 synthetic-cookie', { status: 429 }), 'http_429'],
    [() => json({ base_resp: { ret: 200013, err_msg: 'private token=123456 synthetic-cookie' } }), 'mp_ret_200013'],
    [() => json({ base_resp: { ret: 45009, err_msg: 'private token=123456 synthetic-cookie' } }), 'mp_ret_45009'],
  ]) {
    const f = fixture({ fetchImpl: async () => response() });
    await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', search), error => {
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.status, 429);
      assert.equal(error.retry_at, TIME + SOURCE_COOLDOWN_MS);
      assert.equal(error.retryable, true);
      assert.equal(error.transport, 'http');
      assert.equal(error.phase, 'http_source');
      assert.equal(error.diagnostic, `wechat_http: ${reason}`);
      assert.doesNotMatch(`${error.message} ${error.diagnostic}`, /123456|synthetic-cookie|https:/);
      return true;
    });
    assert.equal(f.saves.length, 0);
  }
});

test('legacy login and challenge pages are not mistaken for a usable backend token', async () => {
  for (const [html, code] of [['<html>请扫码登录公众号</html>', 'LOGIN_EXPIRED'],
    ['<html>当前环境异常，完成验证后继续访问</html>', 'CHALLENGE_REQUIRED']]) {
    const f = fixture({ httpAuth: null, fetchImpl: async () => new Response(html) });
    await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', search), hasCode(code));
    assert.equal(f.calls.length, 1);
    assert.equal(f.saves.length, 0);
  }
});

test('declared and streaming response sizes are bounded before parsing or saving', async () => {
  for (const response of [() => new Response('small', { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'content-length': '1' } })]) {
    const f = fixture({ fetchImpl: async () => response() });
    await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', search), hasCode('RESOURCE_TOO_LARGE'));
    assert.equal(f.saves.length, 0);
  }
});

test('network and timeout diagnostics never expose private request values', async () => {
  const f = fixture({ fetchImpl: async () => { throw new Error('network failure https://mp.weixin.qq.com/?token=123456 Cookie: session=synthetic-cookie'); } });
  await assert.rejects(f.transport.request({}, '/cgi-bin/searchbiz', search), error => {
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.retryable, true);
    assert.equal(error.transport, 'http');
    assert.doesNotMatch(`${error.message} ${error.diagnostic}`, /123456|synthetic-cookie|https:/);
    assert.equal(error.phase, 'http_source');
    return true;
  });
});

class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    for (const migration of ['0001_archive.sql', '0004_wechat_throttle.sql']) {
      this.sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
  }
  prepare(sql) {
    const statement = (values = []) => ({ bind: (...bound) => statement(bound),
      first: async () => this.sqlite.prepare(sql).get(...values) || null,
      run: async () => ({ meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) } }) });
    return statement();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}

function realEnvironment(t) {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const objects = new Map();
  return { ARCHIVE_DB: db, ARCHIVE_SESSION_KEY: btoa('s'.repeat(32)), ARCHIVE_BUCKET: {
    get: async key => objects.has(key) ? { text: async () => objects.get(key) } : null,
    put: async (key, value) => { objects.set(key, value); }, delete: async key => { objects.delete(key); },
  } };
}

test('search and article-list requests share their account interval across separate HTTP clients', async t => {
  const env = realEnvironment(t);
  let clock = TIME;
  const seed = new SessionStore(env, () => clock);
  const login = await seed.beginLogin();
  await seed.save(state(), 0, login.id, { token: '123456' });
  let calls = 0;
  const client = () => createWechatHttp({ now: () => clock, resolveHost: async () => {},
    fetchImpl: async () => { calls++; return json(); } });
  await client().request(env, '/cgi-bin/searchbiz', search);
  await assert.rejects(client().request(env, '/cgi-bin/appmsgpublish', { fakeid: 'source' }), error => {
    assert.equal(error.diagnostic, 'wechat_http: local_cooldown');
    return error.code === 'RATE_LIMITED' && error.status === 429 && error.retry_at === TIME + 10_000;
  });
  assert.equal(calls, 1);
  clock += 10_000;
  await client().request(env, '/cgi-bin/appmsgpublish', { fakeid: 'source' });
  assert.equal(calls, 2);
});

test('confirmed WeChat throttling persists fifteen minutes and repeated local retries never extend the deadline', async t => {
  const env = realEnvironment(t);
  let clock = TIME;
  const seed = new SessionStore(env, () => clock);
  const login = await seed.beginLogin();
  await seed.save(state(), 0, login.id, { token: '123456' });
  let calls = 0;
  const transport = createWechatHttp({ now: () => clock, resolveHost: async () => {}, fetchImpl: async () => {
    calls++;
    return calls === 1 ? json({ base_resp: { ret: 200013 } }) : json();
  } });
  const deadline = TIME + SOURCE_COOLDOWN_MS;
  await assert.rejects(transport.request(env, '/cgi-bin/searchbiz', search), error => error.code === 'RATE_LIMITED' && error.retry_at === deadline);
  for (const offset of [REQUEST_INTERVAL_MS, 60_000, SOURCE_COOLDOWN_MS - 1]) {
    clock = TIME + offset;
    await assert.rejects(transport.request(env, '/cgi-bin/searchbiz', search), error => {
      assert.equal(error.diagnostic, 'wechat_http: local_cooldown');
      return error.retry_at === deadline;
    });
    assert.equal(calls, 1);
    assert.equal(env.ARCHIVE_DB.sqlite.prepare('SELECT next_allowed_at FROM archive_wechat_throttle WHERE singleton=1').get().next_allowed_at, deadline);
  }
  clock = deadline;
  await transport.request(env, '/cgi-bin/searchbiz', search);
  assert.equal(calls, 2);
});

test('ordinary network failure keeps the account reservation without promoting it to a source cooldown', async t => {
  const env = realEnvironment(t);
  let clock = TIME;
  const seed = new SessionStore(env, () => clock);
  const login = await seed.beginLogin();
  await seed.save(state(), 0, login.id, { token: '123456' });
  let calls = 0;
  const transport = createWechatHttp({ now: () => clock, resolveHost: async () => {}, fetchImpl: async () => {
    if (++calls === 1) throw new Error('network unavailable');
    return json();
  } });
  await assert.rejects(transport.request(env, '/cgi-bin/searchbiz', search), hasCode('UPSTREAM_ERROR'));
  await assert.rejects(transport.request(env, '/cgi-bin/searchbiz', search), error => error.retry_at === TIME + 10_000);
  assert.equal(calls, 1);
  clock += 10_000;
  await transport.request(env, '/cgi-bin/searchbiz', search);
  assert.equal(calls, 2);
});

test('successful legacy HTTP recovery persists its token and user agent without changing the human login generation', async t => {
  const env = realEnvironment(t);
  const seed = new SessionStore(env, () => TIME);
  const initial = await seed.beginLogin();
  await seed.save(state(), 0, initial.id);
  let calls = 0;
  let userAgent;
  const transport = createWechatHttp({ now: () => TIME, resolveHost: async () => {}, fetchImpl: async (_url, options) => {
    userAgent = options.headers['user-agent'];
    if (++calls === 1) return new Response('', { status: 302, headers: { location: '/cgi-bin/home?token=123456' } });
    return json(undefined, { headers: { 'set-cookie': 'session=updated-cookie; Path=/; Secure' } });
  } });
  await transport.request(env, '/cgi-bin/searchbiz', search);
  const loaded = await new SessionStore(env, () => TIME).load();
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.httpAuth, { token: '123456', userAgent });
  assert.equal(loaded.storageState.cookies[0].value, 'updated-cookie');
});

for (const complete of [false, true]) {
  test(`HTTP cookie refresh cannot replace a ${complete ? 'completed newer' : 'currently active'} human login`, async t => {
    const env = realEnvironment(t);
    const seed = new SessionStore(env, () => TIME);
    const initial = await seed.beginLogin();
    await seed.save(state(), 0, initial.id);
    let replacement;
    let calls = 0;
    const transport = createWechatHttp({ now: () => TIME, resolveHost: async () => {}, fetchImpl: async () => {
      if (++calls === 1) return new Response('', { status: 302, headers: { location: '/cgi-bin/home?token=123456' } });
      const newer = new SessionStore(env, () => TIME);
      replacement = await newer.beginLogin();
      if (complete) await newer.save(state([cookie('session', 'new-human-cookie')]), 1, replacement.id);
      return json(undefined, { headers: { 'set-cookie': 'session=old-response-cookie; Path=/; Secure' } });
    } });
    await assert.rejects(transport.request(env, '/cgi-bin/searchbiz', search), hasCode('LOGIN_STALE'));
    const current = await new SessionStore(env, () => TIME).current();
    assert.equal(current.version, complete ? 2 : 1);
    assert.equal(current.active_login_id, complete ? null : replacement.id);
    const loaded = await new SessionStore(env, () => TIME).load();
    assert.equal(loaded.storageState.cookies[0].value, complete ? 'new-human-cookie' : 'synthetic-cookie');
  });
}
