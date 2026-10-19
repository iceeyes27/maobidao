import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runArchiveBatch } from '../src/archive/runner.js';
import { ArchiveStore } from '../src/archive/store.js';
import { automaticWindow, sourceArticleKey } from '../src/archive/core.js';

class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const prepared = (values = []) => ({
      bind: (...bound) => prepared(bound),
      first: async () => this.sqlite.prepare(sql).get(...values) || null,
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
      rawRun: () => this.sqlite.prepare(sql).run(...values),
      run: async () => ({ success: true, meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) } }),
    });
    return prepared();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.rawRun());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}

class MemoryBucket {
  objects = new Map();
  failed = new Set();
  writes = [];
  async put(key, value, options) {
    if (this.failed.has(key) || this.failAll) throw new Error('R2 unavailable');
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { bytes: new Uint8Array(bytes), options });
    this.writes.push(key);
    return { key, size: bytes.byteLength };
  }
  async head(key) {
    const object = this.objects.get(key);
    return object ? { key, size: object.bytes.byteLength } : null;
  }
}

const at = (time, day = '2026-10-19') => Date.parse(`${day}T${time}+08:00`);
const entry = (id, time = '22:00:00') => ({
  source_key: sourceArticleKey(`https://mp.weixin.qq.com/s/${id}`),
  url: `https://mp.weixin.qq.com/s/${id}`, title: `Title ${id}`,
  published_at: at(time), time_trusted: true,
});
const capture = (article) => ({
  title: article.title || 'Captured title', html: '<p>Hello<script>alert(1)</script></p><img src="https://example.com/picture.png">',
  text: 'Hello', published_at: article.first_published_at, original_url: article.url,
  images: [{ source_url: 'https://example.com/picture.png', bytes: new Uint8Array([1, 2, 3]), content_type: 'image/png' }],
});
const problem = (code, retryable = false) => Object.assign(new Error(code), { code, retryable });

function setup(t) {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const bucket = new MemoryBucket();
  const store = new ArchiveStore(db);
  const env = { ARCHIVE_DB: db, ARCHIVE_BUCKET: bucket };
  return { env, store, bucket };
}
async function source(store) {
  const result = await store.initSource({ name: 'Source', fakeid: 'source' });
  await store.completeBaseline(result.id, [], at('21:00:00'));
  return result;
}
async function auto(store, sourceId) {
  return store.createJob({ kind: 'auto', source_id: sourceId, monitor_date: '2026-10-19',
    range_start: at('21:30:00'), range_end: at('23:30:00') });
}
function options(collector, time = at('22:30:00')) { return { collector, now: () => time }; }

test('manual archive saves all images and sanitized body before publishing', async (t) => {
  const { env, store, bucket } = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [entry('one').url] });
  const result = await runArchiveBatch(env, job.id, options({ captureArticle: async (_env, article) => capture(article) }));
  assert.equal(result.state, 'completed');
  const [article] = await store.listPublished();
  assert.equal(article.manifest.length, 1);
  assert.equal(article.manifest[0].bytes, 3);
  const html = new TextDecoder().decode(bucket.objects.get(article.body_key).bytes);
  assert.match(html, new RegExp(`/media/${article.id}/[a-f0-9]{64}`));
  assert.doesNotMatch(html, /script|alert\(1\)|https:\/\/example.com\/picture/);
  assert.equal(bucket.writes.at(-1), article.body_key);
});

test('a failed image write never makes an article visible and history continues', async (t) => {
  const { env, store, bucket } = setup(t);
  const s = await source(store);
  const job = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('00:00:00'), range_end: at('23:00:00') });
  const first = entry('first');
  const second = entry('second');
  const calls = [];
  const collector = {
    listSourceArticles: async () => ({ articles: [first, second], next_cursor: 2, has_more: false }),
    captureArticle: async (_env, article) => {
      calls.push(article.url);
      if (article.url === first.url) throw problem('IMAGE_INCOMPLETE', true);
      return capture(article);
    },
  };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'continue');
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'continue');
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'completed');
  assert.equal((await store.getJob(job.id)).status, 'partial_failed');
  assert.equal(calls.filter((url) => url === first.url).length, 3);
  assert.equal((await store.listPublished()).length, 1);
  assert.equal((await store.getJobItems(job.id)).find((item) => item.url === first.url).attempts, 3);
  assert.ok(bucket.writes.length > 0);
});

