import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createCollector, extractArticleDocument, normalizeSourcePage } from '../src/archive/collector.js';
import { CollectorError, classifyCollectorError, collectorDiagnostic, isPublicAddress, readLimited, resolvePublicHost, safeFetch, validatePublicUrl } from '../src/archive/collector-security.js';
import { SessionStore, decryptSession, encryptSession, sessionCryptoKey } from '../src/archive/collector-session.js';
import { fetchImageResource, imageResourceId, IMAGE_LIMIT } from '../src/archive/resources.js';

class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const statement = (values = []) => ({
      bind: (...args) => statement(args),
      first: async () => this.sqlite.prepare(sql).get(...values) || null,
      run: async () => ({ meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) } }),
    });
    return statement();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}

class Bucket {
  values = new Map();
  async get(key) { const value = this.values.get(key); return value === undefined ? null : { text: async () => value }; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

function environment(t) {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  return { ARCHIVE_DB: db, ARCHIVE_BUCKET: new Bucket(), ARCHIVE_SESSION_KEY: btoa('k'.repeat(32)), ARCHIVE_BROWSER: {} };
}

const hasCode = code => error => error instanceof CollectorError && error.code === code;
const noDns = async () => {};
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const documentResult = (extra = {}) => ({
  title: 'An article', author: 'Author', source_name: 'Source', html: '<p>A complete body</p>',
  text: 'A complete body', images: [], date: '', invalid: false, challenge: false, removed: false, ...extra,
});

function browserDouble(doc = documentResult()) {
  const calls = { launches: [], acquisitions: [], connections: [], closes: 0, decodes: 0, contextOptions: [], urls: [] };
  let currentUrl = 'https://mp.weixin.qq.com/';
  let storage = { cookies: [{ name: 'session', value: 'private-cookie', domain: 'mp.weixin.qq.com', path: '/' }], origins: [] };
  const page = {
    goto: async url => { calls.urls.push(url); }, url: () => currentUrl,
    waitForURL: async () => {},
    route: async (_pattern, handler) => { calls.route = handler; },
    setContent: async html => { calls.html = html; }, bringToFront: async () => {}, screenshot: async () => png,
    evaluate: async (fn, arg) => {
      if (fn === extractArticleDocument) return Array.isArray(doc) ? doc.shift() : doc;
      if (arg?.base64) { calls.decodes++; return calls.decodeResult !== false; }
      calls.urls.push(arg);
      return calls.apiResponse || { status: 200, text: JSON.stringify({ base_resp: { ret: 0 }, list: [] }) };
    },
  };
  const cdp = { send: async (name, params) => {
    calls.command = name; calls.commandParams = params;
    if (name === 'Cloudflare.getLiveView') return { devtoolsFrontendUrl: 'https://live.browser.run/ui/view?jwt=secret' };
    return {};
  } };
  const context = { pages: () => [page], newPage: async () => page, storageState: async () => storage, newCDPSession: async () => cdp,
    addInitScript: async script => { calls.initScript = script; }, clearCookies: async () => {}, addCookies: async cookies => { calls.restoredCookies = cookies; },
    route: async (_pattern, handler) => { calls.contextRoute = handler; } };
  const browser = { newContext: async options => { calls.contextOptions.push(options); return context; },
    contexts: () => [context], close: async () => { calls.closes++; }, newBrowserCDPSession: async () => cdp };
  const playwright = {
    launch: async (_binding, options) => { calls.launches.push(options); return browser; },
    acquire: async (_binding, options) => { calls.acquisitions.push(options); return { sessionId: 'remote-browser-id' }; }, connect: async (_binding, options) => { calls.connections.push(options); return browser; },
  };
  return { playwright, calls, setUrl: value => { currentUrl = value; }, setStorage: value => { storage = value; } };
}

test('URL validation rejects private, encoded, credentials, unsafe ports and protocols', () => {
  for (const value of ['http://127.0.0.1/a', 'http://2130706433/a', 'http://0x7f000001/a', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'https://10.0.0.1/', 'http://169.254.169.254/', 'https://localhost/',
    'https://host.internal/', 'https://a:b@public.com/', 'https://public.com:8080/', 'file:///tmp/a', 'https://public.com/\nfoo']) {
    assert.throws(() => validatePublicUrl(value), error => ['UNSAFE_URL', 'INVALID_URL'].includes(error.code), value);
  }
  assert.equal(validatePublicUrl('https://mp.weixin.qq.com/s/article#fragment').href, 'https://mp.weixin.qq.com/s/article');
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const address of ['100.64.0.1', '192.0.2.1', '198.18.0.1', '2001:db8::1', '2001:20::1', '2002:7f00:1::']) assert.equal(isPublicAddress(address), false, address);
});

test('DNS validation rejects a host when any returned address is private', async () => {
  await assert.rejects(resolvePublicHost('news.public.com', async url => Response.json({ Status: 0, Answer: [
    { type: url.endsWith('type=A') ? 1 : 28, data: url.endsWith('type=A') ? '8.8.8.8' : '::1' },
  ] })), hasCode('UNSAFE_URL'));
});

test('redirect targets are checked before any request and never inherit credentials', async () => {
  const calls = [];
  await assert.rejects(safeFetch('https://news.public.com/article', {
    resolveHost: noDns, fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/' } });
    },
  }), hasCode('UNSAFE_URL'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].redirect, 'manual');
  assert.equal(calls[0][1].headers.cookie, undefined);
});

