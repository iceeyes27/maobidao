import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ArchiveStore } from '../src/archive/store.js';
import { createCommentCollector } from '../src/archive/wechat-comments.js';
import { saveReaderSession } from '../src/archive/reader-session.js';
import { publicArticleComments, readingStatus, requestReadingProbe, runReadingProbe } from '../src/archive/reading-service.js';
import { validateReaderArticleUrl, WECHAT_READER_BIZ } from '../src/archive/wechat-reader.js';

const PROBE_KEY = 'private/wechat-reader/probe.json';
const ARTICLE_ID = '1234567890abcdef1234567890abcdef';
const ARTICLE_URL = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(WECHAT_READER_BIZ)}&mid=2247498657&idx=1&sn=5cdfb9d08d7f6844b121f8618cd9dba3`;
const IDENTITY = validateReaderArticleUrl(ARTICLE_URL);
const PROBE_ID = '529a8c5e-754c-4fd0-9345-123456789abc';
const credentials = () => ({ kind: 'wechat-reader', account_biz: WECHAT_READER_BIZ,
  uin: '12345678', key: 'synthetic-reader-key', pass_ticket: 'synthetic-reader-ticket' });
const failure = code => Object.assign(new Error('synthetic-private-upstream-message'), { code });

class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8'));
  }
  prepare(query) {
    const prepared = (values = []) => ({
      bind: (...bound) => prepared(bound),
      first: async () => this.sqlite.prepare(query).get(...values) || null,
      all: async () => ({ results: this.sqlite.prepare(query).all(...values) }),
      run: async () => ({ success: true, meta: { changes: Number(this.sqlite.prepare(query).run(...values).changes) } }),
    });
    return prepared();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}

class MemoryBucket {
  objects = new Map();
  writes = [];
  async put(key, value, options) {
    if (options?.onlyIf?.etagMatches && this.objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    const etag = crypto.randomUUID();
    this.objects.set(key, { bytes: bytes.slice(), options, etag });
    this.writes.push(key);
    return { key, size: bytes.byteLength, etag };
  }
  async get(key) {
    const stored = this.objects.get(key);
    return stored ? { size: stored.bytes.byteLength, etag: stored.etag, text: async () => new TextDecoder().decode(stored.bytes) } : null;
  }
  async delete(key) { this.objects.delete(key); }
}

function fixture(t) {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const bucket = new MemoryBucket();
  const creates = [];
  const env = { ARCHIVE_DB: db, ARCHIVE_BUCKET: bucket,
    ARCHIVE_SESSION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))),
    ARCHIVE_WORKFLOW: { create: async input => { creates.push(input); return {}; },
      get: async () => { throw new Error('not found'); } } };
  return { env, db, store: new ArchiveStore(db), bucket, creates };
}

function reader({ articles = [{ ...IDENTITY, published_at: Date.now() - 1000, time_trusted: true }],
  discoveryError, articleError, commentId = '12345', onArticle } = {}) {
  return {
    probeSource: async () => {
      if (discoveryError) throw discoveryError;
      return { articles };
    },
    probeArticle: async (_env, url) => {
      assert.equal(url, IDENTITY.url);
      await onArticle?.();
      if (articleError) throw articleError;
      return { article_identity: IDENTITY, comment_id: commentId, image_count: 2, text_length: 50 };
    },
  };
}
const comments = patch => ({ fetchComments: async () => ({ comments: [], replies: [], complete: true, fetched_at: Date.now(), ...patch }) });
async function seedPublished(f) {
  const now = Date.now();
  f.db.sqlite.prepare(`INSERT INTO archive_articles(id,source_key,url,title,status,body_key,manifest_json,
    metadata_json,content_text,captured_at,published_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ARTICLE_ID, IDENTITY.source_key, IDENTITY.url, 'Stored title', 'published',
    `articles/${ARTICLE_ID}/body-original.html`, '[]', '{"author":"Original author"}', 'Original saved text', now, now, now, now);
  await f.bucket.put(`articles/${ARTICLE_ID}/body-original.html`, '<p>Original saved body</p>');
  return f.store.getArticle(ARTICLE_ID);
}
async function leaseAvailable(f, resource) {
  const lease = await f.store.acquireLease(resource, 'test-next-request', 1000);
  assert.ok(lease, `${resource} lease was released`);
  await f.store.releaseLease(lease);
}