test('pagination failure keeps the failing cursor and resumes the same page', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('00:00:00'), range_end: at('23:00:00') });
  const seen = [];
  let fail = true;
  const collector = {
    listSourceArticles: async (_env, _source, { cursor }) => {
      seen.push(cursor);
      if (cursor === 0) return { articles: [], next_cursor: 5, has_more: true };
      if (fail) throw problem('UPSTREAM_ERROR', true);
      return { articles: [entry('one')], next_cursor: 6, has_more: false };
    }, captureArticle: async (_env, article) => capture(article),
  };
  await assert.rejects(runArchiveBatch(env, job.id, options(collector)), /UPSTREAM_ERROR/);
  assert.equal((await store.getJob(job.id)).cursor.list_cursor, 5);
  assert.equal((await store.getJob(job.id)).progress.scanned_pages, 1);
  fail = false;
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'completed');
  assert.deepEqual(seen, [0, 5, 5]);
  assert.equal((await store.getJob(job.id)).progress.scanned_pages, 2);
});

test('history scans every page despite out-of-order old timestamps and uses an exclusive end', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('21:00:00'), range_end: at('23:00:00') });
  const cursors = [];
  const collector = {
    listSourceArticles: async (_env, _s, { cursor }) => {
      cursors.push(cursor);
      return cursor === 0 ? { articles: [entry('older', '20:00:00')], next_cursor: 1, has_more: true }
        : { articles: [entry('included', '21:00:00'), entry('excluded', '23:00:00')], next_cursor: 3, has_more: false };
    }, captureArticle: async (_env, article) => capture(article),
  };
  await runArchiveBatch(env, job.id, options(collector));
  assert.deepEqual(cursors, [0, 1]);
  assert.deepEqual((await store.listPublished()).map((article) => article.title), ['Title included']);
});

test('untrusted historical publication time is a visible partial failure', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('00:00:00'), range_end: at('23:00:00') });
  let captures = 0;
  await runArchiveBatch(env, job.id, options({
    listSourceArticles: async () => ({ articles: [{ ...entry('unknown'), time_trusted: false, published_at: null }], has_more: false, next_cursor: 1 }),
    captureArticle: async () => { captures++; },
  }));
  assert.equal(captures, 0);
  assert.equal((await store.getJob(job.id)).status, 'partial_failed');
  assert.match((await store.getJobItems(job.id))[0].last_error, /UNTRUSTED_TIME/);
});

test('login expiry keeps the page cursor and resumes after authentication', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('00:00:00'), range_end: at('23:00:00') });
  let loggedIn = false;
  const cursors = [];
  const collector = {
    listSourceArticles: async (_env, _s, { cursor }) => {
      cursors.push(cursor);
      if (!loggedIn) throw problem('LOGIN_EXPIRED');
      return { articles: [entry('one')], next_cursor: 1, has_more: false };
    }, captureArticle: async (_env, article) => capture(article),
  };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'waiting_auth');
  assert.equal((await store.getJob(job.id)).cursor, null);
  assert.equal((await store.getJob(job.id)).progress.auth_required, true);
  assert.equal((await store.getJob(job.id)).progress.login_version, null);
  assert.equal((await store.getJob(job.id)).progress.auth_failed_version, 0);
  loggedIn = true;
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'completed');
  assert.deepEqual(cursors, [0, 0]);
});

test('baseline records the initial page without collecting its article bodies', async (t) => {
  const { env, store } = setup(t);
  const s = await store.initSource({ name: 'Source', fakeid: 'source' });
  const job = await store.createJob({ kind: 'baseline', source_id: s.id });
  let captures = 0;
  const collector = {
    listSourceArticles: async () => ({ articles: [entry('old')], next_cursor: 5, has_more: true }),
    captureArticle: async () => { captures++; },
  };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'completed');
  assert.equal(captures, 0);
  assert.equal(await store.isBaselineArticle(s.id, entry('old').source_key), true);
  assert.equal((await store.getSource(s.id)).activated_at, at('22:30:00'));
  assert.equal((await store.getJob(job.id)).progress.scanned_pages, 1);
});