test('public DNS requests use the redirect values supported by the Workers runtime', async () => {
  const calls = [];
  await resolvePublicHost('mp.weixin.qq.com', async (url, init) => {
    if (init.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of follow or manual');
    assert.equal(init.redirect, 'manual');
    calls.push(url);
    return Response.json({ Status: 0, Answer: [new URL(url).searchParams.get('type') === 'A'
      ? { type: 1, data: '8.8.8.8' } : { type: 28, data: '2606:4700:4700::1111' }] });
  });
  assert.equal(calls.length, 2);
});

test('DNS redirects are rejected and their response bodies cancelled without following them', async () => {
  let cancelled = 0;
  const calls = [];
  await assert.rejects(resolvePublicHost('mp.weixin.qq.com', async (url, init) => {
    calls.push(url);
    assert.equal(new URL(url).hostname, 'cloudflare-dns.com');
    assert.equal(init.redirect, 'manual');
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      status: 302, headers: { location: 'http://169.254.169.254/private-resolver' },
    });
  }), hasCode('UPSTREAM_ERROR'));
  assert.equal(calls.length, 2);
  assert.equal(cancelled, 2);
});

test('bounded readers reject a lying or absent content-length header', async () => {
  await assert.rejects(readLimited(new Response('123456789'), 5), hasCode('RESOURCE_TOO_LARGE'));
  await assert.rejects(readLimited(new Response('123', { headers: { 'content-length': '9000' } }), 5), hasCode('RESOURCE_TOO_LARGE'));
});

test('private session encryption is randomized, authenticated and requires a configured key', async () => {
  await assert.rejects(sessionCryptoKey({}), hasCode('CONFIG_MISSING'));
  await assert.rejects(sessionCryptoKey({ ARCHIVE_SESSION_KEY: 'bad' }), hasCode('CONFIG_INVALID'));
  const key = await sessionCryptoKey({ ARCHIVE_SESSION_KEY: btoa('k'.repeat(32)) });
  const value = { cookies: [{ value: 'never-expose-this-cookie' }] };
  const first = await encryptSession(value, key);
  const second = await encryptSession(value, key);
  assert.notEqual(first, second);
  assert.equal(first.includes('never-expose-this-cookie'), false);
  assert.deepEqual(await decryptSession(first, key), value);
  const tampered = JSON.parse(first);
  tampered.ciphertext = `AAAA${tampered.ciphertext.slice(4)}`;
  await assert.rejects(decryptSession(JSON.stringify(tampered), key), hasCode('CONFIG_INVALID'));
});

test('session CAS rejects stale writers and repeated login creation shares one task', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const firstLogin = await store.beginLogin();
  assert.equal((await store.beginLogin()).id, firstLogin.id);
  const state = { cookies: [], origins: [] };
  await store.save(state, 0, firstLogin.id);
  assert.equal((await store.load()).version, 1);
  await assert.rejects(store.save({ cookies: [{ value: 'stale' }] }, 0), hasCode('LOGIN_STALE'));
  assert.equal(env.ARCHIVE_BUCKET.values.size, 1);
  assert.equal((await store.get(firstLogin.id)).status, 'authenticated');
  const secondLogin = await store.beginLogin();
  await assert.rejects(store.get(firstLogin.id), hasCode('LOGIN_STALE'));
  await assert.rejects(store.save(state, 1, firstLogin.id), hasCode('LOGIN_STALE'));
  await store.save(state, 1, secondLogin.id);
  assert.equal((await store.load()).version, 2);
});

test('an interrupted login metadata update is repaired from the committed encrypted state', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const login = await store.beginLogin();
  await env.ARCHIVE_DB.prepare("UPDATE archive_login SET status='waiting' WHERE id=?").bind(login.id).run();
  await store.save({ cookies: [], origins: [] }, 0, login.id);
  await env.ARCHIVE_DB.prepare("UPDATE archive_login SET status='waiting',version=0 WHERE id=?").bind(login.id).run();
  assert.equal((await store.get(login.id)).status, 'authenticated');
});

test('cookie refresh preserves the login generation and fences stale object writers', async t => {
  const env = environment(t);
  const first = new SessionStore(env);
  const login = await first.beginLogin();
  await first.save({ cookies: [], origins: [] }, 0, login.id);
  const stale = new SessionStore(env);
  await stale.load();
  await first.load();
  assert.equal(await first.save({ cookies: [{ value: 'fresh' }], origins: [] }, 1), 1);
  assert.equal((await first.current()).version, 1);
  await assert.rejects(stale.save({ cookies: [{ value: 'old' }], origins: [] }, 1), hasCode('LOGIN_STALE'));
  assert.equal((await first.load()).storageState.cookies[0].value, 'fresh');
  assert.equal((await first.get(login.id)).status, 'authenticated');
});

