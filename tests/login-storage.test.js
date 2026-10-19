import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { restoreLoginStorage } from '../src/archive/login-storage.js';

const origin = 'https://mp.weixin.qq.com';
const state = () => ({
  cookies: [{ name: 'synthetic-auth', value: 'test-only', domain: '.weixin.qq.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: -1 }],
  origins: [{ origin, localStorage: [{ name: 'test-token', value: 'synthetic-only' }], indexedDB: [] }],
});

function contextDouble() {
  const calls = [];
  let handler;
  const frame = {};
  const page = {
    mainFrame: () => frame,
    route: async (pattern, callback) => { handler = callback; calls.push(['route', pattern]); },
    unroute: async (pattern, callback) => { assert.equal(callback, handler); calls.push(['unroute', pattern]); },
    goto: async (url) => {
      calls.push(['goto', url]);
      await handler({ request: () => ({ url: () => url, isNavigationRequest: () => true, frame: () => frame }),
        fulfill: async (response) => { calls.push(['fulfill', response]); }, abort: async () => assert.fail('Preparation navigation was not fulfilled') });
    },
    evaluate: async (_restore, input) => { calls.push(['restore', input]); },
    close: async () => { calls.push(['close']); },
  };
  const context = {
    clearCookies: async () => { calls.push(['clearCookies']); },
    addCookies: async (cookies) => { calls.push(['addCookies', cookies]); },
    newPage: async () => { calls.push(['newPage']); return page; },
  };
  return { calls, context, page };
}

test('storage restoration fulfills blank same-origin pages and removes its temporary page and route', async () => {
  const fake = contextDouble();
  const input = state();
  await restoreLoginStorage(fake.context, input);
  assert.deepEqual(fake.calls.map(([action]) => action), ['clearCookies', 'addCookies', 'newPage', 'route', 'goto', 'fulfill', 'restore', 'unroute', 'close']);
  assert.deepEqual(fake.calls.find(([action]) => action === 'addCookies')[1], input.cookies);
  assert.equal(fake.calls.find(([action]) => action === 'goto')[1], `${origin}/`);
  assert.deepEqual(fake.calls.find(([action]) => action === 'restore')[1], input.origins[0]);
});

test('invalid, private and nonofficial state is rejected before modifying the context', async () => {
  const invalid = [
    { ...state(), origins: [{ origin: 'http://mp.weixin.qq.com', localStorage: [] }] },
    { ...state(), origins: [{ origin: 'https://unrelated.example.com', localStorage: [] }] },
    { ...state(), cookies: [{ ...state().cookies[0], domain: '.unrelated.example.com' }] },
    { ...state(), origins: [{ origin: 'https://mp.weixin.qq.com/path', localStorage: [] }] },
    { ...state(), origins: [...state().origins, ...state().origins] },
  ];
  for (const input of invalid) {
    const fake = contextDouble();
    await assert.rejects(restoreLoginStorage(fake.context, input), { code: 'INVALID_STORAGE_STATE' });
    assert.deepEqual(fake.calls, []);
  }
  const fake = contextDouble();
  await assert.rejects(restoreLoginStorage(fake.context, { cookies: [], origins: [{ origin: 'https://127.0.0.1', localStorage: [] }] },
    { isAllowedOrigin: () => true }), { code: 'UNSAFE_URL' });
  assert.deepEqual(fake.calls, []);
});

test('restore failure is propagated after cleaning the preparation route and page', async () => {
  const fake = contextDouble();
  fake.page.evaluate = async () => { throw new Error('Synthetic IndexedDB restore failure'); };
  await assert.rejects(restoreLoginStorage(fake.context, state()), /Synthetic IndexedDB/);
  assert.deepEqual(fake.calls.slice(-2).map(([action]) => action), ['unroute', 'close']);
});

test('cookie-only state needs no preparation page', async () => {
  const fake = contextDouble();
  await restoreLoginStorage(fake.context, { cookies: state().cookies, origins: [] });
  assert.deepEqual(fake.calls.map(([action]) => action), ['clearCookies', 'addCookies']);
});

const chrome = [process.env.ARCHIVE_SMOKE_CHROME, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', chromium.executablePath()].find((path) => path && existsSync(path));

test('real Chrome restores cookies, localStorage and encoded IndexedDB into a persistent default context', { skip: !chrome && 'No local Chrome is installed; this test never downloads browsers' }, async (t) => {
  const target = await chromium.launchPersistentContext('', { executablePath: chrome, headless: true,
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  t.after(() => target.close());
  let blockedRequests = 0;
  await target.route('**/*', async (route) => { blockedRequests++; await route.abort(); });
  const source = await target.browser().newContext({ serviceWorkers: 'block' });
  t.after(() => source.close());
  const sourceOrigin = 'https://storage-fixture.example.com';
  const otherOrigin = 'https://other-fixture.example.com';
  await source.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }));
  await source.addCookies([{ name: 'synthetic-auth', value: 'test-only', domain: 'storage-fixture.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await source.newPage();
  await page.goto(sourceOrigin);
  await page.evaluate(async () => {
    localStorage.setItem('test-token', 'synthetic-only');
    const request = indexedDB.open('synthetic-login-state', 3);
    const database = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const records = request.result.createObjectStore('records', { keyPath: 'id', autoIncrement: true });
        records.createIndex('by-label', 'label', { unique: true });
        const compound = request.result.createObjectStore('compound', { keyPath: ['tenant', 'id'] });
        compound.createIndex('by-tags', 'tags', { multiEntry: true });
        request.result.createObjectStore('encoded');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['records', 'compound', 'encoded'], 'readwrite');
    transaction.objectStore('records').add({ label: 'synthetic', token: 'test-only' });
    transaction.objectStore('compound').add({ tenant: 'test', id: 7, tags: ['one', 'two'] });
    const encoded = { date: new Date('2026-01-01T00:00:00Z'), bytes: new Uint16Array([1, 65535]), big: 12345678901234567890n, regexp: /synthetic/gi };
    encoded.self = encoded;
    transaction.objectStore('encoded').put(encoded, new Date('2026-02-01T00:00:00Z'));
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); });
    database.close();
  });
  await page.goto(otherOrigin);
  await page.evaluate(() => localStorage.setItem('other-token', 'second-origin'));
  const saved = await source.storageState({ indexedDB: true });
  assert.equal(saved.origins.length, 2);
  const pagesBefore = target.pages().length;
  const isAllowedOrigin = (value) => [sourceOrigin, otherOrigin].includes(value);
  await restoreLoginStorage(target, saved, { isAllowedOrigin });
  assert.equal(target.pages().length, pagesBefore);
  const restored = await target.storageState({ indexedDB: true });
  const byOrigin = (a, b) => a.origin.localeCompare(b.origin);
  assert.deepEqual(restored.cookies, saved.cookies);
  assert.deepEqual(restored.origins.sort(byOrigin), saved.origins.sort(byOrigin));
  assert.equal(blockedRequests, 0, 'All preparation and snapshot navigations must be fulfilled without outside requests');
});