test('automatic monitoring binds one eligible article and never discovers a second', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  let lists = 0;
  const collector = {
    listSourceArticles: async () => { lists++; return { articles: [entry('later', '22:15:00'), entry('earlier', '21:45:00'), entry('outside', '20:00:00')], next_cursor: 3, has_more: false }; },
    captureArticle: async (_env, article) => capture(article),
  };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'completed');
  assert.equal((await store.listPublished())[0].title, 'Title earlier');
  assert.equal((await store.getDaily(s.id, job.monitor_date)).status, 'completed');
  await runArchiveBatch(env, job.id, options(collector));
  assert.equal(lists, 1);
});

test('automatic retries stop at the deadline and only resume the original article next window', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  let clock = at('23:29:59');
  let captures = 0;
  let lists = 0;
  const collector = {
    listSourceArticles: async () => { lists++; return { articles: [entry('one')], next_cursor: 1, has_more: false }; },
    captureArticle: async (_env, article) => {
      captures++;
      if (captures === 1) { clock = at('23:30:01'); throw problem('UPSTREAM_ERROR', true); }
      return capture(article);
    },
  };
  const dispatch = { ...automaticWindow(clock), tick: clock };
  assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => clock, dispatchWindow: dispatch })).state, 'awaiting_window');
  assert.equal(captures, 1);
  clock = at('22:00:00', '2026-10-20');
  const nextWindow = { ...automaticWindow(clock), tick: clock };
  await store.selectDailyArticle(s.id, nextWindow.date, entry('one').source_key, job.id);
  assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => clock, dispatchWindow: nextWindow })).state, 'completed');
  assert.equal(captures, 2);
  assert.equal(lists, 1);
  assert.equal((await store.listPublished())[0].source_key, entry('one').source_key);
});

test('the final scheduled round permits one first capture but cannot retry outside the window', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  const time = at('23:30:03');
  const window = { ...automaticWindow(at('23:30:00')), final: true, tick: at('23:30:00') };
  let captures = 0;
  const collector = {
    listSourceArticles: async () => ({ articles: [entry('one')], has_more: false, next_cursor: 1 }),
    captureArticle: async () => { captures++; throw problem('UPSTREAM_ERROR', true); },
  };
  assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => time, dispatchWindow: window })).state, 'awaiting_window');
  assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => time, dispatchWindow: window })).state, 'awaiting_window');
  assert.equal(captures, 1);
});

test('no update returns idle and resets pagination for the next scheduled tick', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  const collector = { listSourceArticles: async () => ({ articles: [entry('old', '20:00:00')], has_more: false, next_cursor: 1 }) };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'idle');
  assert.equal((await store.getJob(job.id)).cursor.list_cursor, 0);
  assert.equal((await store.getJob(job.id)).article_key, null);
});

test('automatic batches continue within one tick and inspect the newest page again on the next tick', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  let tick = at('22:00:00');
  const seen = [];
  const collector = {
    listSourceArticles: async (_env, _source, { cursor }) => {
      seen.push(cursor);
      return tick === at('22:05:00') && cursor === 0
        ? { articles: [entry('new-head', '22:04:00')], has_more: true, next_cursor: 5 }
        : { articles: [entry(`old-${cursor}`, '20:00:00')], has_more: true, next_cursor: cursor + 5 };
    }, captureArticle: async (_env, article) => capture(article),
  };
  const run = () => runArchiveBatch(env, job.id, {
    collector, maxPages: 1, now: () => tick, dispatchWindow: { ...automaticWindow(tick), tick },
  });
  assert.equal((await run()).state, 'continue');
  assert.equal((await run()).state, 'continue');
  assert.equal((await store.getJob(job.id)).cursor.list_cursor, 10);
  tick = at('22:05:00');
  assert.equal((await run()).state, 'completed');
  assert.deepEqual(seen, [0, 5, 0]);
  const saved = await store.getJob(job.id);
  assert.equal(saved.progress.poll_tick, tick);
  assert.equal(saved.progress.scanned_pages, 3);
  assert.equal(saved.article_key, entry('new-head').source_key);
});