test('source pagination uses publication creation time and raw group counts', () => {
  const payload = { publish_page: JSON.stringify({ total_count: 8, publish_list: [{ publish_info: JSON.stringify({ appmsgex: [
    { aid: '123_1', link: 'https://mp.weixin.qq.com/s?__biz=thebiz&mid=123&idx=1', title: 'first', create_time: 1700000000, update_time: 1800000000 },
    { aid: '123_2', link: 'https://mp.weixin.qq.com/s?__biz=thebiz&mid=123&idx=2', title: 'second', update_time: 1700000001 },
  ] }) }] }) };
  const result = normalizeSourcePage(payload, { fakeid: 'source' }, 0, 5);
  assert.equal(result.articles[0].published_at, 1700000000000);
  assert.equal(result.articles[0].source_key, 'wechat:thebiz:123:1');
  assert.equal(result.articles[1].published_at, null);
  assert.equal(result.articles[1].time_trusted, false);
  assert.equal(result.next_cursor, 1);
  assert.equal(result.has_more, true);
  assert.throws(() => normalizeSourcePage({ publish_page: { total_count: 8, publish_list: [] } }, { fakeid: 'source' }, 0, 5), hasCode('SOURCE_FORMAT_CHANGED'));
  assert.throws(() => normalizeSourcePage({ publish_page: {} }, { fakeid: 'source' }, 0, 5), hasCode('SOURCE_FORMAT_CHANGED'));
});

test('capture isolates source HTML and downloads, decodes, deduplicates every image', async () => {
  const fake = browserDouble(documentResult({ images: ['https://cdn.public.com/photo.png', 'https://cdn.public.com/photo.png'] }));
  const calls = [];
  const collector = createCollector({ playwright: fake.playwright, resolveHost: noDns, fetchImpl: async url => {
    calls.push(url);
    return url.endsWith('.png') ? new Response(png, { headers: { 'content-type': 'image/png' } })
      : new Response('<article><h1>example</h1><script>fetch("http://localhost")</script></article>', { headers: { 'content-type': 'text/html' } });
  } });
  const result = await collector.captureArticle({ ARCHIVE_BROWSER: {} }, { url: 'https://news.public.com/article' });
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.images[0].bytes, png);
  assert.equal(fake.calls.decodes, 1);
  assert.deepEqual(fake.calls.launches[0].guardrails.allowedDomains, []);
  assert.equal(fake.calls.contextOptions[0].javaScriptEnabled, false);
  assert.equal(fake.calls.closes, 1);
  assert.equal(calls.length, 2);
});

test('capture rejects incomplete images and verification shells, closing its browser', async t => {
  const fetchImpl = async url => url.endsWith('.png') ? new Response('<html>verification</html>', { headers: { 'content-type': 'text/html' } })
    : new Response('<html>article</html>', { headers: { 'content-type': 'text/html' } });
  const fake = browserDouble(documentResult({ images: ['https://cdn.public.com/photo.png'] }));
  await assert.rejects(createCollector({ playwright: fake.playwright, fetchImpl, resolveHost: noDns })
    .captureArticle({ ARCHIVE_BROWSER: {} }, { url: 'https://news.public.com/article' }), hasCode('IMAGE_INCOMPLETE'));
  assert.equal(fake.calls.closes, 1);
  const challenge = browserDouble(documentResult({ challenge: true }));
  await assert.rejects(createCollector({ playwright: challenge.playwright, fetchImpl, resolveHost: noDns })
    .captureArticle(environment(t), { url: 'https://mp.weixin.qq.com/s/article' }), hasCode('CHALLENGE_REQUIRED'));
  assert.equal(challenge.calls.closes, 1);
});

test('capture rejects an image that has a valid header but cannot be decoded', async () => {
  const fake = browserDouble(documentResult({ images: ['https://cdn.public.com/photo.png'] }));
  fake.calls.decodeResult = false;
  const collector = createCollector({ playwright: fake.playwright, resolveHost: noDns, fetchImpl: async url => new Response(url.endsWith('.png') ? png : '<html></html>', {
    headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'text/html' },
  }) });
  await assert.rejects(collector.captureArticle({ ARCHIVE_BROWSER: {} }, { url: 'https://news.public.com/article' }), hasCode('IMAGE_INCOMPLETE'));
});

