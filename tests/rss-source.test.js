import assert from 'node:assert/strict';
import test from 'node:test';
import { createRssSource, loadRssArticle, RSS_ACCOUNT_BIZ, RSS_FEED_URL, RSS_STATE_KEY } from '../src/archive/rss-source.js';
import { CollectorError } from '../src/archive/collector-security.js';

const NOW = Date.parse('2026-10-19T14:00:00Z');
const DATE = 'Sun, 18 Oct 2026 22:37:00 +0800';
const URL = `https://mp.weixin.qq.com/s?__biz=${RSS_ACCOUNT_BIZ}&mid=2247498657&idx=1&sn=synthetic`;
const IMAGE = 'https://mmbiz.qpic.cn/mmbiz_png/synthetic/640?wx_fmt=png&from=appmsg';
const encode = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const proxy = (url = IMAGE, host = 'wechat2rss.xlab.app', path = '/img-proxy/') => `https://${host}${path}?k=synthetic&u=${encodeURIComponent(url)}`;
function item({ url = URL, date = DATE, title = 'Synthetic article', html = `<p>Complete body</p><img src="${encode(proxy())}">`, author = '' } = {}) {
  return `<item><title>${encode(title)}</title><link>${encode(url)}</link><content:encoded><![CDATA[${html}]]></content:encoded><pubDate>${date}</pubDate>${author ? `<dc:creator>${encode(author)}</dc:creator>` : ''}</item>`;
}
const feed = (items = item(), name = '猫笔刀') => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${name}</title>${items}</channel></rss>`;
function fixture(xml = feed(), options = {}) {
  const objects = new Map();
  const calls = [];
  const puts = [];
  const env = { ARCHIVE_BUCKET: {
    async put(key, body, metadata) {
      puts.push({ key, metadata });
      if (options.failPut === puts.length) throw new Error('R2 unavailable');
      objects.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body));
    },
    async get(key) {
      if (!objects.has(key)) return null;
      const body = objects.get(key);
      return { size: new TextEncoder().encode(body).byteLength, text: async () => body };
    },
  } };
  const source = createRssSource({ now: options.now || (() => NOW), resolveHost: async host => {
    assert.equal(host, 'wechat2rss.xlab.app');
    if (options.dnsError) throw options.dnsError;
  }, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return options.response ? options.response() : new Response(typeof xml === 'function' ? xml() : xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
  } });
  return { source, env, objects, calls, puts };
}
const code = expected => error => error instanceof CollectorError && error.code === expected;

test('all twenty full bodies are saved privately before metadata is returned, without any image or browser request', async () => {
  const f = fixture(feed(Array.from({ length: 20 }, (_, index) => item({ url: URL.replace('2247498657', String(2247498657 - index)), title: `Article ${index}`, author: 'Synthetic author' })).join('')));
  const result = await f.source.fetchSource(f.env, { account_biz: RSS_ACCOUNT_BIZ });
  assert.equal(result.articles.length, 20);
  assert.equal(f.objects.size, 22);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, RSS_FEED_URL);
  assert.equal(f.calls[0].init.redirect, 'manual');
  assert.equal(f.calls[0].init.headers.cookie, undefined);
  assert.equal(result.fetched_at, NOW);
  const manifest = JSON.parse(f.objects.get(RSS_STATE_KEY));
  assert.deepEqual(manifest.articles, result.articles);
  assert.equal(manifest.coverage_start, Date.parse(DATE));
  assert.equal(manifest.coverage_end, Date.parse(DATE));
  assert.equal(f.puts.at(-1).key, RSS_STATE_KEY);
  assert.equal(f.objects.get(result.snapshot_key), feed(Array.from({ length: 20 }, (_, index) => item({ url: URL.replace('2247498657', String(2247498657 - index)), title: `Article ${index}`, author: 'Synthetic author' })).join('')));
  for (const article of result.articles) {
    assert.equal(article.time_trusted, true);
    assert.equal(article.published_at, Date.parse(DATE));
    assert.equal(article.metadata.source_kind, 'rss');
    assert.match(article.metadata.rss_snapshot_key, /^private\/rss\/articles\/[a-f0-9]{64}\.json$/);
    assert.equal(article.status, undefined);
    const saved = JSON.parse(f.objects.get(article.metadata.rss_snapshot_key));
    assert.match(saved.raw_html, /Complete body/);
    assert.match(saved.raw_html, /img-proxy/);
    assert.deepEqual(saved.images, [IMAGE]);
    assert.equal(saved.author, 'Synthetic author');
  }
  assert.ok(f.puts.every(put => put.metadata.httpMetadata.cacheControl === 'private, no-store'));
});

test('a saved body loads after its rolling feed disappears and returns only source image URLs', async () => {
  const f = fixture();
  const result = await f.source.fetchSource(f.env);
  f.objects.delete(result.snapshot_key);
  const doc = await loadRssArticle(f.env, result.articles[0]);
  assert.equal(doc.title, 'Synthetic article');
  assert.equal(doc.author, '猫笔刀');
  assert.equal(doc.source_name, '猫笔刀');
  assert.equal(doc.published_at, Date.parse(DATE));
  assert.match(doc.text, /Complete body/);
  assert.doesNotMatch(doc.html, /img-proxy/);
  assert.match(doc.html, /mmbiz\.qpic\.cn/);
  assert.deepEqual(doc.images, [{ source_url: IMAGE }]);
  assert.equal(doc.images[0].bytes, undefined);
  assert.equal(doc.original_url, URL);
  assert.equal(doc.source_key, `wechat:${RSS_ACCOUNT_BIZ}:2247498657:1`);
  assert.equal(f.calls.length, 1);
});

test('known image proxies are decoded once and lazy original image attributes are normalized', async () => {
  const emoji = 'https://res.wx.qq.com/t/wx_fed/we-emoji/res/assets/Expression/synthetic.png';
  const f = fixture(feed(item({ html: `<p>Text</p><img src="${IMAGE}" data-src="${encode(proxy(emoji))}" srcset="https://invalid.example/image 2x"><img src="${IMAGE}"><img src="${IMAGE}">` })));
  const result = await f.source.fetchSource(f.env);
  const doc = await loadRssArticle(f.env, result.articles[0]);
  assert.deepEqual(doc.images, [{ source_url: emoji }, { source_url: IMAGE }]);
  assert.doesNotMatch(doc.html, /data-src|srcset|img-proxy/);
  assert.equal((doc.html.match(/<img/g) || []).length, 3);
});

test('foreign targets, duplicate identity parameters and malformed source identities reject the feed before storage', async () => {
  for (const url of [URL.replace(RSS_ACCOUNT_BIZ, 'OtherAccount=='), URL.replace('mp.weixin.qq.com', 'evil.example'),
    URL.replace('https:', 'http:'), URL + '&__biz=OtherAccount', URL + '&mid=5', URL.replace('idx=1', 'idx=0'),
    'https://mp.weixin.qq.com/s/short-link', 'https://127.0.0.1/s']) {
    const f = fixture(feed(item({ url })));
    await assert.rejects(f.source.fetchSource(f.env));
    assert.equal(f.objects.size, 0);
  }
});

test('missing and timezone-less publication dates never become trusted timestamps', async () => {
  for (const date of ['', 'not a date', '2026-10-18 22:37:00', 'Sun, 18 Oct 2026 22:37:00',
    'Sun, 30 Feb 2026 22:37:00 +0800', 'Sun, 18 Oct 2026 24:00:00 +0800', 'Sun, 18 Oct 2026 22:37:00 +2460']) {
    const f = fixture(feed(item({ date })));
    await assert.rejects(f.source.fetchSource(f.env), code('RSS_TIME_INVALID'));
    assert.equal(f.objects.size, 0);
  }
});

test('DTD and entity declarations are rejected without expansion or writes', async () => {
  for (const declaration of ['<!DOCTYPE rss [<!ENTITY payload "expanded">]>', '<!ENTITY payload SYSTEM "https://internal.invalid/private">']) {
    const f = fixture(declaration + feed());
    await assert.rejects(f.source.fetchSource(f.env), code('RSS_INVALID'));
    assert.equal(f.objects.size, 0);
    assert.equal(f.calls.length, 1);
  }
});

test('wrong channel, missing full content, duplicate entries and more than one hundred articles are rejected', async () => {
  for (const xml of [feed(''), feed(item(), 'Other source'), feed().replace(/<content:encoded>[\s\S]*?<\/content:encoded>/, ''),
    feed(item() + item()), feed(Array.from({ length: 101 }, (_, index) => item({ url: URL.replace('2247498657', String(index + 1)) })).join(''))]) {
    const f = fixture(xml);
    await assert.rejects(f.source.fetchSource(f.env));
    assert.equal(f.objects.size, 0);
  }
});

test('image proxies never authorize arbitrary hosts, nested proxies, private URLs or duplicate destinations', async () => {
  for (const image of [proxy('https://127.0.0.1/image'), proxy('https://evil.example/image'), proxy(proxy()),
    proxy(IMAGE, 'other.example'), proxy(IMAGE, 'wechat2rss.xlab.app', '/other-proxy/'),
    `${proxy()}&u=${encodeURIComponent(IMAGE)}`, 'data:image/png;base64,AA==', 'https://mmbiz.qpic.cn.evil.example/x']) {
    const f = fixture(feed(item({ html: `<p>Text</p><img src="${encode(image)}">` })));
    await assert.rejects(f.source.fetchSource(f.env));
    assert.equal(f.objects.size, 0);
    assert.equal(f.calls.length, 1);
  }
});

test('feed redirects, wrong content types and declared or streaming oversize responses cannot write snapshots', async () => {
  for (const response of [() => new Response('', { status: 302, headers: { location: 'https://other.example/feed' } }),
    () => new Response(feed(), { headers: { 'content-type': 'text/html' } }),
    () => new Response('', { headers: { 'content-type': 'application/xml', 'content-length': String(4 * 1024 * 1024 + 1) } }),
    () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/xml' } })]) {
    const f = fixture(feed(), { response });
    await assert.rejects(f.source.fetchSource(f.env));
    assert.equal(f.objects.size, 0);
    assert.equal(f.calls.length, 1);
  }
});

test('unsupported background images preserve the raw snapshot but never produce a completed capture document', async () => {
  const f = fixture(feed(item({ html: `<p style="background-image:url('${IMAGE}')">Body text</p>` })));
  const result = await f.source.fetchSource(f.env);
  assert.equal(result.articles.length, 1);
  assert.equal(JSON.parse(f.objects.get(result.articles[0].metadata.rss_snapshot_key)).unsupported_background, true);
  await assert.rejects(loadRssArticle(f.env, result.articles[0]), code('IMAGE_INCOMPLETE'));
});

test('an incomplete R2 write fails the entire fetch and never returns partial metadata', async () => {
  const f = fixture(feed(item() + item({ url: URL.replace('2247498657', '2247498656') })), { failPut: 2 });
  await assert.rejects(f.source.fetchSource(f.env), code('STORAGE_WRITE_FAILED'));
  assert.equal(f.objects.size, 1);
  assert.equal(f.objects.has(RSS_STATE_KEY), false);
});

test('the fixed recovery manifest retains the prior complete snapshot when a refresh write fails', async () => {
  const f = fixture(feed(item() + item({ url: URL.replace('2247498657', '2247498656'), date: 'Sat, 17 Oct 2026 21:30:00 +0800' })), { failPut: 2 });
  const previous = JSON.stringify({ kind: 'previous-complete-state' });
  f.objects.set(RSS_STATE_KEY, previous);
  await assert.rejects(f.source.fetchSource(f.env), code('STORAGE_WRITE_FAILED'));
  assert.equal(f.objects.get(RSS_STATE_KEY), previous);
});

test('the manifest reports the original minimum and maximum publication times regardless of feed order', async () => {
  const older = 'Sat, 17 Oct 2026 21:30:00 +0800';
  const f = fixture(feed(item({ date: older }) + item({ url: URL.replace('2247498657', '2247498656') })));
  const result = await f.source.fetchSource(f.env);
  const manifest = JSON.parse(f.objects.get(RSS_STATE_KEY));
  assert.equal(manifest.coverage_start, Date.parse(older));
  assert.equal(manifest.coverage_end, Date.parse(DATE));
  assert.equal(result.coverage_start, manifest.coverage_start);
  assert.ok(manifest.articles.every(article => f.objects.has(article.metadata.rss_snapshot_key)));
  assert.ok(f.objects.has(manifest.snapshot_key));
});

test('unchanged feeds reuse stable immutable snapshots across polls while changed content gets a new snapshot', async () => {
  let clock = NOW;
  let xml = feed();
  const f = fixture(() => xml, { now: () => clock });
  const first = await f.source.fetchSource(f.env);
  const originalKey = first.articles[0].metadata.rss_snapshot_key;
  const originalBody = f.objects.get(originalKey);
  clock += 5 * 60_000;
  const second = await f.source.fetchSource(f.env);
  assert.equal(second.fetched_at, clock);
  assert.equal(second.snapshot_key, first.snapshot_key);
  assert.equal(second.articles[0].metadata.rss_snapshot_key, originalKey);
  assert.equal(f.objects.get(originalKey), originalBody);
  assert.equal(f.objects.size, 3);
  assert.equal(JSON.parse(f.objects.get(RSS_STATE_KEY)).fetched_at, clock);
  xml = feed(item({ html: '<p>Updated body</p>' }));
  clock += 5 * 60_000;
  const changed = await f.source.fetchSource(f.env);
  assert.notEqual(changed.snapshot_key, first.snapshot_key);
  assert.notEqual(changed.articles[0].metadata.rss_snapshot_key, originalKey);
  assert.equal(f.objects.get(originalKey), originalBody);
  assert.match((await loadRssArticle(f.env, changed.articles[0])).text, /Updated body/);
  assert.match((await loadRssArticle(f.env, first.articles[0])).text, /Complete body/);
});

test('snapshot keys and checksums cannot read unrelated private data or silently accept corruption', async () => {
  const f = fixture();
  const { articles: [article] } = await f.source.fetchSource(f.env);
  for (const key of ['private/wechat-session.json', 'private/rss/articles/../../session.json', 'public/rss.json', undefined]) {
    await assert.rejects(loadRssArticle(f.env, { ...article, metadata: { rss_snapshot_key: key } }), code('RSS_SNAPSHOT_INVALID'));
  }
  const key = article.metadata.rss_snapshot_key;
  f.objects.set(key, f.objects.get(key).replace('Complete body', 'Corrupted body'));
  await assert.rejects(loadRssArticle(f.env, article), code('RSS_SNAPSHOT_INVALID'));
  f.objects.delete(key);
  await assert.rejects(loadRssArticle(f.env, article), code('RSS_SNAPSHOT_MISSING'));
});

test('snapshot identity and original publication time must match the requesting article', async () => {
  const f = fixture();
  const { articles: [article] } = await f.source.fetchSource(f.env);
  for (const changed of [{ url: URL.replace('2247498657', '2247498600') }, { source_key: 'wechat:wrong' }, { published_at: NOW }]) {
    await assert.rejects(loadRssArticle(f.env, { ...article, ...changed }), code('RSS_SNAPSHOT_INVALID'));
  }
});

test('snapshot declared size and actual text remain bounded before decoding a document', async () => {
  const f = fixture();
  const { articles: [article] } = await f.source.fetchSource(f.env);
  let read = false;
  f.env.ARCHIVE_BUCKET.get = async () => ({ size: 4 * 1024 * 1024 + 1, text: async () => { read = true; return ''; } });
  await assert.rejects(loadRssArticle(f.env, article), code('RESOURCE_TOO_LARGE'));
  assert.equal(read, false);
  f.env.ARCHIVE_BUCKET.get = async () => ({ size: 1, text: async () => 'x'.repeat(4 * 1024 * 1024 + 1) });
  await assert.rejects(loadRssArticle(f.env, article), code('RESOURCE_TOO_LARGE'));
});

test('configuration mismatches, missing R2, unsafe DNS and invalid clocks fail before snapshot writes', async () => {
  const f = fixture();
  await assert.rejects(f.source.fetchSource({}, {}), code('CONFIG_MISSING'));
  await assert.rejects(f.source.fetchSource(f.env, { account_biz: 'other' }), code('RSS_SOURCE_MISMATCH'));
  await assert.rejects(f.source.fetchSource(f.env, { rss_feed_url: 'https://other.example/feed' }), code('RSS_SOURCE_MISMATCH'));
  assert.equal(f.calls.length, 0);
  const unsafe = fixture(feed(), { dnsError: new CollectorError('UNSAFE_URL', 'unsafe') });
  await assert.rejects(unsafe.source.fetchSource(unsafe.env), code('UNSAFE_URL'));
  assert.equal(unsafe.calls.length, 0);
  await assert.rejects(createRssSource({ now: () => NaN }).fetchSource(f.env), code('CONFIG_INVALID'));
});
