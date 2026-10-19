import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { scheduledArchive, dispatchPending } from '../src/archive/dispatch.js';
import { automaticWindow } from '../src/archive/core.js';
import { runArchiveBatch } from '../src/archive/runner.js';
import { ArchiveStore } from '../src/archive/store.js';

class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8'));
    this.sqlite.exec('CREATE TABLE archive_admin_attempts(reset_at INTEGER)');
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
      const results = statements.map(statement => statement.rawRun());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}

const at = time => Date.parse(`2026-10-19T${time}+08:00`);
const tickWindow = time => ({ ...automaticWindow(at(time)), tick: at(time) });

async function setup(t, retryTime = '23:30:20') {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  t.mock.method(Date, 'now', () => at('23:29:59'));
  const store = new ArchiveStore(db);
  const source = await store.initSource({ name: 'Synthetic', fakeid: 'synthetic' });
  await store.completeBaseline(source.id, [], at('21:00:00'));
  await store.updateSource(source.id, { enabled: true });
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: '2026-10-19',
    range_start: at('21:30:00'), range_end: at('23:30:00') });
  await store.ensureDaily(source.id, job.monitor_date);
  await db.prepare('UPDATE archive_daily_runs SET job_id=? WHERE source_id=? AND monitor_date=?')
    .bind(job.id, source.id, job.monitor_date).run();
  await store.scheduleJob(job.id, tickWindow('23:25:00'));
  const dispatch = await store.getDispatch(job.id);
  await store.markDispatched(job.id, job.workflow_id, dispatch.generation);
  await store.patchJobProgress(job.id, { browser_wait_until: at(retryTime) });
  await store.updateJob(job.id, { status: 'retrying', next_retry_at: at(retryTime) });
  const calls = [];
  const env = { ARCHIVE_DB: db, ARCHIVE_BUCKET: {}, ARCHIVE_AUTO_ENABLED: 'true', ARCHIVE_WORKFLOW: {
    get: async id => {
      calls.push(['get', id]);
      return { status: async () => ({ status: 'complete' }), restart: async () => calls.push(['restart', id]) };
    },
  } };
  return { store, env, job, calls, dispatch };
}

test('a browser cooldown preserves the final tick without clearing the wait or calling the Workflow early', async t => {
  const { store, env, job, calls, dispatch } = await setup(t);
  t.mock.method(Date, 'now', () => at('23:30:00'));
  await scheduledArchive({ scheduledTime: Date.now() }, env);
  const saved = await store.getJob(job.id);
  assert.deepEqual(saved.progress.dispatch_window, tickWindow('23:30:00'));
  assert.equal(saved.progress.browser_wait_until, at('23:30:20'));
  assert.equal(saved.next_retry_at, at('23:30:20'));
  assert.equal(saved.status, 'retrying');
  assert.deepEqual(calls, []);
  assert.equal((await store.getDispatch(job.id)).generation, dispatch.generation + 1);

  // A running Workflow wakes with the new authorization and may request the
  // final source page exactly once, rather than returning awaiting_window.
  t.mock.method(Date, 'now', () => at('23:30:20'));
  let pages = 0;
  const collector = { listSourceArticles: async () => { pages++; return { articles: [], next_cursor: 0, has_more: false }; } };
  assert.equal((await runArchiveBatch(env, job.id, { collector })).state, 'idle');
  assert.equal((await store.getJob(job.id)).progress.final_poll_used, true);
  assert.equal((await runArchiveBatch(env, job.id, { collector })).state, 'awaiting_window');
  assert.equal(pages, 1);
});

test('an ended Workflow can be dispatched after the preserved final tick cooldown', async t => {
  const { store, env, job, calls } = await setup(t);
  t.mock.method(Date, 'now', () => at('23:30:00'));
  await scheduledArchive({ scheduledTime: Date.now() }, env);
  t.mock.method(Date, 'now', () => at('23:31:00'));
  assert.equal(await dispatchPending(env), 1);
  assert.deepEqual(calls, [['get', job.workflow_id], ['restart', job.workflow_id]]);
  assert.equal((await store.listPendingDispatch()).length, 0);
});

test('replaying an interrupted final tick repairs its missing outbox request while preserving the cooldown', async t => {
  const { store, env, job, calls, dispatch } = await setup(t);
  // Simulate interruption between the final-window write and requestDispatch.
  await store.patchJobProgress(job.id, { dispatch_window: tickWindow('23:30:00') });
  t.mock.method(Date, 'now', () => at('23:30:00'));
  await scheduledArchive({ scheduledTime: Date.now() }, env);
  assert.equal((await store.getDispatch(job.id)).generation, dispatch.generation + 1);
  assert.equal((await store.getJob(job.id)).next_retry_at, at('23:30:20'));
  assert.deepEqual(calls, []);
});

test('ordinary monitoring ticks do not clear or replace a browser cooldown', async t => {
  const { store, env, job, calls, dispatch } = await setup(t, '23:25:20');
  t.mock.method(Date, 'now', () => at('23:25:00'));
  await scheduledArchive({ scheduledTime: Date.now() }, env);
  const saved = await store.getJob(job.id);
  assert.equal(saved.next_retry_at, at('23:25:20'));
  assert.equal(saved.progress.dispatch_window.tick, at('23:25:00'));
  assert.equal((await store.getDispatch(job.id)).generation, dispatch.generation);
  assert.deepEqual(calls, []);
});

test('daily quota exhaustion cannot be converted into a final browser-capacity retry', async t => {
  const { store, env, job, calls, dispatch } = await setup(t);
  const resetAt = Date.parse('2026-10-20T00:00:00Z');
  await store.patchJobProgress(job.id, { quota_wait_until: resetAt });
  await store.updateJob(job.id, { status: 'waiting_quota', next_retry_at: resetAt });
  t.mock.method(Date, 'now', () => at('23:30:00'));
  await scheduledArchive({ scheduledTime: Date.now() }, env);
  const saved = await store.getJob(job.id);
  assert.equal(saved.progress.dispatch_window.final, false);
  assert.equal(saved.status, 'waiting_quota');
  assert.equal(saved.next_retry_at, resetAt);
  assert.equal((await store.getDispatch(job.id)).generation, dispatch.generation);
  assert.deepEqual(calls, []);
});

for (const consumed of [
  { final_capture_used: true },
  { final_poll_used: true, final_poll_tick: at('23:30:00'), final_poll_cursor: 0 },
]) {
  test(`an already consumed final ${consumed.final_capture_used ? 'capture' : 'poll'} is never authorized again`, async t => {
    const { store, env, job, calls, dispatch } = await setup(t);
    await store.patchJobProgress(job.id, { dispatch_window: tickWindow('23:30:00'), ...consumed });
    t.mock.method(Date, 'now', () => at('23:30:00'));
    await scheduledArchive({ scheduledTime: Date.now() }, env);
    assert.equal((await store.getDispatch(job.id)).generation, dispatch.generation);
    assert.equal((await store.getJob(job.id)).progress.dispatch_window.final, true);
    assert.deepEqual(calls, []);
  });
}

test('a preserved final tick never extends dispatch authorization beyond its existing five minute deadline', async t => {
  const { store, env, job, calls } = await setup(t, '23:36:00');
  t.mock.method(Date, 'now', () => at('23:30:00'));
  await scheduledArchive({ scheduledTime: Date.now() }, env);
  assert.equal((await store.getJob(job.id)).progress.dispatch_window.final, true);
  t.mock.method(Date, 'now', () => at('23:36:00'));
  assert.equal(await dispatchPending(env), 0);
  assert.deepEqual(calls, []);
});