test('computed CSS background images in article descendants prevent a false complete capture', async t => {
  const child = {};
  const root = {
    textContent: 'Article body', innerHTML: '<section>Article body</section>',
    querySelectorAll: selector => selector === '*' ? [child] : [],
    cloneNode: () => ({ textContent: 'Article body', querySelectorAll: () => [] }),
  };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
    if (oldStyle) Object.defineProperty(globalThis, 'getComputedStyle', oldStyle); else delete globalThis.getComputedStyle;
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    body: root, title: 'Article', querySelector: selector => selector === 'article, main, [role="main"]' ? root : null,
  } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: (element, pseudo) => ({
    backgroundImage: element === child && pseudo === '::before' ? 'url("https://cdn.public.com/background.png")' : 'none',
  }) });
  const extracted = extractArticleDocument({ url: 'https://news.public.com/article', wechat: false });
  assert.equal(extracted.unsupported_background, true);
  const fake = browserDouble(extracted);
  const collector = createCollector({ playwright: fake.playwright, resolveHost: noDns,
    fetchImpl: async () => new Response('<article>Article body</article>', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(collector.captureArticle({ ARCHIVE_BROWSER: {} }, { url: 'https://news.public.com/article' }), hasCode('IMAGE_INCOMPLETE'));
  assert.equal(fake.calls.closes, 1);
});

test('login completion verifies the backend before saving and reconnects by opaque ID', async t => {
  const env = environment(t);
  const fake = browserDouble();
  const collector = createCollector({ playwright: fake.playwright });
  const login = await collector.createLoginSession(env);
  assert.equal(login.status, 'waiting');
  assert.equal(fake.calls.acquisitions[0].keep_alive, 60000);
  assert.equal((await collector.createLoginSession(env)).session_id, login.session_id);
  assert.deepEqual(await collector.finishLoginSession(env, login.session_id), { authenticated: false, version: 0, purpose: 'account' });
  assert.equal(env.ARCHIVE_BUCKET.values.size, 0);
  fake.setUrl('https://mp.weixin.qq.com/cgi-bin/home?token=123456&lang=zh_CN');
  const complete = await collector.finishLoginSession(env, login.session_id);
  assert.deepEqual(complete, { authenticated: true, version: 1, purpose: 'account' });
  assert.equal((await collector.getLoginSession(env, login.session_id)).status, 'authenticated');
  assert.equal((await new SessionStore(env).load()).storageState.cookies[0].value, 'private-cookie');
  assert.equal([...env.ARCHIVE_BUCKET.values.values()][0].includes('private-cookie'), false);
  assert.ok(fake.calls.urls.some(url => url.includes('/cgi-bin/searchbiz?')));
  assert.deepEqual(await collector.finishLoginSession(env, login.session_id), { authenticated: true, version: 1, status: 'authenticated', expires_at: login.expires_at, purpose: 'account' });
  await assert.rejects(collector.getLoginScreenshot(env, login.session_id), hasCode('LOGIN_ALREADY_AUTHENTICATED'));
});

test('restoring saved cookies never substitutes for verifying actual backend login', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const login = await store.beginLogin();
  await store.save({ cookies: [], origins: [] }, 0, login.id);
  const fake = browserDouble();
  const collector = createCollector({ playwright: fake.playwright });
  await assert.rejects(collector.searchSources(env, 'example'), hasCode('LOGIN_EXPIRED'));
  assert.equal(fake.calls.closes, 1);
});

test('article verification opens only official articles and cannot complete on a challenge shell', async t => {
  const env = environment(t);
  const fake = browserDouble(documentResult({ challenge: true }));
  const collector = createCollector({ playwright: fake.playwright, resolveHost: noDns });
  await assert.rejects(collector.createLoginSession(env, { url: 'https://news.public.com/article' }), hasCode('INVALID_URL'));
  const login = await collector.createLoginSession(env, { url: 'https://mp.weixin.qq.com/s/article' });
  assert.equal(login.purpose, 'article');
  assert.deepEqual(await collector.finishLoginSession(env, login.session_id), { authenticated: false, version: 0, purpose: 'article' });
  assert.equal(env.ARCHIVE_BUCKET.values.size, 0);
  await assert.rejects(collector.createLoginSession(env), hasCode('LOGIN_BUSY'));
});

test('retrying a challenged WeChat article actually restores its verified browser state', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const login = await store.beginLogin({ purpose: 'article', target_url: 'https://mp.weixin.qq.com/s/article' });
  const savedState = { cookies: [{ name: 'verified', value: 'official-cookie', domain: 'mp.weixin.qq.com', path: '/' }], origins: [] };
  await store.save(savedState, 0, login.id);
  const fake = browserDouble([documentResult({ invalid: true, challenge: true }), documentResult()]);
  fake.setStorage(savedState);
  const collector = createCollector({ playwright: fake.playwright, resolveHost: noDns,
    fetchImpl: async () => new Response('<html>当前环境异常</html>', { headers: { 'content-type': 'text/html' } }) });
  const result = await collector.captureArticle(env, { url: 'https://mp.weixin.qq.com/s/article' });
  assert.equal(result.title, 'An article');
  assert.deepEqual(fake.calls.contextOptions[1].storageState, savedState);
  assert.ok(fake.calls.launches[1].guardrails.allowedDomains.includes('mp.weixin.qq.com'));
  assert.equal(fake.calls.launches[1].guardrails.allowedDomains.includes('*.qq.com'), false);
  assert.equal(fake.calls.closes, 2);
  assert.equal(fake.calls.urls.at(-1), 'https://mp.weixin.qq.com/s/article');
  let aborted = false;
  await fake.calls.contextRoute({ request: () => ({ url: () => 'http://127.0.0.1/private' }), abort: async () => { aborted = true; }, continue: async () => assert.fail('Unsafe request continued') });
  assert.equal(aborted, true);
});

test('a temporary browser connection failure preserves the current login task', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const login = await store.beginLogin();
  await store.attachBrowser(login, 'remote-browser-id', 'https://live.browser.run/ui/view?jwt=private');
  const collector = createCollector({ playwright: { connect: async () => { throw new Error('Temporary network failure'); } } });
  await assert.rejects(collector.getLoginSession(env, login.id), hasCode('UPSTREAM_ERROR'));
  assert.equal((await store.get(login.id)).status, 'waiting');
});

test('a confirmed missing remote browser expires its login and allows a new task', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const login = await store.beginLogin();
  await store.attachBrowser(login, 'remote-browser-id', 'https://live.browser.run/ui/view?jwt=private');
  const collector = createCollector({ playwright: { connect: async () => { throw new Error('Unable to connect to browser: code: 404'); } } });
  assert.equal((await collector.getLoginSession(env, login.id)).status, 'expired');
  assert.notEqual((await store.beginLogin()).id, login.id);
});

