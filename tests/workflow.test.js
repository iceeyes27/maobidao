import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const stores = new Map();
globalThis.__archiveWorkflowStores = stores;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'test:workflow-cloudflare', shortCircuit: true };
    if (context.parentURL?.endsWith('/src/archive/workflow.js') && specifier === './store.js') {
      return { url: 'test:workflow-store', shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    let source;
    if (url === 'test:workflow-cloudflare') source = 'export class WorkflowEntrypoint { constructor(ctx,env) { this.ctx=ctx;this.env=env; } }';
    if (url === 'test:workflow-store') source = 'export class ArchiveStore { constructor(db) { return globalThis.__archiveWorkflowStores.get(db); } }';
    return source ? { format: 'module', source, shortCircuit: true } : next(url, context);
  },
});
const { ArchiveWorkflow } = await import('../src/archive/workflow.js');
hooks.deregister();

function fixture(t, { lease = { resource: 'wechat-account', owner: 'test', generation: 1 }, operation = async () => ({ ok: true }) } = {}) {
  const db = {};
  const calls = [];
  const store = {
    acquireLease: async (resource, owner, ttl) => { calls.push({ type: 'acquire', resource, owner, ttl }); return lease; },
    releaseLease: async token => { assert.equal(token, lease); calls.push({ type: 'release' }); },
    getJob: async id => ({ id, kind: 'manual', progress: {} }),
  };
  stores.set(db, store);
  t.after(() => stores.delete(db));
  const env = { ARCHIVE_DB: db, ARCHIVE_EXECUTOR: { getByName(name) {
    return {
      async collectorOperation(operationName, args) {
        calls.push({ type: 'collector', name, operationName, args });
        return operation();
      },
    };
  } } };
  const step = { async do(_name, config, callback) { return (typeof config === 'function' ? config : callback)(); } };
  return { calls, env, step, store, workflow: new ArchiveWorkflow({}, env) };
}

test('operator login preparation acquires and releases the same account lease without returning login URLs', async t => {
  const { calls, workflow, step } = fixture(t, { operation: async () => ({ ok: true, value: {
    session_id: 'private-session', live_view_url: 'https://private.example/?jwt=private',
  } }) });
  const result = await workflow.run({ payload: { action: 'prepare-login' } }, step);
  assert.deepEqual(result, { state: 'waiting_auth', prepared: true });
  assert.deepEqual(calls.map(call => call.type), ['acquire', 'collector', 'release']);
  assert.equal(calls[0].resource, 'wechat-account');
  assert.equal(calls[0].ttl, 90_000);
  assert.match(calls[0].owner, /^prepare-login:/);
  assert.deepEqual(calls[1], { type: 'collector', name: 'wechat-account', operationName: 'createLoginSession', args: [] });
});

test('operator login preparation does not contact a browser while the account lease is busy', async t => {
  const { calls, workflow, step } = fixture(t, { lease: null });
  assert.deepEqual(await workflow.run({ payload: { action: 'prepare-login' } }, step), { state: 'busy', prepared: false, code: 'BUSY' });
  assert.deepEqual(calls.map(call => call.type), ['acquire']);
});

test('operator login preparation releases its lease when an RPC returns a failure envelope', async t => {
  const { calls, workflow, step } = fixture(t, { operation: async () => ({ ok: false, error: {
    code: 'UPSTREAM_ERROR', phase: 'goto', diagnostic: 'Safe diagnostic',
  } }) });
  assert.deepEqual(await workflow.run({ payload: { action: 'prepare-login' } }, step), {
    state: 'failed', code: 'UPSTREAM_ERROR', phase: 'goto', diagnostic: 'Safe diagnostic',
  });
  assert.equal(calls.at(-1).type, 'release');
});

test('operator login preparation releases its lease when the RPC transport throws', async t => {
  const { calls, workflow, step } = fixture(t, { operation: async () => { throw new Error('Connection interrupted'); } });
  await assert.rejects(workflow.run({ payload: { action: 'prepare-login' } }, step), /Connection interrupted/);
  assert.equal(calls.at(-1).type, 'release');
});