test('anonymous failures preserve separate discovery, article and comment states without claiming no new articles', async t => {
  const f = fixture(t);
  const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, {
    reader: reader({ discoveryError: failure('READER_LOGIN_REQUIRED'), articleError: failure('CHALLENGE_REQUIRED') }),
    comments: { fetchComments: () => assert.fail('Comments require a verified article identity') },
  });
  assert.equal(result.state, 'attention');
  assert.deepEqual(result.discovery, { state: 'blocked', code: 'READER_LOGIN_REQUIRED' });
  assert.deepEqual(result.article, { state: 'blocked', code: 'CHALLENGE_REQUIRED' });
  assert.deepEqual(result.comments, { state: 'blocked', code: 'ARTICLE_VERIFICATION_REQUIRED' });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|reader-key|reader-ticket/);
  assert.equal((await readingStatus(f.env)).probe.discovery.state, 'blocked');
  await leaseAvailable(f, 'wechat-reader');
});

test('discovery failure does not suppress independently readable body and public comments', async t => {
  const f = fixture(t);
  let requested = 0;
  const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, {
    reader: reader({ discoveryError: failure('READER_LOGIN_REQUIRED') }),
    comments: { fetchComments: async () => { requested++; throw failure('RATE_LIMITED'); } },
  });
  assert.equal(requested, 1);
  assert.equal(result.state, 'attention');
  assert.equal(result.article.state, 'available');
  assert.deepEqual(result.comments, { state: 'blocked', code: 'RATE_LIMITED' });
});

test('an empty source list cannot verify a realtime discovery channel', async t => {
  const f = fixture(t);
  const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, {
    reader: reader({ articles: [] }), comments: comments(),
  });
  assert.equal(result.discovery.state, 'empty');
  assert.equal(result.discovery.article_count, 0);
  assert.equal(result.article.state, 'available');
  assert.equal(result.state, 'attention');
});

test('a comment failure leaves all published article fields and saved body unchanged', async t => {
  const f = fixture(t);
  const before = await seedPublished(f);
  const bodyBefore = f.bucket.objects.get(before.body_key).bytes.slice();
  const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, {
    reader: reader(), comments: { fetchComments: async () => { throw failure('COMMENTS_UNAVAILABLE'); } },
  });
  assert.deepEqual(result.comments, { state: 'blocked', code: 'COMMENTS_UNAVAILABLE' });
  assert.deepEqual(await f.store.getArticle(ARTICLE_ID), before);
  assert.deepEqual(f.bucket.objects.get(before.body_key).bytes, bodyBefore);
  assert.equal(await publicArticleComments(f.env, ARTICLE_ID), null);
});

test('real public comment normalization stores continuation privately and public output exposes no cursor or reader fields', async t => {
  const f = fixture(t);
  await seedPublished(f);
  const now = Date.now();
  let requestCount = 0;
  const collector = createCommentCollector({ resolveHost: async () => {}, now: () => now,
    fetchImpl: async () => {
      requestCount++;
      return new Response(JSON.stringify({ base_resp: { ret: 0 },
        elected_comment: [{ content_id: String(requestCount), content: 'Public text', nick_name: 'Public nickname',
          create_time: Math.floor(now / 1000) - 100, like_num: 1, is_elected: 1,
          openid: 'private-openid', my_id: 7, cookie: 'private-cookie',
          reply_new: { max_reply_id: 1, reply_total_cnt: 1, reply_list: [{ reply_id: 1, content: 'Public reply',
            nick_name: 'Public reply author', create_time: Math.floor(now / 1000) - 50, openid: 'private-reply-openid' }] } }],
        friend_comment: [{ content: 'private-friend-comment' }], my_comment: [{ content: 'private-my-comment' }],
        buffer: `private-cursor-${requestCount}`, continue_flag: true }), { headers: { 'content-type': 'application/json' } });
    } });
  const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, { reader: reader(), comments: collector });
  assert.equal(result.comments.state, 'partial');
  assert.equal(result.comments.count, 5);
  assert.equal(result.comments.reply_count, 5);
  const internal = JSON.parse(await (await f.bucket.get(`private/wechat-reader/comments/${ARTICLE_ID}.json`)).text());
  assert.equal(internal.next_cursor.buffer, 'private-cursor-5');
  const published = await publicArticleComments(f.env, ARTICLE_ID);
  assert.equal(published.comments.length, 5);
  assert.deepEqual(Object.keys(published).sort(), ['checked_at', 'comments', 'complete']);
  assert.doesNotMatch(JSON.stringify(published), /private-|openid|cookie|cursor|friend_comment|my_comment|uin|pass_ticket/);
  assert.doesNotMatch(JSON.stringify(result), /private-|openid|cookie|cursor|pass_ticket/);
  assert.ok(published.comments.every(entry => entry.replies.length === 1));
});

