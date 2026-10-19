import assert from 'node:assert/strict';
import test from 'node:test';
import { encode as encodePng } from 'fast-png';
import { createCollector } from '../src/archive/collector.js';
import { CollectorError } from '../src/archive/collector-security.js';
import { imageResourceId } from '../src/archive/resources.js';
import { createRssSource, RSS_ACCOUNT_BIZ, RSS_FEED_URL } from '../src/archive/rss-source.js';

const TIME = Date.parse('2026-10-19T14:00:00Z');
const PUBLICATION = Date.parse('Sun, 18 Oct 2026 22:37:00 +0800');
const SOURCE = { fakeid: `rss:${RSS_ACCOUNT_BIZ}`, account_biz: RSS_ACCOUNT_BIZ, name: '猫笔刀' };
const ARTICLE_URL = `https://mp.weixin.qq.com/s?__biz=${RSS_ACCOUNT_BIZ}&mid=2247498657&idx=1&sn=synthetic`;
const IMAGE_URLS = ['https://mmbiz.qpic.cn/mmbiz_png/synthetic/640?wx_fmt=png',
  'https://res.wx.qq.com/t/wx_fed/we-emoji/res/assets/Expression/synthetic.png'];
const png = Uint8Array.from(encodePng({ width: 1, height: 1, channels: 4, depth: 8, data: Uint8Array.of(255, 0, 0, 255) }));
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const html = `<p>Complete saved RSS body.</p>${IMAGE_URLS.map(url => `<img src="${escape(`https://wechat2rss.xlab.app/img-proxy/?k=synthetic&u=${encodeURIComponent(url)}`)}">`).join('')}`;
const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>猫笔刀</title>
  <item><title>Saved RSS article</title><link>${escape(ARTICLE_URL)}</link><content:encoded><![CDATA[${html}]]></content:encoded><pubDate>Sun, 18 Oct 2026 22:37:00 +0800</pubDate><dc:creator>Original author</dc:creator></item>
