import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const mocks = {};
globalThis.__archiveExecutorMocks = mocks;
const names = ['searchSources', 'createLoginSession', 'getLoginSession', 'finishLoginSession', 'getLoginScreenshot'];
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'test:executor-cloudflare', shortCircuit: true };
    if (context.parentURL?.includes('/src/archive/executor.js')) {
      for (const name of ['collector', 'dispatch', 'runner', 'resources']) {
        if (specifier === `./${name}.js`) return { url: `test:executor-${name}`, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    let source;
    if (url === 'test:executor-cloudflare') source = 'export class DurableObject { constructor(ctx,env) { this.ctx=ctx;this.env=env; } }';
    if (url === 'test:executor-collector') source = names.map((name) => `export const ${name}=(...args)=>globalThis.__archiveExecutorMocks.${name}(...args);`).join('\n');
    if (url === 'test:executor-dispatch') source = 'export const scheduledArchive=(...args)=>globalThis.__archiveExecutorMocks.schedule(...args); export const dispatchPending=(...args)=>globalThis.__archiveExecutorMocks.pending(...args);';
    if (url === 'test:executor-runner') source = 'export const runArchiveBatch=(...args)=>globalThis.__archiveExecutorMocks.run(...args);';
    if (url === 'test:executor-resources') source = 'export const fetchImageResource=(...args)=>globalThis.__archiveExecutorMocks.fetchImage(...args);';
    return source ? { format: 'module', source, shortCircuit: true } : next(url, context);
  },
});
const { ArchiveExecutor } = await import('../src/archive/executor.js');
hooks.deregister();

function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const ctx = { storage: { sql: { exec(sql, ...values) {
    const statement = db.prepare(sql);
    const rows = statement.columns().length ? statement.all(...values) : (statement.run(...values), []);
    return { one() { assert.equal(rows.length, 1); return rows[0]; }, toArray() { return rows; } };
  } } } };
  const env = { marker: 'private-env-binding' };
  return { ctx, env, executor: new ArchiveExecutor(ctx, env) };
}

test('job execution has a synchronous persistent routing binding and one-page batches', async (t) => {
  const { ctx, env, executor } = setup(t);
  const calls = [];
  mocks.run = async (...args) => { calls.push(args); return { state: 'continue', job_id: args[1] }; };
  const window = { start: 1, end: 2, date: '2026-10-19', tick: 1, final: false };
  assert.equal((await executor.runBatch('job-a', window)).state, 'continue');
  assert.equal(calls[0][0], env);
  assert.deepEqual(calls[0][2], { maxPages: 1, maxArticles: 1, dispatchWindow: window });
  await assert.rejects(executor.runBatch('job-b', window), /绑定其他任务/);
  const restarted = new ArchiveExecutor(ctx, env);
  await assert.rejects(restarted.runBatch('job-b', window), /绑定其他任务/);
  assert.equal(calls.length, 1);
  assert.equal(executor.bindScope, undefined);
});

test('a second job cannot bind while the first RPC is awaiting external work', async (t) => {
  const { executor } = setup(t);
  let finish;
  mocks.run = () => new Promise((resolve) => { finish = resolve; });
  const first = executor.runBatch('job-first');
  await assert.rejects(executor.runBatch('job-second'), /绑定其他任务/);
  finish({ state: 'completed', job_id: 'job-first' });
  assert.equal((await first).state, 'completed');
});

test('collector RPC accepts only its fixed operation list and injects env on the server', async (t) => {
  const { executor, env } = setup(t);
  mocks.searchSources = async (receivedEnv, query) => {
    assert.equal(receivedEnv, env);
    return [{ fakeid: 'source', name: query }];
  };
  const searched = await executor.collectorOperation('searchSources', ['Example']);
  assert.deepEqual(searched, { ok: true, value: [{ fakeid: 'source', name: 'Example' }] });
  for (const name of ['__proto__', 'captureArticle', 'listSourceArticles', 'runBatch']) {
    assert.equal((await executor.collectorOperation(name, [])).error.code, 'INVALID_COLLECTOR_OPERATION');
  }
  assert.equal((await executor.collectorOperation('searchSources', [env, 'Example'])).ok, false);
  await assert.rejects(executor.runBatch('wrong-scope'), /绑定其他任务/);
});

test('collector screenshot is structured-cloneable with its actual Response body and headers', async (t) => {
  const { executor } = setup(t);
  const bytes = new Uint8Array([137, 80, 78, 71]);
  mocks.getLoginScreenshot = async (_env, id) => {
    assert.equal(id, 'login-id');
    return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store, private' } });
  };
  const response = structuredClone(await executor.collectorOperation('getLoginScreenshot', ['login-id']));
  assert.equal(response.ok, true);
  assert.equal(response.value.kind, 'screenshot');
  assert.deepEqual(new Uint8Array(response.value.bytes), bytes);
  const restored = new Response(response.value.bytes, { status: response.value.status, headers: response.value.headers });
  assert.equal(restored.headers.get('content-type'), 'image/png');
  assert.equal(restored.headers.get('cache-control'), 'no-store, private');
});