test('creating a login replaces a confirmed missing browser in the same request', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const previous = await store.beginLogin();
  await store.attachBrowser(previous, 'expired-browser', 'https://live.browser.run/ui/view?jwt=private');
  const fake = browserDouble();
  const connect = fake.playwright.connect;
  fake.playwright.connect = async (binding, options) => {
    if (options?.sessionId === 'expired-browser') throw new Error('Unable to connect to browser: code: 404');
    return connect(binding, options);
  };
  const collector = createCollector({ playwright: fake.playwright });
  const replaced = await collector.createLoginSession(env);
  assert.notEqual(replaced.session_id, previous.id);
  assert.equal(replaced.status, 'waiting');
  assert.equal(fake.calls.acquisitions.length, 1);
  assert.equal((await store.current()).active_login_id, replaced.session_id);
  assert.equal(env.ARCHIVE_DB.sqlite.prepare('SELECT status FROM archive_login WHERE id=?').get(previous.id).status, 'expired');
});

test('creating a login replaces a stale task while preserving the current login generation', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const previous = await store.beginLogin();
  await store.attachBrowser(previous, 'old-browser', 'https://live.browser.run/ui/view?jwt=private');
  const beginLogin = SessionStore.prototype.beginLogin;
  let advanced = false;
  t.mock.method(SessionStore.prototype, 'beginLogin', async function (input) {
    const login = await beginLogin.call(this, input);
    if (login.existing && !advanced) {
      advanced = true;
      env.ARCHIVE_DB.sqlite.prepare('UPDATE archive_session SET version=version+1 WHERE singleton=1').run();
    }
    return login;
  });
  const fake = browserDouble();
  const collector = createCollector({ playwright: fake.playwright });
  const replaced = await collector.createLoginSession(env);
  assert.notEqual(replaced.session_id, previous.id);
  assert.equal(replaced.status, 'waiting');
  assert.equal(fake.calls.acquisitions.length, 1);
  assert.equal((await store.current()).version, 1);
  assert.equal((await store.get(replaced.session_id)).version, 1);
  assert.equal(env.ARCHIVE_DB.sqlite.prepare('SELECT status FROM archive_login WHERE id=?').get(previous.id).status, 'stale');
});

test('creating a login preserves its task when reconnecting has only a temporary network failure', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const login = await store.beginLogin();
  await store.attachBrowser(login, 'remote-browser-id', 'https://live.browser.run/ui/view?jwt=private');
  let acquisitions = 0;
  const collector = createCollector({ playwright: {
    connect: async () => { throw new Error('Temporary network failure'); },
    acquire: async () => { acquisitions++; throw new Error('Must not replace the current browser'); },
  } });
  await assert.rejects(collector.createLoginSession(env), hasCode('UPSTREAM_ERROR'));
  assert.equal((await store.get(login.id)).status, 'waiting');
  assert.equal((await store.current()).active_login_id, login.id);
  assert.equal(acquisitions, 0);
});

test('a failed login rebuild is attempted only once within one request', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const login = await store.beginLogin();
  await store.attachBrowser(login, 'expired-browser', 'https://live.browser.run/ui/view?jwt=private');
  let acquisitions = 0;
  const collector = createCollector({ playwright: {
    connect: async () => { throw new Error('Unable to connect to browser: code: 404'); },
    acquire: async () => { acquisitions++; throw new Error('Temporary network failure'); },
  } });
  await assert.rejects(collector.createLoginSession(env), hasCode('UPSTREAM_ERROR'));
  assert.equal(acquisitions, 1);
  assert.equal(env.ARCHIVE_DB.sqlite.prepare('SELECT COUNT(*) AS count FROM archive_login').get().count, 2);
  assert.equal((await store.current()).active_login_id, null);
});

test('daily browser quota errors wait until the next UTC day without becoming article failures', () => {
  const now = Date.parse('2026-10-20T23:59:00Z');
  const error = classifyCollectorError(new Error('Unable to create new browser: code: 429: message: Browser time limit exceeded for today'), now);
  assert.equal(error.code, 'BROWSER_QUOTA_EXCEEDED');
  assert.equal(error.retryable, false);
  assert.equal(error.quota, 'browser_time');
  assert.equal(error.retry_at, Date.parse('2026-10-21T00:00:00Z'));
  assert.equal(classifyCollectorError(error), error);
  assert.equal(classifyCollectorError(new Error('Unable to connect to browser: code: 429: message: Too many concurrent browsers')).code, 'RATE_LIMITED');
});

test('capture preserves the browser quota classification from the actual SDK error shape', async () => {
  const collector = createCollector({
    playwright: { launch: async () => { throw new Error('Unable to create new browser: code: 429: message: Browser time limit exceeded for today'); } },
    resolveHost: noDns,
    fetchImpl: async () => new Response('<article>An article</article>', { headers: { 'content-type': 'text/html' } }),
  });
  await assert.rejects(collector.captureArticle({ ARCHIVE_BROWSER: {} }, { url: 'https://news.public.com/article' }), error =>
    error.code === 'BROWSER_QUOTA_EXCEEDED' && error.retry_at > Date.now());
});

