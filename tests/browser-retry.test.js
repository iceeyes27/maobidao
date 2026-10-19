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
    const statement = (values = []) => ({
      bind: (...bound) => statement(bound),
      first: async () => this.sqlite.prepare(sql).get(...values) || null,
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
      rawRun: () => this.sqlite.prepare(sql).run(...values),
      run: async () => ({ meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) } }),
    });
    return statement();
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

function setup(t) {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const objects = new Map();
  const bucket = {
    put: async (key, value) => { objects.set(key, typeof value === 'string' ? new TextEncoder().encode(value) : value); },
    head: async (key) => objects.has(key) ? { size: objects.get(key).byteLength } : null,
  };
  return { store: new ArchiveStore(db), env: { ARCHIVE_DB: db, ARCHIVE_BUCKET: bucket }, bucket };
}

const at = (time, day = '2026-10-19') => Date.parse(`${day}T${time}+08:00`);
const entry = (name = 'one') => ({ url: `https://mp.weixin.qq.com/s/${name}`, title: name,
  source_key: sourceArticleKey(`https://mp.weixin.qq.com/s/${name}`), published_at: at('22:00:00'), time_trusted: true });
const captured = (article) => ({ title: article.title || 'Synthetic', html: '<p>Complete body</p>', text: 'Complete body',
  images: [], published_at: article.first_published_at, original_url: article.url });
const busy = (retryAt) => Object.assign(new Error('Browser temporarily busy'), { code: 'BROWSER_BUSY', status: 429, retryable: true, retry_at: retryAt });
async function source(store) {
  const result = await store.initSource({ name: 'Synthetic source', fakeid: 'synthetic' });
  await store.completeBaseline(result.id, [], at('21:00:00'));
  return result;
}
async function automatic(store, sourceId) {
  return store.createJob({ kind: 'auto', source_id: sourceId, monitor_date: '2026-10-19',
    range_start: at('21:30:00'), range_end: at('23:30:00') });
}

test('repeated browser waits preserve the same article without consuming its retry budget', async (t) => {
  const { store, env } = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [entry().url] });
  let clock = at('22:10:00');
  let calls = 0;
  const collector = { captureArticle: async (_env, article) => {
    if (++calls <= 4) throw busy(clock + 20_000);
    return captured(article);
  } };
  const run = () => runArchiveBatch(env, job.id, { collector, now: () => clock });
  let articleId;
  for (let round = 0; round < 4; round++) {
    const waiting = await run();
    assert.deepEqual(waiting, { state: 'waiting_browser', job_id: job.id, retry_at: clock + 20_000 });
    const [item] = await store.getJobItems(job.id);
    articleId ||= item.article_id;
    assert.equal(item.article_id, articleId);
    assert.equal(item.status, 'pending');
    assert.equal(item.attempts, 0);
    assert.equal(item.last_error, null);
    const saved = await store.getJob(job.id);
    assert.equal(saved.status, 'retrying');
    assert.equal(saved.failed_count, 0);
    assert.equal(saved.progress.quota_wait_until, undefined);
    assert.equal((await store.getArticle(articleId)).last_error, null);
    clock = waiting.retry_at;
  }
  assert.equal((await run()).state, 'completed');
  assert.equal(calls, 5);
  assert.equal((await store.getJobItems(job.id))[0].attempts, 1);
  assert.equal((await store.getJob(job.id)).progress.browser_wait_until, null);
  assert.equal((await store.listPublished())[0].id, articleId);
});