test('reply continuation merges into the saved parent and reports final completion and cumulative totals', async t => {
  const f = fixture(t);
  await seedPublished(f);
  const now = Date.now();
  const cursor = { source_key: IDENTITY.source_key, comment_id: '12345', buffer: '', offset: 1,
    main_complete: true, seen_comments: ['1'], reply_count: 0,
    pending_replies: [{ content_id: '1', max_reply_id: '0', total: 1, seen_ids: [] }] };
  await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, { reader: reader(), comments: comments({
    comments: [{ id: '1', nickname: 'Public author', content: 'Public parent', created_at: now - 1000,
      like_count: 1, replies: [], replies_complete: false }], complete: false, next_cursor: cursor,
  }) });
  assert.equal((await publicArticleComments(f.env, ARTICLE_ID)).comments[0].replies_complete, false);
  const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, { reader: reader(),
    comments: { fetchComments: async (_env, _article, options) => {
      assert.deepEqual(options.cursor, cursor);
      return { comments: [], replies: [{ comment_id: '1', id: '2', nickname: 'Public reply author', content: 'Public reply',
        created_at: now, like_count: 1 }], complete: true, fetched_at: now + 1000 };
    } },
  });
  assert.deepEqual(result.comments, { state: 'available', count: 1, reply_count: 1, complete: true });
  const published = await publicArticleComments(f.env, ARTICLE_ID);
  assert.equal(published.complete, true);
  assert.equal(published.comments[0].replies_complete, true);
  assert.equal(published.comments[0].replies.length, 1);
  assert.equal(published.comments[0].replies[0].comment_id, undefined);
});

test('probe queue contains only the canonical public URL while reading credentials stay encrypted', async t => {
  const f = fixture(t);
  await saveReaderSession(f.env, credentials());
  const input = `${ARTICLE_URL}&uin=12345678&key=synthetic-reader-key&pass_ticket=synthetic-reader-ticket&scene=124`;
  const result = await requestReadingProbe(f.env, input);
  assert.equal(result.status, 'queued');
  assert.equal(f.creates.length, 1);
  assert.deepEqual(f.creates[0].params, { action: 'probe-reader', probe_id: result.probe_id, url: IDENTITY.url });
  assert.doesNotMatch(JSON.stringify(f.creates), /uin|synthetic|pass_ticket/);
  const status = await readingStatus(f.env);
  assert.equal(status.session.configured, true);
  assert.equal(status.probe.state, 'queued');
  assert.doesNotMatch(JSON.stringify(status), /synthetic|pass_ticket|reader-key/);
  await leaseAvailable(f, 'reader-probe-request');
});

test('concurrent probe requests are busy and their request lease is released', async t => {
  const f = fixture(t);
  await requestReadingProbe(f.env, ARTICLE_URL);
  await assert.rejects(requestReadingProbe(f.env, ARTICLE_URL), { code: 'BUSY' });
  assert.equal(f.creates.length, 1);
  await leaseAvailable(f, 'reader-probe-request');
});

test('an active execution lease does not start a second probe or modify its diagnostic', async t => {
  const f = fixture(t);
  await f.bucket.put(PROBE_KEY, JSON.stringify({ probe_id: PROBE_ID, state: 'running', session_revision: null }));
  const held = await f.store.acquireLease('wechat-reader', 'another-probe', 240000);
  const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, {
    reader: { probeSource: () => assert.fail('Busy probes cannot read sources') }, comments: comments(),
  });
  assert.deepEqual(result, { state: 'busy', probe_id: PROBE_ID });
  assert.equal(JSON.parse(await (await f.bucket.get(PROBE_KEY)).text()).state, 'running');
  await f.store.releaseLease(held);
});

test('a matching queued probe becomes a terminal busy record when another operation holds its execution lease', async t => {
  const f = fixture(t);
  await f.bucket.put(PROBE_KEY, JSON.stringify({ probe_id: PROBE_ID, state: 'queued', session_revision: null, started_at: Date.now() }));
  const held = await f.store.acquireLease('wechat-reader', 'reader-session-import', 30000);
  const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, {
    reader: { probeSource: () => assert.fail('Busy probes cannot make upstream requests') }, comments: comments(),
  });
  assert.deepEqual(result, { state: 'busy', probe_id: PROBE_ID });
  const status = await readingStatus(f.env);
  assert.equal(status.probe.state, 'busy');
  assert.ok(Number.isSafeInteger(status.probe.checked_at));
  assert.deepEqual(status.probe.discovery, { state: 'blocked', code: 'BUSY' });
  const snapshot = f.bucket.objects.get(PROBE_KEY);
  assert.ok(snapshot.options.onlyIf.etagMatches);
  await f.store.releaseLease(held);
  assert.equal((await requestReadingProbe(f.env, ARTICLE_URL)).status, 'queued', 'A terminal busy result permits a new request');
});