test('capture caches DNS per hostname only within that capture and checks redirect hosts', async () => {
  const fake = browserDouble(documentResult({ images: ['https://cdn.public.com/one.png', 'https://cdn.public.com/two.png'] }));
  const requests = [];
  const collector = createCollector({ playwright: fake.playwright, fetchImpl: async value => {
    const url = new URL(value);
    requests.push(url.href);
    if (url.hostname === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: [
      url.searchParams.get('type') === 'A' ? { type: 1, data: '8.8.8.8' } : { type: 28, data: '2606:4700:4700::1111' },
    ] });
    if (url.pathname === '/one.png') return new Response('', { status: 302, headers: { location: 'https://other.public.com/photo.png' } });
    if (url.pathname.endsWith('.png')) return new Response(png, { headers: { 'content-type': 'image/png' } });
    return new Response('<article>A complete body</article>', { headers: { 'content-type': 'text/html' } });
  } });
  await collector.captureArticle({ ARCHIVE_BROWSER: {} }, { url: 'https://news.public.com/article' });
  const dns = requests.filter(url => url.includes('cloudflare-dns.com'));
  assert.equal(dns.length, 6);
  for (const hostname of ['news.public.com', 'cdn.public.com', 'other.public.com']) {
    assert.equal(dns.filter(url => new URL(url).searchParams.get('name') === hostname).length, 2);
  }
  assert.equal(requests.length, 10);
  await collector.captureArticle({ ARCHIVE_BROWSER: {} }, { url: 'https://news.public.com/article' });
  assert.equal(requests.filter(url => url.includes('cloudflare-dns.com')).length, 12);
});

test('image resources retain public-address, redirect, content and size restrictions', async () => {
  const requests = [];
  await assert.rejects(fetchImageResource('https://cdn.public.com/photo.png', {
    resolveHost: noDns,
    fetchImpl: async url => {
      requests.push(url);
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    },
  }), hasCode('UNSAFE_URL'));
  assert.equal(requests.length, 1);
  await assert.rejects(fetchImageResource('https://cdn.public.com/photo.png', {
    resolveHost: async () => { throw new CollectorError('UNSAFE_URL', 'Private DNS answer'); },
    fetchImpl: async () => assert.fail('Private DNS must prevent the image request'),
  }), hasCode('UNSAFE_URL'));
  await assert.rejects(fetchImageResource('https://cdn.public.com/photo.png', {
    resolveHost: noDns,
    fetchImpl: async () => new Response('<html>Verify</html>', { headers: { 'content-type': 'text/html' } }),
  }), hasCode('IMAGE_INCOMPLETE'));
  await assert.rejects(fetchImageResource('https://cdn.public.com/photo.png', {
    resolveHost: noDns,
    fetchImpl: async () => new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(IMAGE_LIMIT + 1) } }),
  }), hasCode('RESOURCE_TOO_LARGE'));
});

test('many images use separate cloud requests while the parent fetch budget remains bounded', async () => {
  const urls = Array.from({ length: 60 }, (_, index) => `https://cdn.public.com/${index}.png`);
  const fake = browserDouble(documentResult({ images: [...urls, urls[0]] }));
  const parentRequests = [];
  const imageRequests = new Map();
  const routeIds = [];
  const dns = value => {
    const url = new URL(value);
    return url.hostname === 'cloudflare-dns.com' ? Response.json({ Status: 0, Answer: [
      url.searchParams.get('type') === 'A' ? { type: 1, data: '8.8.8.8' } : { type: 28, data: '2606:4700:4700::1111' },
    ] }) : null;
  };
  const collector = createCollector({ playwright: fake.playwright, fetchImpl: async value => {
    parentRequests.push(value);
    assert.ok(parentRequests.length <= 50, 'Parent external request budget exceeded');
    const response = dns(value);
    if (response) return response;
    assert.equal(new URL(value).hostname, 'news.public.com', 'Parent must not fetch article images');
    return new Response('<article>A complete body</article>', { headers: { 'content-type': 'text/html' } });
  } });
  const env = { ARCHIVE_BROWSER: {}, ARCHIVE_EXECUTOR: { getByName(id) {
    routeIds.push(id);
    return { async fetchImage(url) {
      const requests = [];
      imageRequests.set(url, requests);
      const value = await fetchImageResource(url, { fetchImpl: async request => {
        requests.push(request);
        assert.ok(requests.length <= 50, 'Image external request budget exceeded');
        return dns(request) || new Response(png, { headers: { 'content-type': 'image/png' } });
      } });
      return structuredClone({ ok: true, value });
    } };
  } } };
  const captured = await collector.captureArticle(env, { url: 'https://news.public.com/article' });
  assert.equal(parentRequests.length, 3);
  assert.equal(captured.images.length, 60);
  assert.equal(fake.calls.decodes, 60);
  assert.equal(imageRequests.size, 60);
  assert.ok([...imageRequests.values()].every(requests => requests.length === 3));
  assert.equal(new Set(routeIds).size, 60);
  assert.equal(routeIds[0], await imageResourceId(urls[0]));
  assert.equal(await imageResourceId(`${urls[0]}#ignored`), routeIds[0]);
});