for (const retryAt of [500, 2000]) {
  test(`quota recovery ${retryAt < 1000 ? 'skips a past sleep' : 'sleeps until a future reset'} before continuing the same job`, async t => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const { workflow, env, step } = fixture(t);
    const calls = [];
    const sleeps = [];
    env.ARCHIVE_EXECUTOR = { getByName: name => ({ async runBatch(jobId) {
      calls.push({ name, jobId });
      return calls.length === 1 ? { state: 'waiting_quota', retry_at: retryAt } : { state: 'completed', job_id: jobId };
    } }) };
    step.sleepUntil = async (name, timestamp) => {
      assert.ok(timestamp >= now, 'The cloud runtime rejects sleepUntil in the past');
      sleeps.push({ name, timestamp });
      now = timestamp;
    };
    const result = await workflow.run({ payload: { job_id: 'same-job' } }, step);
    assert.deepEqual(result, { state: 'completed', job_id: 'same-job', dispatch_tick: null });
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.name === 'job:same-job' && call.jobId === 'same-job'));
    assert.deepEqual(sleeps, retryAt < 1000 ? [] : [{ name: 'quota-reset-0', timestamp: retryAt }]);
  });
}

for (const priorState of ['idle', 'awaiting_window']) {
  test(`an old ${priorState} result consumes a newer final check instead of ending the workflow`, async t => {
    const { workflow, env, step, store } = fixture(t);
    const oldTick = 1_800_000;
    const finalTick = oldTick + 300_000;
    const job = { id: 'auto-job', kind: 'auto', status: 'queued', article_key: null,
      progress: { dispatch_window: { tick: oldTick, final: false } } };
    store.getJob = async () => structuredClone(job);
    let writes = 0;
    store.updateJob = async () => { writes++; };
    store.db = { prepare: () => assert.fail('An old empty result cannot mark the final check as no update') };
    env.ARCHIVE_AUTO_ENABLED = 'true';
    const ticks = [];
    env.ARCHIVE_EXECUTOR = { getByName: () => ({ async runBatch(_jobId, window) {
      ticks.push(window.tick);
      if (ticks.length === 1) {
        job.progress.dispatch_window = { tick: finalTick, final: true };
        return { state: priorState };
      }
      return { state: 'completed' };
    } }) };
    const result = await workflow.run({ payload: { job_id: job.id } }, step);
    assert.deepEqual(ticks, [oldTick, finalTick]);
    assert.deepEqual(result, { state: 'completed', dispatch_tick: finalTick });
    assert.equal(writes, 0);
  });
}

test('only an empty result from the same final tick records no update', async t => {
  const { workflow, env, step, store } = fixture(t);
  const tick = 2_100_000;
  const job = { id: 'auto-job', kind: 'auto', status: 'queued', article_key: null,
    source_id: 'source', monitor_date: '2026-10-19', progress: { dispatch_window: { tick, final: true } } };
  store.getJob = async () => structuredClone(job);
  const updates = [];
  store.updateJob = async (id, patch) => updates.push({ id, patch });
  const daily = [];
  store.db = { prepare: sql => ({ bind: (...values) => ({ run: async () => daily.push({ sql, values }) }) }) };
  env.ARCHIVE_AUTO_ENABLED = 'true';
  env.ARCHIVE_EXECUTOR = { getByName: () => ({ runBatch: async () => ({ state: 'idle' }) }) };
  assert.deepEqual(await workflow.run({ payload: { job_id: job.id } }, step), { state: 'idle', dispatch_tick: tick });
  assert.deepEqual(updates, [{ id: job.id, patch: { status: 'completed', last_error: null } }]);
  assert.equal(daily.length, 1);
  assert.match(daily[0].sql, /status='no_update'/);
  assert.equal(daily[0].values[1], job.source_id);
  assert.equal(daily[0].values[2], job.monitor_date);
});
