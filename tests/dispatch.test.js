import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ArchiveStore } from '../src/archive/store.js';
import { dispatchJob, dispatchPending, scheduledArchive, signalWaitingJobs } from '../src/archive/dispatch.js';
import { automaticWindow } from '../src/archive/core.js';
import { runArchiveBatch } from '../src/archive/runner.js';
import { CollectorError } from '../src/archive/collector-security.js';
import { RSS_FAKEID } from '../src/archive/rss-schedule.js';
import { RSS_FEED_URL } from '../src/archive/rss-source.js';

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

async function setup(t) {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const store = new ArchiveStore(db);
  const job = await store.createJob({ kind: 'manual', urls: ['https://mp.weixin.qq.com/s/article'] });
  return { db, store, job };
}

test('a missing workflow thrown by get creates the fixed workflow ID', async t => {
  const { db, store, job } = await setup(t);
  const created = [];
  const env = { ARCHIVE_DB: db, ARCHIVE_WORKFLOW: {
    get: async () => { throw new Error('Workflow instance does not exist'); },
    create: async options => { created.push(options); return { id: options.id }; },
  } };
  assert.equal(await dispatchJob(env, job), true);
  assert.deepEqual(created, [{ id: job.workflow_id, params: { job_id: job.id } }]);
  assert.equal((await store.listPendingDispatch()).length, 0);
});

test('a source cooldown crossing 23:30 preserves the final authorization and consumes it only once', async t => {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  db.sqlite.exec(readFileSync(new URL('../migrations/0002_admin_attempts.sql', import.meta.url), 'utf8'));
  const store = new ArchiveStore(db);
  const at = time => Date.parse(`2026-10-19T${time}+08:00`);
  let clock = at('23:29:59');
  t.mock.method(Date, 'now', () => clock);
  const source = await store.initSource({ name: 'Synthetic', fakeid: 'synthetic' });
  await store.completeBaseline(source.id, [], at('21:00:00'));
  await store.updateSource(source.id, { enabled: true });
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: '2026-10-19',
    range_start: at('21:30:00'), range_end: at('23:30:00') });
  await store.ensureDaily(source.id, job.monitor_date);
  await db.prepare('UPDATE archive_daily_runs SET job_id=? WHERE source_id=? AND monitor_date=?')
    .bind(job.id, source.id, job.monitor_date).run();
  await store.scheduleJob(job.id, { ...automaticWindow(at('23:25:00')), tick: at('23:25:00') });
  const outbox = await store.getDispatch(job.id);
  await store.markDispatched(job.id, job.workflow_id, outbox.generation);
  const env = { ARCHIVE_DB: db, ARCHIVE_BUCKET: {}, ARCHIVE_AUTO_ENABLED: 'true',
    ARCHIVE_WORKFLOW: { get: async () => assert.fail('A source cooldown must not dispatch early') } };
  let pages = 0;
  const collector = { listSourceArticles: async () => {
    if (++pages === 1) throw Object.assign(new Error('source temporarily limited'),
      { code: 'RATE_LIMITED', retryable: true, retry_at: at('23:30:59') });
    return { articles: [], next_cursor: 0, has_more: false };
  } };
  assert.equal((await runArchiveBatch(env, job.id, { collector })).state, 'waiting_source');
  clock = at('23:30:00');
  await scheduledArchive({ scheduledTime: clock }, env);
  const saved = await store.getJob(job.id);
  assert.equal(saved.progress.dispatch_window.tick, clock);
  assert.equal(saved.progress.dispatch_window.final, true);
  assert.equal(saved.progress.source_wait_until, at('23:30:59'));
  assert.equal(saved.next_retry_at, at('23:30:59'));
  assert.equal(saved.status, 'retrying');
  assert.equal((await store.getDispatch(job.id)).generation, outbox.generation + 1);
  clock = at('23:30:59');
  assert.equal((await runArchiveBatch(env, job.id, { collector })).state, 'idle');
  assert.equal((await runArchiveBatch(env, job.id, { collector })).state, 'awaiting_window');
  assert.equal(pages, 2);
  assert.equal((await store.getJob(job.id)).progress.final_poll_used, true);
});