test('image RPC errors and invalid payloads cannot produce a complete capture', async () => {
  const fake = browserDouble(documentResult({ images: ['https://cdn.public.com/photo.png#fragment'] }));
  const collector = createCollector({ playwright: fake.playwright, resolveHost: noDns,
    fetchImpl: async () => new Response('<article>A complete body</article>', { headers: { 'content-type': 'text/html' } }) });
  let response = { ok: false, error: { code: 'UNSAFE_URL', message: 'Private redirect', retryable: false } };
  const env = { ARCHIVE_BROWSER: {}, ARCHIVE_EXECUTOR: { getByName: () => ({ fetchImage: async url => {
    assert.equal(url, 'https://cdn.public.com/photo.png', 'Resource binding must receive the same normalized URL as its hashed ID');
    return response;
  } }) } };
  await assert.rejects(collector.captureArticle(env, { url: 'https://news.public.com/article' }), hasCode('UNSAFE_URL'));
  response = { ok: true, value: { bytes: png.buffer, contentType: 'image/png' } };
  assert.equal((await collector.captureArticle(env, { url: 'https://news.public.com/article' })).images.length, 1);
  response = { ok: true, value: { bytes: new Uint8Array(IMAGE_LIMIT + 1), contentType: 'image/png' } };
  await assert.rejects(collector.captureArticle(env, { url: 'https://news.public.com/article' }), hasCode('RESOURCE_TOO_LARGE'));
});

