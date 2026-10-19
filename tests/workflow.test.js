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
        return operation(operationName, args);
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
  assert.equal(calls[0].ttl, 180_000);
  assert.match(calls[0].owner, /^prepare-login:/);
  assert.deepEqual(calls[1], { type: 'collector', name: 'wechat-account', operationName: 'createLoginSession', args: [] });
});

test('operator lifecycle verification reconnects twice and returns only status and screenshot sizes', async t => {
  const sessionId = 'private-session';
  const { calls, workflow, step } = fixture(t, { operation: async (name, args) => {
    if (name === 'createLoginSession') return { ok: true, value: {
      session_id: sessionId, live_view_url: 'https://private.example/?jwt=private',
    } };
    assert.deepEqual(args, [sessionId]);
    if (name === 'getLoginSession') return { ok: true, value: { status: 'waiting' } };
    assert.equal(name, 'getLoginScreenshot');
    return { ok: true, value: { bytes: new Uint8Array([7, 8, 9]) } };
  } });
  const result = await workflow.run({ payload: { action: 'prepare-login', verify_lifecycle: true } }, step);
  assert.deepEqual(result, { state: 'waiting_auth', prepared: true, checks: [
    { status: 'waiting', screenshot_bytes: 3 }, { status: 'waiting', screenshot_bytes: 3 },
  ] });
  assert.deepEqual(calls.filter(call => call.type === 'collector').map(call => call.operationName), [
    'createLoginSession', 'getLoginSession', 'getLoginScreenshot', 'getLoginSession', 'getLoginScreenshot',
  ]);
  assert.equal(calls.at(-1).type, 'release');
  assert.doesNotMatch(JSON.stringify(result), /private-session|private\.example|jwt/);
});

test('operator lifecycle verification stops and releases its lease when reconnecting expires', async t => {
  const { calls, workflow, step } = fixture(t, { operation: async name => name === 'createLoginSession'
    ? { ok: true, value: { session_id: 'private-session' } }
    : { ok: false, error: { code: 'LOGIN_EXPIRED' } } });
  assert.deepEqual(await workflow.run({ payload: { action: 'prepare-login', verify_lifecycle: true } }, step), {
    state: 'failed', phase: 'reconnect', code: 'LOGIN_EXPIRED',
  });
  assert.equal(calls.at(-1).type, 'release');
  assert.equal(calls.filter(call => call.type === 'collector').length, 2);
});