</channel></rss>`;
const hasCode = expected => error => error instanceof CollectorError && error.code === expected;

function fixture({ imageReply } = {}) {
  const objects = new Map();
  const network = [];
  const rpc = [];
  let feedAvailable = true;
  const fetchImpl = async (url, init) => {
    network.push({ url, init });
    assert.equal(url, RSS_FEED_URL, 'RSS capture must not request the original WeChat page or download images in the parent request');
    assert.equal(init.headers.cookie, undefined);
    assert.ok(feedAvailable, 'Recovery must not refetch an entry that has left the feed');
    return new Response(xml, { headers: { 'content-type': 'application/rss+xml' } });
  };
  const resolveHost = async host => assert.equal(host, 'wechat2rss.xlab.app');
  const browserMustNotRun = async () => assert.fail('RSS work must not use a cloud browser');
  const playwright = Object.fromEntries(['launch', 'acquire', 'connect', 'limits'].map(name => [name, browserMustNotRun]));
  const env = { ARCHIVE_BUCKET: {
    async put(key, body) { objects.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body)); },
    async get(key) {
      const body = objects.get(key);
      return body === undefined ? null : { size: new TextEncoder().encode(body).byteLength, text: async () => body };
    },
  }, ARCHIVE_EXECUTOR: {
    getByName(name) { return { async fetchImage(url) {
      rpc.push({ name, url });
      return imageReply ? imageReply({ name, url, call: rpc.length })
        : { ok: true, value: { url, bytes: png.slice(), contentType: 'image/png', decoded: true } };
    } }; },
  } };
  for (const name of ['ARCHIVE_DB', 'ARCHIVE_SESSION_KEY', 'ARCHIVE_BROWSER']) {
    Object.defineProperty(env, name, { get() { assert.fail(`RSS work must not access login configuration: ${name}`); } });
  }
  const dependencies = { fetchImpl, resolveHost, now: () => TIME };
  return { env, objects, network, rpc, dependencies,
    source: createRssSource(dependencies), collector: createCollector({ ...dependencies, playwright }),
    expireFeed() { feedAvailable = false; } };
}

test('RSS collector enumeration saves full snapshots without account state, a browser or a WeChat API request', async () => {
  const f = fixture();
  const page = await f.collector.listSourceArticles(f.env, SOURCE, { cursor: 0, count: 5 });
  assert.equal(page.transport, 'rss');
  assert.equal(page.has_more, false);
  assert.equal(page.next_cursor, 1);
  assert.equal(page.articles.length, 1);
  assert.equal(page.articles[0].time_trusted, true);
  assert.equal(page.articles[0].published_at, PUBLICATION);
  assert.equal(f.network.length, 1);
  assert.equal(f.rpc.length, 0);
  assert.ok(f.objects.has(page.snapshot_key));
  const saved = JSON.parse(f.objects.get(page.articles[0].metadata.rss_snapshot_key));
  assert.equal(saved.raw_html, html);
  assert.deepEqual(saved.images, IMAGE_URLS);
});

test('real RSS source snapshots feed directly into capture and all original images use independent resource RPC', async () => {
  const f = fixture();
  const { articles: [entry] } = await f.source.fetchSource(f.env, SOURCE);
  f.expireFeed();
  const captured = await f.collector.captureArticle(f.env, entry);
  assert.equal(captured.title, 'Saved RSS article');
  assert.equal(captured.author, 'Original author');
  assert.equal(captured.source_name, '猫笔刀');
  assert.equal(captured.original_url, ARTICLE_URL);
  assert.equal(captured.source_key, entry.source_key);
  assert.equal(captured.published_at, PUBLICATION);
  assert.match(captured.html, /Complete saved RSS body/);
  assert.doesNotMatch(captured.html, /img-proxy/);
  assert.deepEqual(captured.images.map(image => image.source_url), IMAGE_URLS);
  assert.ok(captured.images.every(image => image.content_type === 'image/png' && image.bytes instanceof Uint8Array));
  assert.deepEqual(captured.images[0].bytes, png);
  assert.deepEqual(f.rpc, await Promise.all(IMAGE_URLS.map(async url => ({ name: await imageResourceId(url), url }))));
  assert.equal(f.network.length, 1);
  assert.equal(captured.metadata.rss_snapshot_key, entry.metadata.rss_snapshot_key);
});

test('a fresh collector can repeatedly recover the same immutable body after the feed is unavailable', async () => {
  const f = fixture();
  const { articles: [entry] } = await f.source.fetchSource(f.env, SOURCE);
  const serialized = f.objects.get(entry.metadata.rss_snapshot_key);
  f.expireFeed();
  const input = { ...entry, first_published_at: entry.published_at, published_at: TIME };
  const first = await f.collector.captureArticle(f.env, input);
  const second = await createCollector(f.dependencies).captureArticle(f.env, input);
  assert.deepEqual(second, first);
  assert.equal(f.objects.get(entry.metadata.rss_snapshot_key), serialized);
  assert.equal(f.network.length, 1);
  assert.equal(f.rpc.length, IMAGE_URLS.length * 2);
});

test('an image RPC that has not confirmed full decoding cannot produce an RSS capture', async () => {
  const f = fixture({ imageReply: ({ url }) => ({ ok: true, value: { url, bytes: png, contentType: 'image/png', decoded: false } }) });
  const { articles: [entry] } = await f.source.fetchSource(f.env, SOURCE);
  await assert.rejects(f.collector.captureArticle(f.env, entry), hasCode('IMAGE_INCOMPLETE'));
  assert.equal(f.rpc.length, 1);
  assert.equal(f.network.length, 1);
  assert.ok(f.objects.has(entry.metadata.rss_snapshot_key));
});

test('a later image failure rejects the whole capture and retains the saved body for a future attempt', async () => {
  let failSecond = true;
  const f = fixture({ imageReply: ({ url, call }) => failSecond && call === 2
    ? { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'Image temporarily unavailable', retryable: true, status: 503 } }
    : { ok: true, value: { url, bytes: png, contentType: 'image/png', decoded: true } } });
  const { articles: [entry] } = await f.source.fetchSource(f.env, SOURCE);
  const snapshot = f.objects.get(entry.metadata.rss_snapshot_key);
  f.expireFeed();
  await assert.rejects(f.collector.captureArticle(f.env, entry), error => {
    assert.ok(hasCode('UPSTREAM_ERROR')(error));
    assert.equal(error.retryable, true);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(f.objects.get(entry.metadata.rss_snapshot_key), snapshot);
  failSecond = false;
  const captured = await f.collector.captureArticle(f.env, entry);
  assert.equal(captured.images.length, 2);
  assert.equal(f.network.length, 1);
});

test('snapshot canonical identity mismatches are rejected before any original image request', async () => {
  const f = fixture();
  const { articles: [entry] } = await f.source.fetchSource(f.env, SOURCE);
  f.expireFeed();
  for (const changed of [{ url: entry.url.replace('mid=2247498657', 'mid=2247498600') },
    { source_key: entry.source_key.replace('2247498657', '2247498600') }, { published_at: PUBLICATION + 60_000 }]) {
    await assert.rejects(f.collector.captureArticle(f.env, { ...entry, ...changed }), hasCode('RSS_SNAPSHOT_INVALID'));
  }
  assert.equal(f.rpc.length, 0);
  assert.equal(f.network.length, 1);
});

test('corrupt or missing RSS body snapshots fail without falling back to the original article page', async () => {
  const f = fixture();
  const { articles: [entry] } = await f.source.fetchSource(f.env, SOURCE);
  f.expireFeed();
  f.objects.set(entry.metadata.rss_snapshot_key, f.objects.get(entry.metadata.rss_snapshot_key).replace('Complete saved RSS body.', 'Corrupt body.'));
  await assert.rejects(f.collector.captureArticle(f.env, entry), hasCode('RSS_SNAPSHOT_INVALID'));
  f.objects.delete(entry.metadata.rss_snapshot_key);
  await assert.rejects(f.collector.captureArticle(f.env, entry), hasCode('RSS_SNAPSHOT_MISSING'));
  assert.equal(f.rpc.length, 0);
  assert.equal(f.network.length, 1);
});