test('private login diagnostics remove URLs, queries and authentication values', () => {
  const value = collectorDiagnostic(new Error('Failed https://mp.weixin.qq.com/s/private?token=secret-token\n?jwt=secret-jwt\nAuthorization: Bearer secret-bearer\nCookie: first=secret-cookie; second=private-cookie\ntoken="short-secret"\nSessionId: private-session\nrandom ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n' + 'x'.repeat(800)));
  for (const secret of ['https://', 'private?token', 'secret-token', 'secret-jwt', 'secret-bearer', 'secret-cookie', 'private-cookie', 'short-secret', 'private-session', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
    assert.equal(value.includes(secret), false, secret);
  }
  assert.ok(value.length <= 400);
});

test('login failure records a private phase and diagnostic without changing the public message', async t => {
  const env = environment(t);
  const collector = createCollector({ playwright: {
    acquire: async () => { throw new Error('Protocol unsupported at https://private.example/path?token=secret-token'); },
  } });
  await assert.rejects(collector.createLoginSession(env), error => {
    assert.equal(error.code, 'UPSTREAM_ERROR');
    assert.equal(error.message, '云端采集暂时失败，请稍后重试');
    assert.equal(error.phase, 'acquire');
    assert.equal(error.diagnostic, 'Protocol unsupported at [url]');
    return true;
  });
  assert.equal((await env.ARCHIVE_DB.prepare('SELECT status FROM archive_login').first()).status, 'failed');
});

test('login navigation diagnostics distinguish DNS rejection from route continuation errors', async t => {
  for (const stage of ['dns', 'continue', 'allowlist']) {
    const env = environment(t);
    const fake = browserDouble();
    const browser = await fake.playwright.connect();
    const context = await browser.newContext({});
    const page = await context.newPage();
    page.goto = async () => {
      await fake.calls.contextRoute({
        request: () => ({ url: () => stage === 'allowlist' ? 'https://untrusted.public.com/path?token=private-token' : 'https://mp.weixin.qq.com/?token=private-token' }),
        continue: async () => { if (stage === 'continue') throw new Error('Private protocol details'); },
        abort: async () => {},
      });
      throw new Error('page.goto: net::ERR_FAILED at https://mp.weixin.qq.com/?token=private-token');
    };
    const collector = createCollector({ playwright: fake.playwright, resolveHost: async () => {
      if (stage === 'dns') throw new CollectorError('UPSTREAM_ERROR', 'Private resolver details');
    } });
    await assert.rejects(collector.createLoginSession(env), error => {
      assert.equal(error.phase, 'goto');
      assert.equal(error.diagnostic.includes('private-token'), false);
      assert.equal(error.diagnostic.includes('Private'), false);
      assert.equal(error.diagnostic.includes('mp.weixin.qq.com') || stage === 'allowlist', true);
      assert.ok(error.diagnostic.includes(`"stage":"${stage}"`), error.diagnostic);
      assert.ok(error.diagnostic.includes(stage === 'dns' ? 'UPSTREAM_ERROR' : stage === 'continue' ? 'ROUTE_CONTINUE_FAILED' : 'DOMAIN_NOT_ALLOWED'));
      return true;
    });
  }
});

test('unknown DNS errors include a bounded private diagnostic for execution-context failures', async t => {
  const env = environment(t);
  const fake = browserDouble();
  const browser = await fake.playwright.connect();
  const page = await (await browser.newContext({})).newPage();
  page.goto = async () => {
    await fake.calls.contextRoute({
      request: () => ({ url: () => 'https://mp.weixin.qq.com/?token=secret-token' }),
      continue: async () => assert.fail('Failed DNS must never continue navigation'), abort: async () => {},
    });
    throw new Error('page.goto: net::ERR_FAILED at https://mp.weixin.qq.com/?token=secret-token');
  };
  const collector = createCollector({ playwright: fake.playwright, resolveHost: async () => {
    throw new Error('Cannot perform I/O on behalf of a different request: https://cloudflare-dns.com/dns-query?token=secret-token\nCookie: private-cookie\n' + 'diagnostic '.repeat(30));
  } });
  await assert.rejects(collector.createLoginSession(env), error => {
    assert.equal(error.phase, 'goto');
    assert.ok(error.diagnostic.includes('DNS_REQUEST_FAILED'));
    assert.ok(error.diagnostic.includes('Cannot perform I/O on behalf of a different request'));
    assert.equal(error.diagnostic.includes('secret-token'), false);
    assert.equal(error.diagnostic.includes('private-cookie'), false);
    assert.equal(error.diagnostic.includes('https://'), false);
    assert.ok(error.diagnostic.length <= 400);
    return true;
  });
});

test('human login survives successive connections without an incognito context', async t => {
  const env = environment(t);
  const fake = browserDouble();
  const browser = await fake.playwright.connect();
  const connect = fake.playwright.connect;
  fake.calls.connections.length = 0;
  browser.newContext = async () => assert.fail('A detached incognito context cannot host human login');
  fake.playwright.connect = async (binding, options) => {
    assert.equal(options?.persistent, true, 'Reconnect must discover existing default-context pages');
    return connect(binding, options);
  };
  const collector = createCollector({ playwright: fake.playwright });
  const login = await collector.createLoginSession(env);
  for (let poll = 0; poll < 3; poll++) {
    assert.equal((await collector.getLoginSession(env, login.session_id)).status, 'waiting');
    const screenshot = await collector.getLoginScreenshot(env, login.session_id);
    assert.equal(screenshot.status, 200);
    assert.equal((await screenshot.arrayBuffer()).byteLength, png.byteLength);
  }
  assert.equal(fake.calls.acquisitions.length, 1);
  assert.equal(fake.calls.connections.length, 7);
  assert.equal((await new SessionStore(env).get(login.session_id)).status, 'waiting');
});

test('a stale expiration cannot replace authenticated state or release a newer login', async t => {
  const env = environment(t);
  const store = new SessionStore(env);
  const login = await store.beginLogin();
  await store.save({ cookies: [], origins: [] }, 0, login.id);
  for (const status of ['expired', 'failed', 'stale']) assert.equal(await store.mark(login.id, status), false);
  assert.equal((await store.get(login.id)).status, 'authenticated');
  const next = await store.beginLogin();
  assert.equal(await store.mark(login.id, 'expired'), false);
  assert.equal((await store.current()).active_login_id, next.id);
  assert.equal((await env.ARCHIVE_DB.prepare('SELECT status FROM archive_login WHERE id=?').bind(login.id).first()).status, 'authenticated');
});

for (const operation of ['getLoginSession', 'getLoginScreenshot']) {
  test(`an older ${operation} reconnect failure cannot undo a completed login`, async t => {
    const env = environment(t);
    const fake = browserDouble();
    const collector = createCollector({ playwright: fake.playwright });
    const login = await collector.createLoginSession(env);
    const connect = fake.playwright.connect;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let rejectPoll;
    let reconnects = 0;
    fake.playwright.connect = async (...args) => {
      if (++reconnects === 1) {
        entered();
        return new Promise((_resolve, reject) => { rejectPoll = reject; });
      }
      return connect(...args);
    };
    const pending = collector[operation](env, login.session_id);
    // Attach both rejection and resolution observers before releasing the race.
    const observed = pending.then(value => ({ value }), error => ({ error }));
    await started;
    fake.setUrl('https://mp.weixin.qq.com/cgi-bin/home?token=123456');
    assert.equal((await collector.finishLoginSession(env, login.session_id)).authenticated, true);
    rejectPoll(new Error('Unable to connect to browser: code: 404: Browser session not found'));
    const result = await observed;
    if (operation === 'getLoginSession') assert.equal(result.value?.status, 'authenticated');
    else assert.equal(result.error?.code, 'LOGIN_ALREADY_AUTHENTICATED');
    assert.equal((await new SessionStore(env).get(login.session_id)).status, 'authenticated');
  });
}

test('authentication committed between a poll recheck and expiration CAS still wins', async t => {
  const env = environment(t);
  const fake = browserDouble();
  const collector = createCollector({ playwright: fake.playwright });
  const login = await collector.createLoginSession(env);
  const batch = env.ARCHIVE_DB.batch.bind(env.ARCHIVE_DB);
  let committed = false;
  env.ARCHIVE_DB.batch = async statements => {
    if (!committed) {
      committed = true;
      await new SessionStore(env).save({ cookies: [], origins: [] }, 0, login.session_id);
    }
    return batch(statements);
  };
  fake.playwright.connect = async () => { throw new Error('Browser session not found'); };
  assert.equal((await collector.getLoginSession(env, login.session_id)).status, 'authenticated');
  assert.equal((await new SessionStore(env).get(login.session_id)).status, 'authenticated');
});

test('a poll operation interrupted by successful confirmation returns authenticated state', async t => {
  const env = environment(t);
  const fake = browserDouble();
  const collector = createCollector({ playwright: fake.playwright });
  const login = await collector.createLoginSession(env);
  const context = (await fake.playwright.connect()).contexts()[0];
  fake.setUrl('https://mp.weixin.qq.com/cgi-bin/home?token=123456');
  context.newCDPSession = async () => ({ send: async () => {
    await collector.finishLoginSession(env, login.session_id);
    throw new Error('Target closed after confirmation');
  } });
  assert.equal((await collector.getLoginSession(env, login.session_id)).status, 'authenticated');
  assert.equal((await new SessionStore(env).get(login.session_id)).status, 'authenticated');
});
