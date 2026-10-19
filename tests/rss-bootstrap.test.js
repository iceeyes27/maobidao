import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { bootstrapRss, RSS_BOOTSTRAP_KEY } from '../src/archive/rss-bootstrap.js';
import { RSS_ACCOUNT_BIZ, RSS_STATE_KEY } from '../src/archive/rss-source.js';
import { RSS_FAKEID } from '../src/archive/rss-schedule.js';
import { ArchiveStore } from '../src/archive/store.js';
import { sourceArticleKey } from '../src/archive/core.js';

const UPLOADED = Date.parse('2026-10-19T10:00:00Z');
const LATEST = Date.parse('2026-10-18T14:37:00Z');
const IMAGE = 'https://mmbiz.qpic.cn/mmbiz_png/synthetic/640?wx_fmt=png';
const ARTICLE_URL = index => `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(RSS_ACCOUNT_BIZ)}&mid=${2247498657 - index}&idx=1&sn=synthetic`;
const xmlText = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function feed(count = 20, account = RSS_ACCOUNT_BIZ) {
  const items = Array.from({ length: count }, (_, index) => `<item>
    <title>合成文章 ${index + 1}</title><link>${xmlText(ARTICLE_URL(index).replace(encodeURIComponent(RSS_ACCOUNT_BIZ), encodeURIComponent(account)))}</link>
    <pubDate>${new Date(LATEST - index * 86400_000).toUTCString()}</pubDate>
    <content:encoded><![CDATA[<p>完整的合成正文 ${index + 1}</p><img src="${xmlText(IMAGE)}">]]></content:encoded>
  </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>猫笔刀</title>${items}</channel></rss>`;
}

class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const prepared = (values = []) => ({
      bind: (...args) => prepared(args),
      first: async () => this.sqlite.prepare(sql).get(...values) || null,
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
      rawRun: () => this.sqlite.prepare(sql).run(...values),
      run: async () => ({ meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) } }),
    });
    return prepared();
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

class MemoryBucket {
  objects = new Map();
  writes = [];
  seed(key, body, overrides = {}) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
    this.objects.set(key, { bytes, uploaded: new Date(UPLOADED), ...overrides });
  }
  async get(key) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.byteLength, uploaded: object.uploaded,
      text: async () => new TextDecoder().decode(object.bytes), ...object.exposed } : null;
  }
  async put(key, body, options) {
    this.beforePut?.(key);
    if (this.failPut?.(key)) throw new Error('Synthetic R2 failure');
    this.seed(key, body, { options });
    this.writes.push(key);
  }
}

function setup(t, { xml = feed(), backup = true } = {}) {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  const store = new ArchiveStore(db);
  const bucket = new MemoryBucket();
  if (backup) bucket.seed(RSS_BOOTSTRAP_KEY, xml);
  return { db, store, bucket, env: { ARCHIVE_DB: db, ARCHIVE_BUCKET: bucket } };
}