test('a stale automatic dispatch cannot reset a newer polling cursor', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  const seen = [];
  const collector = { listSourceArticles: async (_env, _source, { cursor }) => {
    seen.push(cursor);
    return { articles: [], has_more: true, next_cursor: cursor + 5 };
  } };
  const run = (tick) => runArchiveBatch(env, job.id, {
    collector, maxPages: 1, now: () => at('22:05:01'), dispatchWindow: { ...automaticWindow(tick), tick },
  });
  await run(at('22:05:00'));
  assert.equal((await run(at('22:00:00'))).state, 'continue');
  assert.deepEqual(seen, [0]);
  assert.equal((await store.getJob(job.id)).cursor.list_cursor, 5);
  assert.equal((await store.getJob(job.id)).progress.poll_tick, at('22:05:00'));
});

test('a scheduler window change between page processing and checkpoint commit is preserved', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  const tick = at('22:00:00');
  const nextWindow = { ...automaticWindow(tick), tick: at('22:05:00') };
  const patchProgress = store.patchJobProgress.bind(store);
  store.patchJobProgress = async (id, patch, checkpoint) => {
    if (checkpoint?.scannedPage) await store.scheduleJob(id, nextWindow);
    return patchProgress(id, patch, checkpoint);
  };
  const collector = { listSourceArticles: async () => ({ articles: [], has_more: true, next_cursor: 5 }) };
  const outcome = await runArchiveBatch(env, job.id, {
    store, collector, maxPages: 1, now: () => tick, dispatchWindow: { ...automaticWindow(tick), tick },
  });
  assert.equal(outcome.state, 'continue');
  const saved = await store.getJob(job.id);
  assert.deepEqual(saved.progress.dispatch_window, nextWindow);
  assert.equal(saved.progress.poll_tick, tick);
  assert.equal(saved.progress.scanned_pages, 1);
  assert.equal(saved.cursor.list_cursor, 5);
});

test('the final polling round can advance across bounded batches without repeating a page', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  const tick = at('23:30:00');
  const window = { ...automaticWindow(tick), tick, final: true };
  const seen = [];
  const collector = {
    listSourceArticles: async (_env, _source, { cursor }) => {
      seen.push(cursor);
      return cursor === 0 ? { articles: [entry('old', '20:00:00')], has_more: true, next_cursor: 5 }
        : { articles: [entry('last-round', '23:29:00')], has_more: false, next_cursor: 6 };
    }, captureArticle: async (_env, article) => capture(article),
  };
  const config = { collector, maxPages: 1, now: () => tick + 3_000, dispatchWindow: window };
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'continue');
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'completed');
  assert.deepEqual(seen, [0, 5]);
  const saved = await store.getJob(job.id);
  assert.equal(saved.progress.final_poll_tick, tick);
  assert.equal(saved.progress.final_poll_cursor, 5);
  assert.equal(saved.progress.scanned_pages, 2);
});

test('a failed later page in the final round cannot be requested again', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  const tick = at('23:30:00');
  const window = { ...automaticWindow(tick), tick, final: true };
  const seen = [];
  const collector = { listSourceArticles: async (_env, _source, { cursor }) => {
    seen.push(cursor);
    if (cursor === 5) throw problem('RATE_LIMITED', true);
    return { articles: [], has_more: true, next_cursor: 5 };
  } };
  const config = { collector, maxPages: 1, now: () => tick + 3_000, dispatchWindow: window };
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'continue');
  await assert.rejects(runArchiveBatch(env, job.id, config), /RATE_LIMITED/);
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'awaiting_window');
  assert.deepEqual(seen, [0, 5]);
  const saved = await store.getJob(job.id);
  assert.equal(saved.cursor.list_cursor, 5);
  assert.equal(saved.progress.final_poll_cursor, 5);
  assert.equal(saved.progress.scanned_pages, 1);
  assert.match(saved.last_error, /RATE_LIMITED/);
});