test('ambiguous create failures retain outbox work and the next dispatch reuses the same instance', async t => {
  const { db, store, job } = await setup(t);
  let exists = false;
  let creates = 0;
  const env = { ARCHIVE_DB: db, ARCHIVE_WORKFLOW: {
    get: async () => {
      if (!exists) throw new Error('Workflow instance not found');
      return { status: async () => ({ status: 'running' }), sendEvent: async () => assert.fail('An initial create acknowledgement must not send a resume event') };
    },
    create: async () => { creates++; exists = true; throw new Error('Connection closed after submission'); },
  } };
  await assert.rejects(dispatchJob(env, job), /Connection closed/);
  assert.equal((await store.listPendingDispatch()).length, 1);
  assert.equal(await dispatchJob(env, job), true);
  assert.equal(creates, 1);
  assert.equal((await store.listPendingDispatch()).length, 0);
});

test('a verified login signal is delivered while a workflow is still running before its wait', async t => {
  const { db, store, job } = await setup(t);
  await store.updateJob(job.id, { status: 'waiting_auth' });
  await db.prepare('UPDATE archive_session SET version=7 WHERE singleton=1').run();
  const events = [];
  const env = { ARCHIVE_DB: db, ARCHIVE_WORKFLOW: { get: async () => ({
    status: async () => ({ status: 'running' }),
    sendEvent: async event => events.push(event),
  }) } };
  await signalWaitingJobs(env, 7);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'control');
  assert.equal(events[0].payload.job_id, job.id);
  assert.equal(events[0].payload.login_version, 7);
});

test('a stale login version cannot change or resume a waiting task', async t => {
  const { db, store, job } = await setup(t);
  await store.updateJob(job.id, { status: 'waiting_auth' });
  await db.prepare('UPDATE archive_session SET version=8 WHERE singleton=1').run();
  const env = { ARCHIVE_DB: db, ARCHIVE_WORKFLOW: { get: async () => assert.fail('Stale login reached workflow dispatch') } };
  await signalWaitingJobs(env, 7);
  assert.equal((await store.getJob(job.id)).status, 'waiting_auth');
});

test('a failed recovery event remains recoverable through the persisted outbox', async t => {
  const { db, store, job } = await setup(t);
  await store.updateJob(job.id, { status: 'waiting_auth' });
  await db.prepare('UPDATE archive_session SET version=9 WHERE singleton=1').run();
  let attempts = 0;
  const delivered = [];
  const env = { ARCHIVE_DB: db, ARCHIVE_WORKFLOW: { get: async () => ({
    status: async () => ({ status: 'waiting' }),
    sendEvent: async event => { attempts++; if (attempts === 1) throw new Error('Temporary send failure'); delivered.push(event); },
  }) } };
  await signalWaitingJobs(env, 9);
  assert.equal((await store.listPendingDispatch()).length, 1);
  await dispatchPending(env);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.job_id, job.id);
  assert.equal(delivered[0].payload.login_version, 9);
  assert.equal((await store.listPendingDispatch()).length, 0);
});

test('a continuation requested before the previous run returns is acknowledged only after restart', async t => {
  const { db, store, job } = await setup(t);
  await store.requestDispatch(job.id, 'continue');
  let status = 'running';
  let restarts = 0;
  const env = { ARCHIVE_DB: db, ARCHIVE_WORKFLOW: { get: async () => ({
    status: async () => ({ status }), restart: async () => { restarts++; },
    sendEvent: async () => assert.fail('A continuation must wait for the previous run to finish'),
  }) } };
  assert.equal(await dispatchJob(env, job), false);
  assert.equal((await store.listPendingDispatch()).length, 1);
  status = 'complete';
  assert.equal(await dispatchJob(env, job), true);
  assert.equal(restarts, 1);
  assert.equal((await store.listPendingDispatch()).length, 0);
});

test('unknown workflow status cannot acknowledge pending work', async t => {
  const { db, store, job } = await setup(t);
  const env = { ARCHIVE_DB: db, ARCHIVE_WORKFLOW: { get: async () => ({ status: async () => ({ status: 'unknown' }) }) } };
  assert.equal(await dispatchJob(env, job), false);
  assert.equal((await store.listPendingDispatch()).length, 1);
});