function databaseState(db, { includeLeases = true } = {}) {
  const tables = db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'archive_%' ORDER BY name").all();
  return JSON.stringify(tables.filter(({ name }) => includeLeases || name !== 'archive_leases')
    .map(({ name }) => [name, db.sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

test('bootstrap saves all twenty body snapshots before creating jobs, items or baseline', async t => {
  const f = setup(t);
  f.bucket.beforePut = () => {
    for (const table of ['archive_sources', 'archive_jobs', 'archive_articles', 'archive_source_baseline']) {
      assert.equal(f.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    }
  };
  const addArticle = f.store.addJobArticle.bind(f.store);
  f.store.addJobArticle = async (jobId, article) => {
    assert.equal((await f.store.getJob(jobId)).status, 'paused');
    assert.equal((await f.store.listPendingDispatch()).length, 0);
    return addArticle(jobId, article);
  };
  let dispatched = 0;
  const result = await bootstrapRss(f.env, { store: f.store, dispatchJob: async (_env, job) => {
    dispatched++;
    assert.equal((await f.store.getJobItems(job.id)).length, 20);
    assert.equal((await f.store.getJob(job.id)).cursor.enumeration_done, true);
    assert.equal((await f.store.getSource(job.source_id)).enabled, true);
    return true;
  } });
  assert.equal(dispatched, 1);
  assert.equal(result.state, 'prepared');
  assert.equal(result.dispatched, true);
  assert.equal(result.article_count, 20);
  assert.equal(result.coverage_start, LATEST - 19 * 86400_000);
  assert.equal(result.coverage_end, LATEST);
  const source = await f.store.getSource(result.source_id);
  assert.equal(source.fakeid, RSS_FAKEID);
  assert.equal(source.enabled, true);
  assert.equal(source.activated_at, UPLOADED);
  assert.ok(source.baseline_completed_at);
  const job = await f.store.getJob(result.job_id);
  assert.equal(job.kind, 'history');
  assert.equal(job.range_start, result.coverage_start);
  assert.equal(job.range_end, LATEST + 1);
  assert.equal(job.progress.rss_bootstrap, true);
  assert.equal(job.progress.rss_prepared, true);
  assert.equal(job.progress.coverage_limited, false);
  assert.equal(job.progress.rss_articles.length, 20);
  assert.equal(job.cursor.enumeration_done, true);
  const items = await f.store.getJobItems(job.id);
  assert.equal(items.length, 20);
  assert.ok(items.every(item => item.status === 'pending' && item.article_status === 'pending'));
  for (const article of job.progress.rss_articles) {
    assert.equal(await f.store.isBaselineArticle(source.id, article.source_key), true);
    const snapshot = await f.bucket.get(article.metadata.rss_snapshot_key);
    assert.ok(snapshot?.size > 0);
    assert.equal(JSON.parse(await snapshot.text()).source_key, article.source_key);
  }
  assert.equal(f.bucket.writes.length, 22);
  assert.equal(f.bucket.writes.at(-1), RSS_STATE_KEY);
  assert.equal((await f.store.all('SELECT * FROM archive_daily_runs')).length, 0);
  assert.equal((await f.store.listPublished()).length, 0);
});

test('repeating bootstrap reuses the same job, baseline and article identities', async t => {
  const f = setup(t);
  const first = await bootstrapRss(f.env, { store: f.store });
  const original = await f.store.getJob(first.job_id);
  const articles = (await f.store.getJobItems(first.job_id)).map(item => item.article_id).sort();
  const second = await bootstrapRss(f.env, { store: f.store });
  assert.equal(second.state, 'already_prepared');
  assert.equal(f.bucket.writes.length, 22, 'A replay must not replace the live RSS source manifest with the initial feed');
  assert.equal(second.source_id, first.source_id);
  assert.equal(second.job_id, first.job_id);
  assert.equal((await f.store.listSources()).length, 1);
  assert.equal((await f.store.listJobs()).length, 1);
  assert.deepEqual((await f.store.getJobItems(first.job_id)).map(item => item.article_id).sort(), articles);
  assert.equal((await f.store.all('SELECT * FROM archive_source_baseline')).length, 20);
  assert.equal((await f.store.all('SELECT * FROM archive_articles')).length, 20);
  assert.equal((await f.store.all('SELECT * FROM archive_dispatch_outbox')).length, 1);
  assert.equal((await f.store.getJob(first.job_id)).workflow_id, original.workflow_id);
});

test('same-account WeChat jobs are paused with their progress, records and session preserved', async t => {
  const f = setup(t);
  const old = await f.store.initSource({ name: '猫笔刀旧来源', fakeid: 'legacy-wechat-fakeid', account_biz: RSS_ACCOUNT_BIZ });
  await f.store.completeBaseline(old.id, [sourceArticleKey(ARTICLE_URL(19))], UPLOADED - 86400_000);
  const jobs = [];
  for (const status of ['queued', 'running', 'waiting_auth', 'retrying', 'paused', 'completed', 'failed', 'cancelled', 'partial_failed']) {
    let job = await f.store.createJob({ kind: 'history', source_id: old.id, range_start: 1, range_end: UPLOADED });
    await f.store.patchJobProgress(job.id, { retained: status }, { cursor: { list_cursor: 17 } });
    job = await f.store.updateJob(job.id, { status, last_error: 'Synthetic previous error', next_retry_at: UPLOADED });
    jobs.push(job);
  }
  const saved = await f.store.addJobArticle(jobs[0].id, { url: ARTICLE_URL(0), title: '原有文章' });
  await f.store.db.prepare("UPDATE archive_session SET version=7,object_key='private/synthetic-session.json' WHERE singleton=1").run();
  const session = await f.store.first('SELECT * FROM archive_session');
  const result = await bootstrapRss(f.env, { store: f.store });
  assert.equal((await f.store.getSource(old.id)).enabled, false);
  assert.equal((await f.store.getSource(old.id)).activated_at, UPLOADED - 86400_000);
  assert.equal(await f.store.isBaselineArticle(old.id, sourceArticleKey(ARTICLE_URL(19))), true);
  assert.equal((await f.store.getSource(result.source_id)).enabled, true);
  assert.deepEqual(await f.store.first('SELECT * FROM archive_session'), session);
  for (const job of jobs) {
    const current = await f.store.getJob(job.id);
    assert.equal(current.status, ['queued', 'running', 'waiting_auth', 'retrying'].includes(job.status) ? 'paused' : job.status);
    assert.deepEqual(current.progress, job.progress);
    assert.deepEqual(current.cursor, job.cursor);
    assert.equal(current.next_retry_at, job.next_retry_at);
    assert.equal(current.last_error, job.last_error);
    assert.ok(await f.store.getDispatch(job.id));
  }
  assert.equal((await f.store.getJobItems(jobs[0].id))[0].article_id, saved.article.id);
  assert.equal((await f.store.getJobItems(result.job_id)).find(item => item.source_key === saved.article.source_key).article_id, saved.article.id);
  assert.ok((await f.store.listPendingDispatch()).every(job => job.source_id === result.source_id));
});

test('an unrelated active source prevents switching without changing database configuration', async t => {
  const f = setup(t);
  const other = await f.store.initSource({ name: '其他公众号', fakeid: 'unrelated', account_biz: 'unrelated-biz' });
  const before = databaseState(f.db, { includeLeases: false });
  await assert.rejects(bootstrapRss(f.env, { store: f.store }), /Another automatic source is enabled/);
  assert.equal(databaseState(f.db, { includeLeases: false }), before);
  assert.equal((await f.store.getSource(other.id)).enabled, true);
  assert.equal((await f.store.listSources()).length, 1);
  assert.equal((await f.store.listJobs()).length, 0);
});

test('missing, invalid or oversized original backups change no database state', async t => {
  const cases = [
    { name: 'missing', backup: false },
    { name: 'empty', xml: '' },
    { name: 'invalid XML', xml: '<not-rss>invalid</not-rss>' },
    { name: 'wrong account', xml: feed(20, 'unrelated-biz') },
    { name: 'oversized metadata', exposed: { size: 4 * 1024 * 1024 + 1 } },
    { name: 'invalid upload timestamp', uploaded: new Date(NaN) },
  ];
  for (const item of cases) await t.test(item.name, async sub => {
    const f = setup(sub, item);
    if (item.exposed || item.uploaded) Object.assign(f.bucket.objects.get(RSS_BOOTSTRAP_KEY), { exposed: item.exposed, ...(item.uploaded ? { uploaded: item.uploaded } : {}) });
    await f.store.initSource({ name: '保留来源', fakeid: RSS_ACCOUNT_BIZ });
    const before = databaseState(f.db);
    await assert.rejects(bootstrapRss(f.env, { store: f.store }));
    assert.equal(databaseState(f.db), before);
  });
});

test('snapshot persistence failure never creates a source, job or baseline', async t => {
  const f = setup(t);
  f.bucket.failPut = key => key === RSS_STATE_KEY;
  const before = databaseState(f.db);
  await assert.rejects(bootstrapRss(f.env, { store: f.store }), /RSS 正文快照保存失败/);
  assert.equal(databaseState(f.db), before);
  assert.equal((await f.store.listJobs()).length, 0);
});

test('interrupted preparation remains undispatchable and a retry resumes the same partial job', async t => {
  const f = setup(t);
  const addArticle = f.store.addJobArticle.bind(f.store);
  let calls = 0;
  f.store.addJobArticle = async (...args) => {
    if (++calls === 7) throw new Error('Synthetic D1 interruption');
    return addArticle(...args);
  };
  await assert.rejects(bootstrapRss(f.env, { store: f.store }), /Synthetic D1 interruption/);
  const [partial] = await f.store.listJobs();
  assert.equal(partial.status, 'paused');
  assert.equal((await f.store.getJobItems(partial.id)).length, 6);
  assert.equal((await f.store.listPendingDispatch()).length, 0);
  assert.equal((await f.store.getSource(partial.source_id)).enabled, false);
  assert.equal((await f.store.getSource(partial.source_id)).baseline_completed_at, null);
  f.store.addJobArticle = addArticle;
  const complete = await bootstrapRss(f.env, { store: f.store });
  assert.equal(complete.job_id, partial.id);
  assert.equal((await f.store.getJob(complete.job_id)).progress.rss_prepared, true);
  assert.equal((await f.store.getJobItems(complete.job_id)).length, 20);
  assert.equal((await f.store.listJobs()).length, 1);
});

test('replaying a prepared bootstrap preserves later job and source administrator controls', async t => {
  for (const status of ['paused', 'cancelled', 'completed', 'partial_failed', 'failed']) await t.test(status, async sub => {
    const f = setup(sub);
    const first = await bootstrapRss(f.env, { store: f.store });
    await f.store.updateJob(first.job_id, { status });
    await f.store.updateSource(first.source_id, { enabled: false });
    const originalJob = await f.store.getJob(first.job_id);
    const originalDispatch = await f.store.getDispatch(first.job_id);
    const repeated = await bootstrapRss(f.env, { store: f.store, dispatchJob: () => assert.fail('Prepared tasks must not be dispatched again') });
    assert.equal(repeated.state, 'already_prepared');
    assert.equal(repeated.job_id, first.job_id);
    assert.deepEqual(await f.store.getJob(first.job_id), originalJob);
    assert.deepEqual(await f.store.getDispatch(first.job_id), originalDispatch);
    assert.equal((await f.store.getSource(first.source_id)).enabled, false);
  });
});

test('preparation is atomic and pause, resume or retry cannot release an unfinished import', async t => {
  const f = setup(t);
  const createJob = f.store.createJob.bind(f.store);
  let checked = false;
  f.store.createJob = async (...args) => {
    const job = await createJob(...args);
    assert.equal(job.status, 'paused');
    assert.equal(job.progress.preparing, true);
    const originalDispatch = await f.store.getDispatch(job.id);
    for (const action of ['resume', 'retry', 'pause']) {
      await assert.rejects(f.store.setJobControl(job.id, action), error => error.status === 409 && /正在准备/.test(error.message));
      assert.deepEqual(await f.store.getJob(job.id), job);
      assert.deepEqual(await f.store.getDispatch(job.id), originalDispatch);
      assert.equal((await f.store.listPendingDispatch()).length, 0);
    }
    checked = true;
    return job;
  };
  const result = await bootstrapRss(f.env, { store: f.store });
  assert.equal(checked, true);
  const prepared = await f.store.getJob(result.job_id);
  assert.equal(prepared.progress.preparing, false);
  assert.equal(prepared.progress.rss_prepared, true);
  assert.equal(prepared.status, 'queued');
  assert.equal((await f.store.listPendingDispatch()).length, 1);
});

test('cancellation during preparation retains partial records and replay cannot resume the cancelled import', async t => {
  const f = setup(t);
  const old = await f.store.initSource({ name: '保留旧来源', fakeid: RSS_ACCOUNT_BIZ });
  const addArticle = f.store.addJobArticle.bind(f.store);
  let calls = 0;
  f.store.addJobArticle = async (jobId, article) => {
    if (++calls === 7) {
      const cancelled = await f.store.setJobControl(jobId, 'cancel');
      assert.equal(cancelled.status, 'cancelled');
    }
    return addArticle(jobId, article);
  };
  await assert.rejects(bootstrapRss(f.env, { store: f.store }), error => error.status === 409 && /cancelled/i.test(error.message));
  const [cancelled] = await f.store.listJobs();
  const items = await f.store.getJobItems(cancelled.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.progress.preparing, true);
  assert.equal(items.length, 6);
  assert.ok(items.every(item => item.status === 'cancelled'));
  assert.equal((await f.store.all('SELECT * FROM archive_articles')).length, 6);
  assert.equal((await f.store.listPendingDispatch()).length, 0);
  assert.equal((await f.store.getSource(old.id)).enabled, true);
  const repeated = await bootstrapRss(f.env, { store: f.store, dispatchJob: () => assert.fail('Cancelled imports cannot be dispatched') });
  assert.equal(repeated.state, 'already_prepared');
  assert.equal(repeated.job_id, cancelled.id);
  assert.deepEqual(await f.store.getJob(cancelled.id), cancelled);
  assert.deepEqual(await f.store.getJobItems(cancelled.id), items);
  assert.equal((await f.store.getSource(cancelled.source_id)).enabled, false);
});
