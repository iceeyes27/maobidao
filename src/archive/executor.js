import { DurableObject } from 'cloudflare:workers';
import * as collector from './collector.js';
import { validatePublicUrl } from './collector-security.js';
import { dispatchPending, scheduledArchive } from './dispatch.js';
import { runArchiveBatch } from './runner.js';
import { fetchImageResource } from './resources.js';

const OPERATIONS = new Map([
  ['searchSources', { call: collector.searchSources, minimum: 1, maximum: 1 }],
  ['getBrowserStatus', { call: collector.getBrowserStatus, minimum: 0, maximum: 0 }],
  ['createLoginSession', { call: collector.createLoginSession, minimum: 0, maximum: 1 }],
  ['getLoginSession', { call: collector.getLoginSession, minimum: 1, maximum: 1 }],
  ['finishLoginSession', { call: collector.finishLoginSession, minimum: 1, maximum: 1 }],
  ['getLoginScreenshot', { call: collector.getLoginScreenshot, minimum: 1, maximum: 1 }],
]);

function invalid(message, code = 'INVALID_EXECUTOR_REQUEST') {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function errorEnvelope(error) {
  const known = typeof error?.code === 'string';
  return { ok: false, error: {
    code: known ? error.code : 'EXECUTOR_ERROR',
    message: known ? error.message : '云端执行暂时失败，请稍后重试。',
    retryable: error?.retryable === true,
    status: Number.isInteger(error?.status) ? error.status : 500,
    ...(Number.isSafeInteger(error?.retry_at) ? { retry_at: error.retry_at } : {}),
    ...(typeof error?.phase === 'string' ? { phase: error.phase } : {}),
    ...(typeof error?.diagnostic === 'string' ? { diagnostic: error.diagnostic } : {}),
    ...(typeof error?.quota === 'string' ? { quota: error.quota } : {}),
  } };
}

/** CPU-intensive work runs here; Workflows retain only durable orchestration. */
export class ArchiveExecutor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_binding (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      scope TEXT NOT NULL CHECK(scope IN ('job','account')),
      job_id TEXT,
      CHECK((scope='job' AND job_id IS NOT NULL) OR (scope='account' AND job_id IS NULL))
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS executor_resource (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), url TEXT NOT NULL
    )`);
  }

  #bindScope(scope, jobId = null) {
    // These synchronous SQLite operations cannot interleave with another RPC request.
    if (this.ctx.storage.sql.exec('SELECT url FROM executor_resource WHERE singleton=1').toArray().length) {
      throw invalid('图片执行器不能用于账号或采集任务。', 'EXECUTOR_BINDING_MISMATCH');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO executor_binding(singleton,scope,job_id) VALUES (1,?,?)', scope, jobId);
    const saved = this.ctx.storage.sql.exec('SELECT scope,job_id FROM executor_binding WHERE singleton=1').one();
    if (saved.scope !== scope || saved.job_id !== jobId) {
      throw invalid('执行器已绑定其他任务，请使用对应的任务执行器。', 'EXECUTOR_BINDING_MISMATCH');
    }
  }

  #bindResource(url) {
    if (this.ctx.storage.sql.exec('SELECT scope FROM executor_binding WHERE singleton=1').toArray().length) {
      throw invalid('账号或任务执行器不能用于图片采集。', 'EXECUTOR_BINDING_MISMATCH');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO executor_resource(singleton,url) VALUES (1,?)', url);
    const saved = this.ctx.storage.sql.exec('SELECT url FROM executor_resource WHERE singleton=1').one();
    if (saved.url !== url) throw invalid('图片执行器已绑定其他图片地址。', 'EXECUTOR_BINDING_MISMATCH');
  }

  async runBatch(jobId, dispatchWindow) {
    if (typeof jobId !== 'string' || !jobId.trim() || jobId.length > 128) throw invalid('采集任务标识无效。');
    this.#bindScope('job', jobId);
    return runArchiveBatch(this.env, jobId, { maxPages: 1, maxArticles: 1, dispatchWindow });
  }

  async collectorOperation(name, args = []) {
    try {
      const operation = OPERATIONS.get(name);
      if (!operation || !Array.isArray(args) || args.length < operation.minimum || args.length > operation.maximum) {
        throw invalid('采集操作或参数无效。', 'INVALID_COLLECTOR_OPERATION');
      }
      this.#bindScope('account');
      const value = await operation.call(this.env, ...args);
      if (name === 'getLoginScreenshot') {
        if (!(value instanceof Response)) throw invalid('浏览器截图返回格式无效。', 'INVALID_SCREENSHOT');
        return { ok: true, value: {
          kind: 'screenshot', bytes: await value.arrayBuffer(), status: value.status, headers: [...value.headers],
        } };
      }
      return { ok: true, value };
    } catch (error) { return errorEnvelope(error); }
  }

  async runSchedule(tick) {
    if (!Number.isSafeInteger(tick) || tick < 0) throw invalid('调度时间无效。');
    this.#bindScope('account');
    return scheduledArchive({ scheduledTime: tick }, this.env);
  }

  async runPending() {
    this.#bindScope('account');
    return dispatchPending(this.env);
  }

  async fetchImage(url) {
    try {
      if (typeof url !== 'string' || !url || url.length > 8192) throw invalid('图片地址无效。');
      const normalized = validatePublicUrl(url).href;
      this.#bindResource(normalized);
      return { ok: true, value: await fetchImageResource(normalized) };
    } catch (error) { return errorEnvelope(error); }
  }
}