test('operator search verification repeats the real search and excludes account storage and identifiers', async t => {
  t.mock.method(globalThis, 'setTimeout', callback => { callback(); return 0; });
  const { calls, workflow, step } = fixture(t, { operation: async name => name === 'getBrowserStatus'
    ? { ok: true, value: { active_sessions: 0 } }
    : { ok: true, value: [{ name: 'Example', fakeid: 'private-fakeid', account_biz: 'private-biz' }] } });
  const result = await workflow.run({ payload: { action: 'verify-search', query: 'Example', verify_repeat: true } }, step);
  assert.deepEqual(result, { state: 'verified', before: { active_sessions: 0 }, searches: [
    { count: 1, names: ['Example'] }, { count: 1, names: ['Example'] },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /private-fakeid|private-biz/);
  assert.deepEqual(calls.filter(call => call.operationName === 'searchSources').map(call => call.args), [['Example'], ['Example']]);
  assert.equal(calls[0].ttl, 240_000);
  assert.equal(calls.at(-1).type, 'release');
});

test('operator list verification waits once and returns only bounded article metrics', async t => {
  const waits = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { waits.push(delay); callback(); return 0; });
  const { workflow, calls, step } = fixture(t, { operation: async name => {
    if (name === 'getBrowserStatus') return { ok: true, value: { active_sessions: 0 } };
    if (name === 'searchSources') return { ok: true, transport: 'http', value: [{ name: 'Example', fakeid: 'private-source' }] };
    return { ok: true, transport: 'http', value: { articles: [{ time_trusted: true, url: 'private-article' }], has_more: true } };
  } });
  const output = await workflow.run({ payload: { action: 'verify-search', query: 'Example', verify_articles: true } }, step);
  assert.deepEqual(waits, [60_000]);
  assert.equal(output.state, 'verified');
  assert.deepEqual(output.searches[0].article_page, { count: 1, trusted_times: 1, transport: 'http' });
  assert.doesNotMatch(JSON.stringify(output), /private-source|private-article/);
  assert.equal(calls.at(-1).type, 'release');
});

test('operator search verification reports a safe failure and always releases its lease', async t => {
  const { calls, workflow, step } = fixture(t, { operation: async name => name === 'getBrowserStatus'
    ? { ok: true, value: { active_sessions: 3 } }
    : { ok: false, error: { code: 'BROWSER_BUSY', diagnostic: 'browser_concurrency', retry_at: 2000 } } });
  assert.deepEqual(await workflow.run({ payload: { action: 'verify-search', query: 'Example' } }, step), {
    state: 'failed', code: 'BROWSER_BUSY', phase: null, diagnostic: 'browser_concurrency', retry_at: 2000,
    before: { active_sessions: 3 }, searches: [],
  });
  assert.equal(calls.at(-1).type, 'release');
});

test('a scheduled operator search waits without holding the account lease and performs one search', async t => {
  let clock = Date.parse('2026-10-19T06:00:00Z');
  const notBefore = Date.parse('2026-10-20T00:00:00Z');
  t.mock.method(Date, 'now', () => clock);
  const { calls, workflow, step } = fixture(t, { operation: async name => name === 'getBrowserStatus'
    ? { ok: true, value: { active_sessions: 0 } } : { ok: true, value: [{ name: 'Example' }] } });
  step.sleepUntil = async (name, timestamp) => {
    assert.equal(name, 'verify-search-scheduled');
    assert.equal(timestamp, notBefore);
    assert.deepEqual(calls, []);
    clock = timestamp;
  };
  const result = await workflow.run({ payload: { action: 'verify-search', query: 'Example', not_before: notBefore } }, step);
  assert.equal(result.state, 'verified');
  assert.equal(calls.filter(call => call.operationName === 'searchSources').length, 1);
  assert.equal(calls.at(-1).type, 'release');
});

test('a scheduled operator search expires after its target day without opening a browser', async t => {
  const clock = Date.parse('2026-10-21T00:00:00Z');
  t.mock.method(Date, 'now', () => clock);
  const { calls, workflow, step } = fixture(t);
  assert.deepEqual(await workflow.run({ payload: { action: 'verify-search', query: 'Example',
    not_before: Date.parse('2026-10-20T00:00:00Z') } }, step), { state: 'expired', code: 'VERIFICATION_EXPIRED' });
  assert.deepEqual(calls, []);
});

for (const code of ['BROWSER_QUOTA_EXCEEDED', 'BROWSER_BUSY', 'LOGIN_EXPIRED']) {
  test(`a resumed operator search records ${code} without scheduling another day or another login`, async t => {
    const clock = Date.parse('2026-10-20T00:01:00Z');
    t.mock.method(Date, 'now', () => clock);
    const { calls, workflow, step } = fixture(t, { operation: async name => name === 'getBrowserStatus'
      ? { ok: true, value: {} } : { ok: false, error: { code, retry_at: clock + 86_400_000 } } });
    step.sleepUntil = () => assert.fail('A resumed check cannot recursively wait for a later day');
    const result = await workflow.run({ payload: { action: 'verify-search', query: 'Example',
      not_before: Date.parse('2026-10-20T00:00:00Z') } }, step);
    assert.equal(result.code, code);
    assert.deepEqual(calls.filter(call => call.type === 'collector').map(call => call.operationName), ['getBrowserStatus', 'searchSources']);
    assert.equal(calls.at(-1).type, 'release');
  });
}

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

for (const state of ['waiting_quota', 'waiting_browser', 'waiting_source']) for (const retryAt of [500, 2000]) {
  test(`${state} recovery ${retryAt < 1000 ? 'skips a past sleep' : 'sleeps until a future reset'} before continuing the same job`, async t => {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    const { workflow, env, step } = fixture(t);
    const calls = [];
    const sleeps = [];
    env.ARCHIVE_EXECUTOR = { getByName: name => ({ async runBatch(jobId) {
      calls.push({ name, jobId });
      return calls.length === 1 ? { state, retry_at: retryAt } : { state: 'completed', job_id: jobId };
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
    assert.deepEqual(sleeps, retryAt < 1000 ? [] : [{ name: state === 'waiting_quota' ? 'quota-reset-0' : state === 'waiting_source' ? 'source-ready-0' : 'browser-ready-0', timestamp: retryAt }]);
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


test('operator capture verification returns only metrics and releases its account lease', async t => {
  const value = { title: 'Article', image_count: 2, image_bytes: 100, published_at: 1234, transport: 'http' };
  const { workflow, calls, step } = fixture(t, { operation: async (name, args) => {
    assert.equal(name, 'verifyArticle');
    assert.deepEqual(args, ['https://mp.weixin.qq.com/s/article']);
    return { ok: true, value };
  } });
  assert.deepEqual(await workflow.run({ payload: { action: 'verify-capture', url: 'https://mp.weixin.qq.com/s/article' } }, step), { state: 'verified', ...value });
  assert.equal(calls.at(-1).type, 'release');
});