test('an old create acknowledgement cannot erase a newer continuation generation', async t => {
  const { db, store, job } = await setup(t);
  const original = await store.getDispatch(job.id);
  const env = { ARCHIVE_DB: db, ARCHIVE_WORKFLOW: {
    get: async () => { throw new Error('Workflow instance not found'); },
    create: async () => { await store.requestDispatch(job.id, 'continue'); return { id: job.workflow_id }; },
  } };
  await dispatchJob(env, job);
  const current = await store.getDispatch(job.id);
  assert.ok(current.generation > original.generation);
  assert.ok(current.dispatched_generation < current.generation);
  assert.equal((await store.listPendingDispatch()).length, 1);
});

test('a final authorization relays a finishing workflow once and cannot extend monitoring after its expiry', async t => {
  const finalTick = Date.UTC(2026, 9, 19, 15, 30);
  let now = finalTick + 15_000;
  t.mock.method(Date, 'now', () => now);
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const store = new ArchiveStore(db);
  const source = await store.initSource({ name: 'Automatic source', fakeid: 'auto-source' });
  const window = { ...automaticWindow(finalTick), tick: finalTick };
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: window.date,
    range_start: window.start, range_end: window.end });
  await store.updateJob(job.id, { progress: { dispatch_window: window } });
  await store.requestDispatch(job.id, 'scheduled');
  let status = 'running';
  let restarts = 0;
  let reads = 0;
  const env = { ARCHIVE_DB: db, ARCHIVE_AUTO_ENABLED: 'true', ARCHIVE_WORKFLOW: { get: async id => {
    assert.equal(id, job.workflow_id);
    reads++;
    return { status: async () => ({ status }), restart: async () => { restarts++; } };
  }, create: async () => assert.fail('Relaying a final authorization cannot create another workflow') } };
  assert.equal(await dispatchPending(env), 0);
  assert.equal((await store.listPendingDispatch()).length, 1);
  status = 'complete';
  now = finalTick + 60_000;
  assert.equal(await dispatchPending(env), 1);
  assert.equal(restarts, 1);
  assert.equal((await store.listPendingDispatch()).length, 0);
  assert.equal(await dispatchPending(env), 0);
  assert.equal(restarts, 1);

  await store.requestDispatch(job.id, 'scheduled');
  now = finalTick + 300_000;
  assert.equal(await dispatchPending(env), 0, 'An expired final authorization must not restart collection');
  now = finalTick + 120_000;
  await store.updateJob(job.id, { progress: { dispatch_window: window, final_capture_used: true } });
  assert.equal(await dispatchPending(env), 0, 'A consumed authorization cannot retry collection');
  await store.updateJob(job.id, { progress: { dispatch_window: { ...window, final: false, tick: finalTick - 300_000 } } });
  assert.equal(await dispatchPending(env), 0, 'A prior nonfinal tick cannot become a new authorization');
  assert.equal(reads, 2);
  assert.equal(restarts, 1);
  assert.equal((await store.listJobs()).length, 1);
  assert.equal((await store.listPendingDispatch()).length, 1);
});