test('busy handling cannot replace another probe or an already running or completed matching result', async t => {
  const f = fixture(t);
  const held = await f.store.acquireLease('wechat-reader', 'reader-session-import', 30000);
  const newerId = '929a8c5e-754c-4fd0-9345-123456789abc';
  for (const saved of [{ probe_id: newerId, state: 'queued' }, { probe_id: newerId, state: 'running' },
    { probe_id: PROBE_ID, state: 'running' }, { probe_id: PROBE_ID, state: 'verified' }]) {
    await f.bucket.put(PROBE_KEY, JSON.stringify(saved));
    const before = f.bucket.objects.get(PROBE_KEY);
    const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, { reader: reader(), comments: comments() });
    assert.equal(result.state, 'busy');
    assert.equal(f.bucket.objects.get(PROBE_KEY), before);
  }
  await f.store.releaseLease(held);
});

test('conditional busy write preserves a running or newer probe that replaced its queued snapshot during the read', async t => {
  const f = fixture(t);
  const held = await f.store.acquireLease('wechat-reader', 'reader-session-import', 30000);
  const originalGet = f.bucket.get.bind(f.bucket);
  for (const next of [{ probe_id: PROBE_ID, state: 'running' },
    { probe_id: '929a8c5e-754c-4fd0-9345-123456789abc', state: 'queued' }]) {
    await f.bucket.put(PROBE_KEY, JSON.stringify({ probe_id: PROBE_ID, state: 'queued', session_revision: null }));
    f.bucket.get = async key => {
      const object = await originalGet(key);
      if (key === PROBE_KEY) {
        const text = object.text;
        object.text = async () => {
          const before = await text();
          await f.bucket.put(PROBE_KEY, JSON.stringify(next));
          return before;
        };
      }
      return object;
    };
    assert.equal((await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, { reader: reader(), comments: comments() })).state, 'busy');
    assert.deepEqual(JSON.parse(await (await originalGet(PROBE_KEY)).text()), next);
  }
  f.bucket.get = originalGet;
  await f.store.releaseLease(held);
});

test('an execution storage failure still releases its lease', async t => {
  const f = fixture(t);
  const put = f.bucket.put.bind(f.bucket);
  f.bucket.put = async (key, ...args) => { if (key === PROBE_KEY) throw new Error('Synthetic R2 unavailable'); return put(key, ...args); };
  await assert.rejects(runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, { reader: reader(), comments: comments() }), /Synthetic R2/);
  await leaseAvailable(f, 'wechat-reader');
});

test('a new reading revision invalidates an older successful probe immediately and during execution', async t => {
  const f = fixture(t);
  const first = await saveReaderSession(f.env, credentials());
  const result = await runReadingProbe(f.env, { url: ARTICLE_URL, probe_id: PROBE_ID }, {
    reader: reader({ onArticle: async () => { await saveReaderSession(f.env, { ...credentials(), key: 'synthetic-new-reader-key' }); } }),
    comments: comments(),
  });
  assert.equal(result.state, 'session_changed');
  const status = await readingStatus(f.env);
  assert.notEqual(status.session.revision, first.revision);
  assert.equal(status.probe.state, 'session_changed');
  assert.equal(status.probe.discovery, undefined);
  assert.doesNotMatch(JSON.stringify(status), /synthetic-new|reader-key|pass_ticket/);
});

test('unpublished articles and invalid identifiers never reveal stored comments', async t => {
  const f = fixture(t);
  await seedPublished(f);
  await f.bucket.put(`private/wechat-reader/comments/${ARTICLE_ID}.json`, JSON.stringify({ comments: [{ id: '1', content: 'Public text' }], complete: true }));
  f.db.sqlite.prepare('UPDATE archive_articles SET status=? WHERE id=?').run('ready', ARTICLE_ID);
  for (const id of [ARTICLE_ID, '../private', '', '1'.repeat(31)]) assert.equal(await publicArticleComments(f.env, id), null);
});