test('a ready article can be published outside the automatic capture window without recapture', async (t) => {
  const { env, store, bucket } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  await store.selectDailyArticle(s.id, job.monitor_date, entry('ready').source_key, job.id);
  const { article } = await store.addJobArticle(job.id, entry('ready'));
  const lease = await store.claimArticle(article.id, 'seed', 60000);
  await bucket.put('ready-body', '<p>Ready</p>');
  await store.patchArticle(article.id, { body_key: 'ready-body', manifest: [], captured_at: at('22:00:00'), status: 'ready' }, lease);
  await store.releaseLease(lease);
  let captures = 0;
  const collector = { captureArticle: async () => { captures++; } };
  assert.equal((await runArchiveBatch(env, job.id, options(collector, at('23:45:00')))).state, 'completed');
  assert.equal(captures, 0);
});

test('history yields to pending automatic work before starting a source page', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const historical = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('00:00:00'), range_end: at('23:00:00') });
  await auto(store, s.id);
  let lists = 0;
  assert.equal((await runArchiveBatch(env, historical.id, options({ listSourceArticles: async () => { lists++; } }))).state, 'continue');
  assert.equal(lists, 0);
});

test('page-boundary pause preserves the page already recorded and resumes its successor', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('00:00:00'), range_end: at('23:00:00') });
  const seen = [];
  let pause = true;
  const collector = {
    listSourceArticles: async (_env, _s, { cursor }) => {
      seen.push(cursor);
      if (pause) { pause = false; await store.setJobControl(job.id, 'pause'); return { articles: [], next_cursor: 5, has_more: true }; }
      return { articles: [], next_cursor: 6, has_more: false };
    },
  };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'paused');
  assert.equal((await store.getJob(job.id)).cursor.list_cursor, 5);
  await store.setJobControl(job.id, 'resume');
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'completed');
  assert.deepEqual(seen, [0, 5]);
});

test('two canonical URL forms resolve to the existing public article ID', async (t) => {
  const { env, store } = setup(t);
  const canonical = 'https://mp.weixin.qq.com/s?__biz=account&mid=123&idx=1';
  const legacy = await store.importLegacyArticle({ id: 'c'.repeat(32), url: canonical, title: 'Legacy', success: true });
  const job = await store.createJob({ kind: 'manual', urls: [entry('short').url] });
  const collector = { captureArticle: async (_env, article) => ({ ...capture(article), source_key: sourceArticleKey(canonical), original_url: canonical }) };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'completed');
  assert.equal((await store.getJobItems(job.id))[0].article_id, legacy.id);
  assert.equal((await store.listPublished()).length, 1);
});

test('storage write failure remains unpublished until a later batch succeeds', async (t) => {
  const { env, store, bucket } = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [entry('one').url] });
  bucket.failAll = true;
  const collector = { captureArticle: async (_env, article) => capture(article) };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'continue');
  assert.deepEqual(await store.listPublished(), []);
  assert.equal((await store.getJobItems(job.id))[0].attempts, 1);
  bucket.failAll = false;
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'completed');
  assert.equal((await store.listPublished()).length, 1);
});

test('cancelling a sole batch during capture prevents its public visibility', async (t) => {
  const { env, store } = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [entry('one').url] });
  const collector = { captureArticle: async (_env, article) => {
    await store.setJobControl(job.id, 'cancel');
    return capture(article);
  } };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'cancelled');
  assert.deepEqual(await store.listPublished(), []);
});

test('cancelling one batch does not discard another batch shared capture', async (t) => {
  const { env, store } = setup(t);
  const first = await store.createJob({ kind: 'manual', urls: [entry('one').url] });
  const second = await store.createJob({ kind: 'manual', urls: [entry('one').url] });
  await store.addJobArticle(second.id, entry('one'));
  const collector = { captureArticle: async (_env, article) => {
    await store.setJobControl(first.id, 'cancel');
    return capture(article);
  } };
  assert.equal((await runArchiveBatch(env, first.id, options(collector))).state, 'cancelled');
  assert.equal((await store.listPublished()).length, 1);
  let captures = 0;
  assert.equal((await runArchiveBatch(env, second.id, options({ captureArticle: async () => { captures++; } }))).state, 'completed');
  assert.equal(captures, 0);
});