test('a pinned RSS pending dispatch runs during daytime and retains the original publication-date quota', async t => {
  const clock = Date.parse('2026-10-20T12:00:00+08:00');
  t.mock.method(Date, 'now', () => clock);
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const store = new ArchiveStore(db);
  const source = await store.initSource({ name: '猫笔刀', fakeid: RSS_FAKEID });
  await store.updateSource(source.id, { enabled: true });
  await store.completeBaseline(source.id, [], clock - 2 * 86_400_000);
  const window = automaticWindow(Date.parse('2026-10-19T22:00:00+08:00'));
  const selected = { source_key: 'wechat:short:/s/rss-pending', url: 'https://mp.weixin.qq.com/s/rss-pending',
    published_at: window.start + 60_000, time_trusted: true,
    metadata: { source_kind: 'rss', rss_snapshot_key: `private/rss/articles/${'a'.repeat(64)}.json` } };
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: window.date,
    range_start: window.start, range_end: window.end });
  await store.selectDailyArticle(source.id, window.date, selected.source_key, job.id);
  await store.addJobArticle(job.id, selected);
  // Recovery may happen after the last five-minute grant; RSS keeps its fixed
  // article available all day without reserving the discovery day's quota.
  await store.patchJobProgress(job.id, { rss_poll: true, selected_article: selected,
    dispatch_window: { date: window.date, start: clock - 300_000, end: clock, tick: clock - 300_000, rss: true } });
  const created = [];
  const env = { ARCHIVE_DB: db, ARCHIVE_AUTO_ENABLED: 'true', ARCHIVE_WORKFLOW: {
    get: async () => { throw new Error('Workflow instance not found'); },
    create: async options => { created.push(options); return { id: options.id }; },
  } };
  assert.equal(automaticWindow(clock).active, false);
  assert.equal(await dispatchPending(env), 1);
  assert.equal(await dispatchPending(env), 0);
  assert.deepEqual(created, [{ id: job.workflow_id, params: { job_id: job.id } }]);
  assert.equal((await store.getJob(job.id)).article_key, selected.source_key);
  assert.equal((await store.getDaily(source.id, window.date)).status, 'selected');
  assert.equal((await store.getDaily(source.id, window.date)).capture_completed_at, null);
  assert.equal(await store.getDaily(source.id, '2026-10-20'), null);
});

test('RSS fetch failure still dispatches an already captured publication and propagates the original error', async t => {
  const clock = Date.parse('2026-10-20T12:00:00+08:00');
  t.mock.method(Date, 'now', () => clock);
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const store = new ArchiveStore(db);
  const source = await store.initSource({ name: '猫笔刀', fakeid: RSS_FAKEID });
  await store.updateSource(source.id, { enabled: true });
  await store.completeBaseline(source.id, [], clock - 2 * 86_400_000);
  const window = automaticWindow(Date.parse('2026-10-19T22:00:00+08:00'));
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: window.date,
    range_start: window.start, range_end: window.end });
  const selected = { source_key: 'wechat:short:/s/rss-ready', url: 'https://mp.weixin.qq.com/s/rss-ready' };
  await store.selectDailyArticle(source.id, window.date, selected.source_key, job.id);
  const { article } = await store.addJobArticle(job.id, selected);
  const lease = await store.claimArticle(article.id, 'saved-capture', 60_000);
  await store.patchArticle(article.id, { status: 'ready', captured_at: clock - 1000,
    body_key: `articles/${article.id}/body.html`, manifest: [] }, lease);
  await store.releaseLease(lease);

  const upstreamError = new CollectorError('UPSTREAM_ERROR', 'RSS synthetic fetch failure', true);
  let feeds = 0;
  t.mock.method(globalThis, 'fetch', async value => {
    const url = new URL(value);
    if (url.hostname === 'cloudflare-dns.com') {
      return Response.json({ Status: 0, Answer: url.searchParams.get('type') === 'A'
        ? [{ type: 1, data: '1.1.1.1' }] : [] });
    }
    assert.equal(url.href, RSS_FEED_URL);
    feeds++;
    throw upstreamError;
  });
  const created = [];
  const env = { ARCHIVE_DB: db, ARCHIVE_AUTO_ENABLED: 'true', ARCHIVE_BUCKET: {
    get: async () => null, put: async () => assert.fail('A failed feed cannot write a snapshot'),
  }, ARCHIVE_WORKFLOW: {
    get: async () => { throw new Error('Workflow instance not found'); },
    create: async options => { created.push(options); return { id: options.id }; },
  } };
  await assert.rejects(scheduledArchive({ scheduledTime: clock }, env), error => error === upstreamError);
  assert.equal(feeds, 1);
  assert.deepEqual(created, [{ id: job.workflow_id, params: { job_id: job.id } }]);
  assert.equal((await store.listPendingDispatch()).length, 0);
  assert.equal((await store.getArticle(article.id)).status, 'ready');
  assert.equal((await store.getArticle(article.id)).captured_at, clock - 1000);
  assert.equal((await store.getJob(job.id)).status, 'queued');
  assert.equal((await store.getDaily(source.id, window.date)).selected_article_key, selected.source_key);
  assert.equal((await store.listPublished()).length, 0);
});