test('browser waits during discovery preserve the failed page and its scanned count', async (t) => {
  const { store, env } = setup(t);
  const s = await source(store);
  const job = await store.createJob({ kind: 'history', source_id: s.id, range_start: at('00:00:00'), range_end: at('23:00:00') });
  let clock = at('22:10:00');
  let blocked = true;
  const cursors = [];
  const collector = {
    listSourceArticles: async (_env, _source, { cursor }) => {
      cursors.push(cursor);
      if (!cursor) return { articles: [], next_cursor: 5, has_more: true };
      if (blocked) throw busy(clock + 20_000);
      return { articles: [entry()], next_cursor: 6, has_more: false };
    }, captureArticle: async (_env, article) => captured(article),
  };
  const run = () => runArchiveBatch(env, job.id, { collector, now: () => clock });
  const waiting = await run();
  assert.equal(waiting.state, 'waiting_browser');
  assert.equal((await store.getJob(job.id)).cursor.list_cursor, 5);
  assert.equal((await store.getJob(job.id)).progress.scanned_pages, 1);
  assert.equal((await run()).state, 'waiting_browser');
  assert.deepEqual(cursors, [0, 5]);
  blocked = false;
  clock = waiting.retry_at;
  assert.equal((await run()).state, 'completed');
  assert.deepEqual(cursors, [0, 5, 5]);
  assert.equal((await store.getJob(job.id)).progress.scanned_pages, 2);
});

test('browser waits preserve earlier real failures instead of resetting their attempt count', async (t) => {
  const { store, env } = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [entry().url] });
  const { article } = await store.addJobArticle(job.id, entry());
  await store.updateJobItem(job.id, article.id, { attempts: 2, status: 'pending' });
  const clock = at('22:10:00');
  const collector = { captureArticle: async () => { throw busy(clock + 20_000); } };
  assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => clock })).state, 'waiting_browser');
  assert.equal((await store.getJobItems(job.id))[0].attempts, 2);
});

test('queueing, resume and retry cannot bypass a browser wait deadline', async (t) => {
  const { store, env } = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [entry().url] });
  const clock = at('22:10:00');
  let calls = 0;
  const collector = { captureArticle: async () => { calls++; throw busy(clock + 20_000); } };
  const run = () => runArchiveBatch(env, job.id, { collector, now: () => clock });
  await run();
  await store.updateJob(job.id, { status: 'queued', next_retry_at: null });
  assert.equal((await run()).state, 'waiting_browser');
  await store.setJobControl(job.id, 'pause');
  assert.equal((await run()).state, 'paused');
  await store.setJobControl(job.id, 'resume');
  assert.equal((await run()).state, 'waiting_browser');
  await store.setJobControl(job.id, 'retry');
  assert.equal((await run()).state, 'waiting_browser');
  assert.equal(calls, 1);
  assert.equal((await store.getJob(job.id)).next_retry_at, clock + 20_000);
});

test('automatic capture waits retain the selected article and resume only in a later allowed window', async (t) => {
  const { store, env } = setup(t);
  const s = await source(store);
  const job = await automatic(store, s.id);
  let clock = at('23:29:59');
  let calls = 0;
  let lists = 0;
  const collector = {
    listSourceArticles: async () => { lists++; return { articles: [entry()], next_cursor: 1, has_more: false }; },
    captureArticle: async (_env, article) => { if (++calls === 1) throw busy(at('23:30:20')); return captured(article); },
  };
  let window = { ...automaticWindow(clock), tick: clock };
  const run = () => runArchiveBatch(env, job.id, { collector, now: () => clock, dispatchWindow: window });
  assert.equal((await run()).state, 'waiting_browser');
  assert.equal((await store.getJob(job.id)).article_key, entry().source_key);
  clock = at('23:30:20');
  assert.equal((await run()).state, 'awaiting_window');
  assert.equal(calls, 1);
  clock = at('21:30:00', '2026-10-20');
  window = { ...automaticWindow(clock), tick: clock };
  await store.selectDailyArticle(s.id, window.date, entry().source_key, job.id);
  assert.equal((await run()).state, 'completed');
  assert.equal(calls, 2);
  assert.equal(lists, 1);
});

test('automatic discovery cannot retry after its normal monitoring deadline', async (t) => {
  const { store, env } = setup(t);
  const s = await source(store);
  const job = await automatic(store, s.id);
  let clock = at('23:29:59');
  const window = { ...automaticWindow(clock), tick: clock };
  let lists = 0;
  const collector = { listSourceArticles: async () => { lists++; throw busy(at('23:30:20')); } };
  const run = () => runArchiveBatch(env, job.id, { collector, now: () => clock, dispatchWindow: window });
  assert.equal((await run()).state, 'waiting_browser');
  clock = at('23:30:20');
  assert.equal((await run()).state, 'awaiting_window');
  assert.equal(lists, 1);
  assert.equal((await store.getJob(job.id)).article_key, null);
});