test('pausing during capture completes that article and pauses at the next boundary', async (t) => {
  const { env, store } = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [entry('one').url, entry('two').url] });
  let captures = 0;
  const collector = { captureArticle: async (_env, article) => {
    captures++;
    await store.setJobControl(job.id, 'pause');
    return capture(article);
  } };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'paused');
  assert.equal(captures, 1);
  assert.equal((await store.listPublished()).length, 1);
  assert.equal((await store.getJob(job.id)).status, 'paused');
});

test('automatic retry exhaustion remains bound and does not restart in the same window', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  let captures = 0;
  const collector = {
    listSourceArticles: async () => ({ articles: [entry('one')], has_more: false, next_cursor: 1 }),
    captureArticle: async () => { captures++; throw problem('UPSTREAM_ERROR', true); },
  };
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'continue');
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'continue');
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'awaiting_window');
  assert.equal((await runArchiveBatch(env, job.id, options(collector))).state, 'awaiting_window');
  assert.equal(captures, 3);
  assert.equal((await store.getJob(job.id)).article_key, entry('one').source_key);
});

test('idle automatic work cannot block manual history outside the monitoring window', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  await auto(store, s.id);
  const historical = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('00:00:00'), range_end: at('23:00:00') });
  let lists = 0;
  const collector = { listSourceArticles: async () => { lists++; return { articles: [], has_more: false, next_cursor: 0 }; } };
  assert.equal((await runArchiveBatch(env, historical.id, options(collector, at('12:00:00')))).state, 'completed');
  assert.equal(lists, 1);
});

test('a failing final-round first capture cannot reuse its grant after login recovery', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  const window = { ...automaticWindow(at('23:30:00')), tick: at('23:30:00'), final: true };
  let captures = 0;
  const collector = {
    listSourceArticles: async () => ({ articles: [entry('one')], has_more: false, next_cursor: 1 }),
    captureArticle: async () => { captures++; throw problem('CHALLENGE_REQUIRED'); },
  };
  const config = { collector, now: () => at('23:30:03'), dispatchWindow: window };
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'waiting_auth');
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'awaiting_window');
  assert.equal(captures, 1);
});

test('the final list failure cannot issue a second poll after the deadline', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  const window = { ...automaticWindow(at('23:30:00')), tick: at('23:30:00'), final: true };
  let lists = 0;
  const collector = { listSourceArticles: async () => { lists++; throw problem('RATE_LIMITED', true); } };
  const config = { collector, now: () => at('23:30:03'), dispatchWindow: window };
  await assert.rejects(runArchiveBatch(env, job.id, config), /RATE_LIMITED/);
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'awaiting_window');
  assert.equal(lists, 1);
  assert.equal((await store.getJob(job.id)).progress.final_poll_used, true);
  assert.match((await store.getJob(job.id)).last_error, /RATE_LIMITED/);
});

test('browser quota waits do not consume article attempts or call the collector again before reset', async (t) => {
  const { env, store } = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [entry('quota').url] });
  let clock = at('22:00:00');
  const retryAt = at('08:00:00', '2026-10-20');
  let captures = 0;
  const collector = { captureArticle: async (_env, article) => {
    captures++;
    if (captures === 1) throw Object.assign(problem('BROWSER_QUOTA_EXCEEDED'), { retry_at: retryAt });
    return capture(article);
  } };
  const config = { collector, now: () => clock };
  const waiting = await runArchiveBatch(env, job.id, config);
  assert.equal(waiting.state, 'waiting_quota');
  assert.equal(waiting.retry_at, retryAt);
  const saved = await store.getJob(job.id);
  assert.equal(saved.next_retry_at, retryAt);
  assert.equal(saved.failed_count, 0);
  assert.equal(saved.status, 'waiting_quota');
  assert.equal((await store.getJobItems(job.id))[0].attempts, 0);
  assert.equal((await store.getJobItems(job.id))[0].status, 'pending');
  assert.equal((await store.getArticleByKey(entry('quota').source_key)).status, 'pending');
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'waiting_quota');
  assert.equal(captures, 1);
  assert.equal((await store.getJobItems(job.id))[0].attempts, 0);
  clock = retryAt;
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'completed');
  assert.equal(captures, 2);
  assert.equal((await store.getJob(job.id)).next_retry_at, null);
});

