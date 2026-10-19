import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { automaticWindow, sourceArticleKey } from '../src/archive/core.js';
import { RSS_FAKEID, dispatchRssSources, isRssSource } from '../src/archive/rss-schedule.js';
import { RSS_ACCOUNT_BIZ } from '../src/archive/rss-source.js';
import { ArchiveStore } from '../src/archive/store.js';

const TICK = Date.parse('2026-10-20T12:00:00+08:00');
const ACTIVATED = Date.parse('2026-10-18T20:00:00+08:00');

class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const statement = (values = []) => ({
      bind: (...args) => statement(args),
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
      const results = statements.map(statement => statement.rawRun());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}

function entry(id, published = '2026-10-19T22:00:00+08:00') {
  const url = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(RSS_ACCOUNT_BIZ)}&mid=${id}&idx=1&sn=example`;
  const source_key = sourceArticleKey(url);
  const hash = createHash('sha256').update(source_key).digest('hex');
  return { source_key, url, title: `文章 ${id}`, author: '作者', published_at: Date.parse(published), time_trusted: true,
    metadata: { source_kind: 'rss', rss_snapshot_key: `private/rss/articles/${hash}.json` } };
}

async function setup(t, { baseline = true, activated = ACTIVATED } = {}) {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const store = new ArchiveStore(db);
  let source = await store.initSource({ name: '猫笔刀', fakeid: RSS_FAKEID, account_biz: RSS_ACCOUNT_BIZ });
  if (baseline) source = await store.completeBaseline(source.id, [], activated);
  const dispatched = [];
  const env = { ARCHIVE_DB: db, ARCHIVE_AUTO_ENABLED: 'true' };
  const options = { env, store, now: () => TICK, dispatchJob: async (_env, job) => { dispatched.push(job.id); return true; } };
  const poll = (articles, extra = {}) => dispatchRssSources({ ...options,
    collector: { fetchSource: async () => ({ articles, fetched_at: TICK, snapshot_key: 'private/rss/feeds/example.xml' }) }, ...extra });
  return { db, store, source, env, options, poll, dispatched };
}

test('only the fixed RSS source polls, and disabling automatic monitoring performs no fetch', async t => {
  const { store, source, env, poll } = await setup(t);
  assert.equal(isRssSource(source), true);
  assert.equal(isRssSource({ fakeid: 'rss:another-account' }), false);
  let calls = 0;
  const collector = { fetchSource: async () => { calls++; throw new Error('unexpected fetch'); } };
  env.ARCHIVE_AUTO_ENABLED = 'false';
  await poll([], { collector });
  env.ARCHIVE_AUTO_ENABLED = 'true';
  await store.updateSource(source.id, { enabled: false });
  await store.initSource({ name: '微信来源', fakeid: 'wechat-account' });
  await poll([], { collector });
  assert.equal(calls, 0);
});

test('invalid tick and multiple enabled sources fail before fetching or creating jobs', async t => {
  const { store, poll } = await setup(t);
  await assert.rejects(poll([], { tick: NaN }), /检查时间无效/);
  await store.initSource({ name: '另一来源', fakeid: 'other' });
  await assert.rejects(poll([]), /只能启用一个/);
  assert.equal((await store.listJobs()).length, 0);
});

test('initial snapshot baselines every current entry without using the automatic quota', async t => {
  const { store, source, poll } = await setup(t, { baseline: false });
  const articles = Array.from({ length: 20 }, (_, index) => entry(index + 1));
  const result = await poll(articles);
  assert.equal(result.baselined, 1);
  assert.equal((await store.getSource(source.id)).activated_at, TICK);
  for (const article of articles) assert.equal(await store.isBaselineArticle(source.id, article.source_key), true);
  assert.equal((await store.listJobs()).length, 0);
  assert.equal((await store.all('SELECT * FROM archive_daily_runs')).length, 0);
  assert.equal((await store.all('SELECT * FROM archive_articles')).length, 0);
});

test('baseline initialization preserves an already recorded activation timestamp', async t => {
  const { db, store, source, poll } = await setup(t, { baseline: false });
  await db.prepare('UPDATE archive_sources SET activated_at=? WHERE id=?').bind(ACTIVATED, source.id).run();
  await poll([entry(1)]);
  assert.equal((await store.getSource(source.id)).activated_at, ACTIVATED);
  assert.equal((await store.listJobs()).length, 0);
});

test('failed or incomplete snapshot persistence changes neither baseline nor quota', async t => {
  const { store, source, poll } = await setup(t, { baseline: false });
  await assert.rejects(poll([], { collector: { fetchSource: async () => { throw new Error('R2 unavailable'); } } }), /R2 unavailable/);
  await assert.rejects(poll([{ ...entry(1), metadata: {} }]), /快照尚未完整保存/);
  assert.equal((await store.getSource(source.id)).baseline_completed_at, null);
  assert.equal((await store.listJobs()).length, 0);
  assert.equal((await store.all('SELECT * FROM archive_daily_runs')).length, 0);
});

test('late daytime discovery selects only the earliest eligible article in the original Beijing window', async t => {
  const { store, source, poll, dispatched } = await setup(t);
  const earliest = entry(2, '2026-10-19T21:30:00+08:00');
  const excluded = entry(9);
  await store.db.prepare('INSERT INTO archive_source_baseline(source_id,source_key) VALUES (?,?)').bind(source.id, excluded.source_key).run();
  const result = await poll([
    entry(1, '2026-10-19T23:29:59+08:00'),
    entry(3, '2026-10-19T21:29:59+08:00'),
    entry(4, '2026-10-19T23:30:00+08:00'),
    entry(5, '2026-10-17T22:00:00+08:00'),
    { ...entry(6), time_trusted: false }, entry(7, '2026-10-21T22:00:00+08:00'), excluded, earliest,
  ]);
  assert.equal(result.selected, 1);
  assert.equal(result.dispatched, 1);
  const jobs = await store.listJobs();
  assert.equal(jobs.length, 1);
  const job = jobs[0];
  const original = automaticWindow(earliest.published_at);
  assert.equal(job.kind, 'auto');
  assert.equal(job.monitor_date, '2026-10-19');
  assert.equal(job.range_start, original.start);
  assert.equal(job.range_end, original.end);
  assert.equal(job.article_key, earliest.source_key);
  assert.equal(job.progress.rss_poll, true);
  assert.deepEqual(job.progress.dispatch_window, { date: '2026-10-19', start: TICK, end: TICK + 300_000,
    tick: TICK, active: true, final: false, rss: true });
  assert.equal(dispatched[0], job.id);
  const daily = await store.getDaily(source.id, '2026-10-19');
  assert.equal(daily.status, 'selected');
  assert.equal(daily.capture_completed_at, null);
  const items = await store.getJobItems(job.id);
  assert.equal(items.length, 1);
  assert.equal((await store.getArticle(items[0].article_id)).metadata.rss_snapshot_key, earliest.metadata.rss_snapshot_key);
  assert.equal((await store.listPublished()).length, 0);
});

test('activation is strict and the first-published timestamp takes precedence', async t => {
  const activated = Date.parse('2026-10-19T21:40:00+08:00');
  const { store, poll } = await setup(t, { activated });
  await poll([entry(1, '2026-10-19T21:40:00+08:00'),
    { ...entry(2), first_published_at: Date.parse('2026-10-17T22:00:00+08:00') },
    entry(3, '2026-10-19T21:40:01+08:00')]);
  assert.equal((await store.listJobs())[0].article_key, entry(3).source_key);
});

test('each original publication date has its own single fixed article and replay creates no duplicates', async t => {
  const { store, poll } = await setup(t);
  const articles = [entry(1, '2026-10-18T22:00:00+08:00'), entry(2), entry(3, '2026-10-19T21:45:00+08:00')];
  await poll(articles);
  const ids = (await store.listJobs()).map(job => job.id).sort();
  const replay = await poll([...articles].reverse(), { tick: TICK + 300_000 });
  assert.equal(replay.selected, 0);
  assert.deepEqual((await store.listJobs()).map(job => job.id).sort(), ids);
  assert.equal(ids.length, 2);
  assert.equal((await store.all('SELECT * FROM archive_daily_runs')).length, 2);
  assert.equal((await store.all('SELECT * FROM archive_job_items')).length, 2);
});

test('a later feed with an earlier article cannot replace the persisted selection', async t => {
  const { store, source, poll } = await setup(t);
  const first = entry(2);
  await poll([first]);
  const job = (await store.listJobs())[0];
  await store.updateJob(job.id, { status: 'retrying', last_error: 'IMAGE_INCOMPLETE' });
  await poll([entry(1, '2026-10-19T21:30:00+08:00'), first]);
  assert.equal((await store.getJob(job.id)).article_key, first.source_key);
  assert.equal((await store.getDaily(source.id, '2026-10-19')).selected_article_key, first.source_key);
  assert.equal((await store.getJobItems(job.id)).length, 1);
});

test('an unfinished selected article resumes from its snapshot after it leaves the latest feed', async t => {
  const { store, poll, dispatched } = await setup(t);
  const first = entry(1);
  await poll([first]);
  const job = (await store.listJobs())[0];
  const snapshot = job.progress.selected_article.metadata.rss_snapshot_key;
  await poll([], { tick: TICK + 300_000 });
  const restored = await store.getJob(job.id);
  assert.equal(restored.article_key, first.source_key);
  assert.equal(restored.progress.selected_article.metadata.rss_snapshot_key, snapshot);
  assert.equal(restored.progress.dispatch_window.tick, TICK + 300_000);
  assert.equal(dispatched.length, 2);
});

test('a crash after persisting the selection but before daily binding recovers the same snapshot outside the feed', async t => {
  const { store, source, poll } = await setup(t);
  const article = entry(1);
  const window = automaticWindow(article.published_at);
  const original = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: window.date,
    range_start: window.start, range_end: window.end }, `rss-auto:${source.id}:${window.date}`);
  await store.patchJobProgress(original.id, { rss_poll: true, selected_article: article });
  await poll([]);
  assert.equal((await store.listJobs()).length, 1);
  assert.equal((await store.getJob(original.id)).article_key, article.source_key);
  assert.equal((await store.getDaily(source.id, window.date)).selected_article_key, article.source_key);
});

test('an older replay cannot replace a newer dispatch tick or reset its attempt window', async t => {
  const { store, poll } = await setup(t);
  await poll([entry(1)], { tick: TICK + 300_000 });
  const original = (await store.listJobs())[0];
  const item = (await store.getJobItems(original.id))[0];
  await store.updateJobItem(original.id, item.article_id, { attempts: 3, attempt_window: `rss:${TICK + 300_000}` });
  await poll([entry(1)], { tick: TICK });
  assert.equal((await store.getJob(original.id)).progress.dispatch_window.tick, TICK + 300_000);
  assert.equal((await store.getJobItems(original.id))[0].attempts, 3);
});

test('paused, cancelled, failed, authentication-waiting and completed jobs never switch to a second article', async t => {
  for (const status of ['paused', 'cancelled', 'failed', 'waiting_auth', 'completed']) {
    await t.test(status, async t => {
      const { store, poll, dispatched } = await setup(t);
      await poll([entry(1)]);
      const job = (await store.listJobs())[0];
      if (status === 'cancelled') await store.setJobControl(job.id, 'cancel');
      else await store.updateJob(job.id, { status });
      await poll([entry(2, '2026-10-19T21:30:00+08:00')]);
      assert.equal((await store.getJob(job.id)).article_key, entry(1).source_key);
      assert.equal((await store.listJobs()).length, 1);
      assert.equal(dispatched.length, 1);
    });
  }
});

test('a shared retry deadline prevents dispatch without erasing the selected article or deadline', async t => {
  const { store, poll, dispatched } = await setup(t);
  await poll([entry(1)]);
  const job = (await store.listJobs())[0];
  const retry = Date.now() + 900_000;
  await store.updateJob(job.id, { status: 'retrying', next_retry_at: retry });
  await poll([entry(2)]);
  const current = await store.getJob(job.id);
  assert.equal(current.article_key, entry(1).source_key);
  assert.equal(current.next_retry_at, retry);
  assert.equal(dispatched.length, 1);
});

test('bootstrap history shares an article without taking or falsely completing the automatic quota', async t => {
  const { store, source, poll } = await setup(t);
  const article = entry(1);
  const history = await store.createJob({ kind: 'history', source_id: source.id,
    range_start: ACTIVATED, range_end: TICK }, 'rss-bootstrap');
  const saved = await store.addJobArticle(history.id, article);
  assert.equal(await store.getDaily(source.id, '2026-10-19'), null);
  await poll([article]);
  const automatic = (await store.listJobs()).find(job => job.kind === 'auto');
  const items = await store.getJobItems(automatic.id);
  assert.equal(items[0].article_id, saved.article.id);
  assert.equal((await store.all('SELECT * FROM archive_articles')).length, 1);
  assert.equal((await store.getDaily(source.id, '2026-10-19')).status, 'selected');
});

test('an existing same-day WeChat pin remains authoritative and does not create a new RSS job', async t => {
  const { store, source, poll, dispatched } = await setup(t);
  const selected = entry(1);
  const window = automaticWindow(selected.published_at);
  const original = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: window.date,
    range_start: window.start, range_end: window.end }, `auto:${source.id}:${window.date}`);
  await store.selectDailyArticle(source.id, window.date, selected.source_key, original.id);
  await poll([entry(2)]);
  assert.equal((await store.listJobs()).length, 1);
  assert.equal((await store.getJob(original.id)).article_key, selected.source_key);
  assert.equal(dispatched.length, 0);
  await poll([selected, entry(2)]);
  assert.equal((await store.listJobs()).length, 1);
  assert.equal(dispatched[0], original.id);
});

test('a previous empty WeChat task does not block an otherwise unreserved delayed RSS date', async t => {
  const { store, source, poll } = await setup(t);
  const article = entry(1);
  const window = automaticWindow(article.published_at);
  const original = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: window.date,
    range_start: window.start, range_end: window.end }, `auto:${source.id}:${window.date}`);
  await store.updateJob(original.id, { status: 'completed' });
  await poll([article]);
  const jobs = await store.listJobs();
  assert.equal(jobs.length, 2);
  assert.equal(jobs.find(job => job.id !== original.id).article_key, article.source_key);
});

test('a date already reserved by another source cannot create another selected task', async t => {
  const { store, source, poll } = await setup(t);
  await store.updateSource(source.id, { enabled: false });
  const other = await store.initSource({ name: '旧来源', fakeid: 'previous-account' });
  const old = await store.createJob({ kind: 'auto', source_id: other.id, monitor_date: '2026-10-19' }, 'old-source');
  await store.selectDailyArticle(other.id, '2026-10-19', entry(9).source_key, old.id);
  await store.updateSource(other.id, { enabled: false });
  await store.updateSource(source.id, { enabled: true });
  await poll([entry(1)]);
  assert.equal((await store.listJobs()).length, 1);
  assert.equal(await store.getDaily(source.id, '2026-10-19'), null);
});

test('an occupied schedule lease or a source disabled during fetching cannot create work', async t => {
  const { store, source, poll } = await setup(t);
  const lease = await store.acquireLease(`schedule:${source.id}`, 'other-tick', 60_000);
  let calls = 0;
  const collector = { fetchSource: async () => { calls++; await store.updateSource(source.id, { enabled: false });
    return { articles: [entry(1)], fetched_at: TICK }; } };
  await poll([], { collector });
  assert.equal(calls, 0);
  await store.releaseLease(lease);
  await poll([], { collector });
  assert.equal(calls, 1);
  assert.equal((await store.listJobs()).length, 0);
});

test('losing the lease while fetching stops before baseline or article selection', async t => {
  const { store, source, poll } = await setup(t, { baseline: false });
  const collector = { fetchSource: async () => {
    await store.db.prepare('UPDATE archive_leases SET expires_at=0 WHERE resource=?').bind(`schedule:${source.id}`).run();
    return { articles: [entry(1)], fetched_at: TICK };
  } };
  await assert.rejects(poll([], { collector }), /租约已失效/);
  assert.equal((await store.getSource(source.id)).baseline_completed_at, null);
  assert.equal((await store.listJobs()).length, 0);
});

test('ambiguous workflow dispatch retains its outbox and reuses the fixed task on the next tick', async t => {
  const { store, poll } = await setup(t);
  await poll([entry(1)], { dispatchJob: async () => { throw new Error('connection closed after create'); } });
  const job = (await store.listJobs())[0];
  assert.equal((await store.listPendingDispatch())[0].id, job.id);
  await poll([entry(1)], { tick: TICK + 300_000 });
  assert.equal((await store.listJobs()).length, 1);
  assert.equal((await store.getDaily(job.source_id, job.monitor_date)).job_id, job.id);
});