test('collector quota properties survive the RPC envelope and unknown errors hide internal details', async (t) => {
  const { executor } = setup(t);
  mocks.getLoginSession = async () => { throw Object.assign(new Error('Quota exhausted'), {
    code: 'BROWSER_QUOTA_EXCEEDED', retryable: false, retry_at: 1_800_000_000_000,
  }); };
  const quota = structuredClone(await executor.collectorOperation('getLoginSession', ['id']));
  assert.equal(quota.error.code, 'BROWSER_QUOTA_EXCEEDED');
  assert.equal(quota.error.retry_at, 1_800_000_000_000);
  mocks.getLoginSession = async () => { throw new Error('private-internal-token'); };
  const unknown = await executor.collectorOperation('getLoginSession', ['id']);
  assert.equal(unknown.error.code, 'EXECUTOR_ERROR');
  assert.doesNotMatch(unknown.error.message, /private-internal-token/);
});

test('schedule execution shares account scope and validates its timestamp', async (t) => {
  const { executor, env } = setup(t);
  mocks.schedule = async (controller, receivedEnv) => {
    assert.equal(controller.scheduledTime, 12345);
    assert.equal(receivedEnv, env);
    return { dispatched: 1 };
  };
  assert.deepEqual(await executor.runSchedule(12345), { dispatched: 1 });
  await assert.rejects(executor.runSchedule(-1), /调度时间无效/);
  await assert.rejects(executor.runBatch('wrong-job'), /绑定其他任务/);
});

test('each image executor binds one URL and returns cloneable image bytes without env arguments', async (t) => {
  const { ctx, env, executor } = setup(t);
  const url = 'https://images.example.com/photo.png';
  let calls = 0;
  mocks.fetchImage = async (...args) => {
    assert.deepEqual(args, [url]);
    calls++;
    return { url, bytes: new Uint8Array([1, 2, 3]), contentType: 'image/png' };
  };
  const image = structuredClone(await executor.fetchImage(url));
  assert.equal(image.ok, true);
  assert.deepEqual(image.value.bytes, new Uint8Array([1, 2, 3]));
  assert.equal(image.value.contentType, 'image/png');
  assert.equal((await executor.fetchImage('https://images.example.com/other.png')).error.code, 'EXECUTOR_BINDING_MISMATCH');
  const restarted = new ArchiveExecutor(ctx, env);
  assert.equal((await restarted.fetchImage('https://images.example.com/other.png')).ok, false);
  assert.equal(calls, 1);
  assert.equal(executor.bindResource, undefined);
});

test('resource executors cannot be reused for jobs or account operations', async (t) => {
  const { executor } = setup(t);
  mocks.fetchImage = async (url) => ({ url, bytes: new Uint8Array([1]), contentType: 'image/png' });
  await executor.fetchImage('https://images.example.com/photo.png');
  await assert.rejects(executor.runBatch('job-wrong-resource'), /图片执行器/);
  assert.equal((await executor.collectorOperation('getLoginSession', ['session'])).error.code, 'EXECUTOR_BINDING_MISMATCH');
  await assert.rejects(executor.runSchedule(12345), /图片执行器/);
});

test('a previously bound job cannot become an image resource executor', async (t) => {
  const { executor } = setup(t);
  mocks.run = async (_env, jobId) => ({ state: 'completed', job_id: jobId });
  await executor.runBatch('existing-job');
  let calls = 0;
  mocks.fetchImage = async () => { calls++; };
  assert.equal((await executor.fetchImage('https://images.example.com/photo.png')).error.code, 'EXECUTOR_BINDING_MISMATCH');
  assert.equal(calls, 0);
});

test('image error envelopes retain safe known attributes', async (t) => {
  const { executor } = setup(t);
  mocks.fetchImage = async () => { throw Object.assign(new Error('Image fetch rate limited'), {
    code: 'RATE_LIMITED', retryable: true, retry_at: 1_800_000_000_000, status: 429,
  }); };
  const image = structuredClone(await executor.fetchImage('https://images.example.com/photo.png'));
  assert.deepEqual(image.error, { code: 'RATE_LIMITED', message: 'Image fetch rate limited', retryable: true,
    retry_at: 1_800_000_000_000, status: 429 });
});

test('equivalent normalized image URLs can reuse their deterministic resource executor', async (t) => {
  const { executor } = setup(t);
  const received = [];
  mocks.fetchImage = async (url) => {
    received.push(url);
    return { url, bytes: new Uint8Array([1]), contentType: 'image/png' };
  };
  assert.equal((await executor.fetchImage('https://images.example.com:443/photo.png#fragment')).ok, true);
  assert.equal((await executor.fetchImage('https://images.example.com/photo.png')).ok, true);
  assert.deepEqual(received, ['https://images.example.com/photo.png', 'https://images.example.com/photo.png']);
});