test('quota exhaustion during pagination preserves the exact cursor and scanned page count', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('00:00:00'), range_end: at('23:00:00') });
  const retryAt = at('08:00:00', '2026-10-20');
  let clock = at('22:00:00');
  let quota = true;
  const cursors = [];
  const collector = {
    listSourceArticles: async (_env, _source, { cursor }) => {
      cursors.push(cursor);
      if (cursor === 0) return { articles: [], next_cursor: 5, has_more: true };
      if (quota) throw Object.assign(problem('BROWSER_QUOTA_EXCEEDED'), { retry_at: retryAt });
      return { articles: [entry('quota-page')], next_cursor: 6, has_more: false };
    }, captureArticle: async (_env, article) => capture(article),
  };
  const config = { collector, now: () => clock };
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'waiting_quota');
  assert.equal((await store.getJob(job.id)).cursor.list_cursor, 5);
  assert.equal((await store.getJob(job.id)).progress.scanned_pages, 1);
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'waiting_quota');
  assert.deepEqual(cursors, [0, 5]);
  quota = false;
  clock = retryAt;
  assert.equal((await runArchiveBatch(env, job.id, config)).state, 'completed');
  assert.deepEqual(cursors, [0, 5, 5]);
  assert.equal((await store.getJob(job.id)).progress.scanned_pages, 2);
});

test('automatic quota recovery waits for the next monitoring window and retains the selected article', async (t) => {
  const { env, store } = setup(t);
  const s = await source(store);
  const job = await auto(store, s.id);
  const retryAt = at('08:00:00', '2026-10-20');
  let clock = at('22:00:00');
  let captures = 0;
  let lists = 0;
  const collector = {
    listSourceArticles: async () => { lists++; return { articles: [entry('quota-auto')], next_cursor: 1, has_more: false }; },
    captureArticle: async (_env, article) => {
      captures++;
      if (captures === 1) throw Object.assign(problem('BROWSER_QUOTA_EXCEEDED'), { retry_at: retryAt });
      return capture(article);
    },
  };
  let window = { ...automaticWindow(clock), tick: clock };
  assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => clock, dispatchWindow: window })).state, 'waiting_quota');
  clock = retryAt;
  assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => clock, dispatchWindow: window })).state, 'awaiting_window');
  assert.equal(captures, 1);
  clock = at('21:30:00', '2026-10-20');
  window = { ...automaticWindow(clock), tick: clock };
  await store.selectDailyArticle(s.id, window.date, entry('quota-auto').source_key, job.id);
  assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => clock, dispatchWindow: window })).state, 'completed');
  assert.equal(captures, 2);
  assert.equal(lists, 1);
});

test('quota errors with an invalid retry time safely wait for the next UTC day', async (t) => {
  const { env, store } = setup(t);
  const s = await store.initSource({ name: 'Source', fakeid: 'source' });
  const job = await store.createJob({ kind: 'baseline', source_id: s.id });
  const time = at('22:00:00');
  const collector = { listSourceArticles: async () => { throw Object.assign(problem('BROWSER_QUOTA_EXCEEDED'), { retry_at: 'invalid' }); } };
  const response = await runArchiveBatch(env, job.id, options(collector, time));
  assert.equal(response.state, 'waiting_quota');
  assert.equal(response.retry_at, (Math.floor(time / 86_400_000) + 1) * 86_400_000);
  assert.equal((await store.getSource(s.id)).baseline_completed_at, null);
});