test('a busy first capture in the final round cannot reuse its deadline grant', async (t) => {
  const { store, env } = setup(t);
  const s = await source(store);
  const job = await automatic(store, s.id);
  let clock = at('23:30:01');
  const window = { ...automaticWindow(at('23:30:00')), tick: at('23:30:00'), final: true };
  let calls = 0;
  const collector = {
    listSourceArticles: async () => ({ articles: [entry()], next_cursor: 1, has_more: false }),
    captureArticle: async () => { calls++; throw busy(clock + 20_000); },
  };
  const run = () => runArchiveBatch(env, job.id, { collector, now: () => clock, dispatchWindow: window });
  const waiting = await run();
  clock = waiting.retry_at;
  assert.equal((await run()).state, 'awaiting_window');
  assert.equal(calls, 1);
  assert.equal((await store.getJobItems(job.id))[0].attempts, 0);
});

test('a busy final discovery request is not repeated after its short wait', async (t) => {
  const { store, env } = setup(t);
  const s = await source(store);
  const job = await automatic(store, s.id);
  let clock = at('23:30:01');
  const window = { ...automaticWindow(at('23:30:00')), tick: at('23:30:00'), final: true };
  let lists = 0;
  const collector = { listSourceArticles: async () => { lists++; throw busy(clock + 20_000); } };
  const run = () => runArchiveBatch(env, job.id, { collector, now: () => clock, dispatchWindow: window });
  clock = (await run()).retry_at;
  assert.equal((await run()).state, 'awaiting_window');
  assert.equal(lists, 1);
  assert.equal((await store.getJob(job.id)).progress.final_poll_used, true);
  assert.equal((await store.getJob(job.id)).progress.scanned_pages, undefined);
});

test('an already captured article publishes outside the automatic window during a browser wait', async (t) => {
  const { store, env, bucket } = setup(t);
  const s = await source(store);
  const job = await automatic(store, s.id);
  await store.selectDailyArticle(s.id, job.monitor_date, entry().source_key, job.id);
  const { article } = await store.addJobArticle(job.id, entry());
  const lease = await store.claimArticle(article.id, 'seed', 60_000);
  await bucket.put('saved-body', '<p>Complete</p>');
  await store.patchArticle(article.id, { status: 'ready', body_key: 'saved-body', captured_at: at('22:00:00'), manifest: [] }, lease);
  await store.releaseLease(lease);
  await store.patchJobProgress(job.id, { browser_wait_until: at('23:50:00') });
  await store.updateJob(job.id, { status: 'retrying', next_retry_at: at('23:50:00') });
  const collector = { captureArticle: async () => assert.fail('Publishing saved content requires no browser') };
  assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => at('23:45:00') })).state, 'completed');
  assert.equal((await store.getArticle(article.id)).status, 'published');
});

for (const action of ['pause', 'cancel']) {
  test(`${action} during a busy browser operation takes precedence over waiting`, async (t) => {
    const { store, env } = setup(t);
    const job = await store.createJob({ kind: 'manual', urls: [entry().url] });
    const clock = at('22:10:00');
    const collector = { captureArticle: async () => {
      await store.setJobControl(job.id, action);
      throw busy(clock + 20_000);
    } };
    const expected = action === 'pause' ? 'paused' : 'cancelled';
    assert.equal((await runArchiveBatch(env, job.id, { collector, now: () => clock })).state, expected);
    assert.equal((await store.getJob(job.id)).status, expected);
    assert.equal((await store.getJob(job.id)).failed_count, 0);
    assert.deepEqual(await store.listPublished(), []);
  });
}

test('invalid browser retry times fall back to a short wait rather than the daily quota reset', async (t) => {
  const { store, env } = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [entry().url] });
  const clock = at('22:10:00');
  const collector = { captureArticle: async () => { throw busy('invalid'); } };
  const outcome = await runArchiveBatch(env, job.id, { collector, now: () => clock });
  assert.equal(outcome.state, 'waiting_browser');
  assert.equal(outcome.retry_at, clock + 20_000);
  assert.equal((await store.getJob(job.id)).progress.quota_wait_until, undefined);
});
