import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ArchiveStore } from '../src/archive/store.js';
import { sourceArticleKey } from '../src/archive/core.js';

class D1Adapter {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const prepare = (values = []) => ({
      bind: (...bound) => prepare(bound),
      first: async () => this.sqlite.prepare(sql).get(...values) || null,
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
      rawRun: () => this.sqlite.prepare(sql).run(...values),
      run: async () => {
        const result = this.sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    });
    return prepare();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(statement.rawRun());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function setup(t) {
  const db = new D1Adapter();
  t.after(() => db.sqlite.close());
  return new ArchiveStore(db);
}

const sample = (suffix = 'one') => ({ url: `https://mp.weixin.qq.com/s/${suffix}`, title: `Article ${suffix}` });

test('baseline is immutable and records no public articles', async (t) => {
  const store = setup(t);
  const source = await store.initSource({ name: 'Example', fakeid: 'account' });
  const key = sourceArticleKey(sample().url);
  await store.completeBaseline(source.id, [sample()], 12345);
  await store.completeBaseline(source.id, [sample('later')], 54321);
  assert.equal(await store.isBaselineArticle(source.id, key), true);
  assert.equal(await store.isBaselineArticle(source.id, sourceArticleKey(sample('later').url)), false);
  assert.equal((await store.getSource(source.id)).activated_at, 12345);
  assert.deepEqual(await store.listPublished(), []);
});

test('job creation and dispatch outbox commit together with request idempotency', async (t) => {
  const store = setup(t);
  const input = { kind: 'manual', urls: [sample().url] };
  const first = await store.createJob(input, 'request-1');
  const second = await store.createJob(input, 'request-1');
  assert.equal(first.id, second.id);
  assert.equal(first.workflow_id, `archive-${first.id}`);
  assert.equal((await store.listPendingDispatch()).length, 1);
  await assert.rejects(store.createJob({ ...input, urls: [sample('two').url] }, 'request-1'), /another request/);
  assert.equal(await store.markDispatched(first.id, 'incorrect-instance'), false);
  assert.equal((await store.listPendingDispatch()).length, 1);
  await store.markDispatched(first.id, first.workflow_id);
  assert.deepEqual(await store.listPendingDispatch(), []);
  assert.equal('idempotency_key' in first, false);
  await assert.rejects(store.updateJob(first.id, { range_end: 123 }), /Unsupported/);
});

test('source uniqueness and shared job cancellation preserve the remaining consumer', async (t) => {
  const store = setup(t);
  const manual = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const source = await store.initSource({ name: 'Source', fakeid: 'source' });
  const auto = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: '2026-10-19' });
  const { article } = await store.addJobArticle(manual.id, sample());
  const shared = await store.addJobArticle(auto.id, sample());
  assert.equal(article.id, shared.article.id);
  assert.match(article.id, /^[a-f0-9]{32}$/);
  const lease = await store.claimArticle(article.id, manual.id, 60000);
  await store.setJobControl(manual.id, 'cancel');
  const published = await store.publishArticle(article.id, { body_key: 'articles/one/body.html', manifest: [] }, lease);
  assert.equal(published.status, 'published');
  assert.equal((await store.getJobItems(manual.id))[0].status, 'cancelled');
  assert.equal((await store.getJobItems(auto.id))[0].article_status, 'published');
});

test('a cancelled sole consumer cannot publish or claim', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const { article } = await store.addJobArticle(job.id, sample());
  const lease = await store.claimArticle(article.id, job.id, 60000);
  await store.setJobControl(job.id, 'cancel');
  assert.equal(await store.publishArticle(article.id, { body_key: 'body', manifest: [] }, lease), null);
  assert.equal(await store.claimArticle(article.id, 'other', 60000), null);
  await store.updateJob(job.id, { status: 'running' });
  assert.equal((await store.getJob(job.id)).status, 'cancelled');
});

test('lease generation fences stale workers even after the resource is released', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const { article } = await store.addJobArticle(job.id, sample());
  const first = await store.claimArticle(article.id, 'worker-a', 60000);
  assert.equal(await store.claimArticle(article.id, 'worker-b', 60000), null);
  await store.releaseLease(first);
  const second = await store.claimArticle(article.id, 'worker-b', 60000);
  assert.equal(second.generation, first.generation + 1);
  assert.equal(await store.patchArticle(article.id, { title: 'stale' }, first), null);
  assert.equal(await store.releaseLease(first), false);
  assert.equal((await store.patchArticle(article.id, { title: 'current' }, second)).title, 'current');
  store.db.sqlite.prepare('UPDATE archive_leases SET expires_at=0 WHERE resource=?').run(second.resource);
  assert.equal(await store.publishArticle(article.id, { body_key: 'body', manifest: [] }, second), null);
});

test('only published manifest entries can be served publicly', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const { article } = await store.addJobArticle(job.id, sample());
  const token = await store.claimArticle(article.id, job.id, 60000);
  const entry = { key: 'articles/one/image.png', size: 12, content_type: 'image/png' };
  await store.patchArticle(article.id, { manifest: [entry], body_key: 'articles/one/body.html', status: 'ready' }, token);
  assert.equal(await store.getPublicMedia(article.id, entry.key), null);
  await assert.rejects(store.publishArticle(article.id, { body_key: 'body', manifest: [entry, entry] }, token), /duplicate/);
  await store.publishArticle(article.id, { body_key: 'articles/one/body.html', manifest: [entry] }, token);
  assert.deepEqual(await store.getPublicMedia(article.id, entry.key), entry);
  assert.equal(await store.getPublicMedia(article.id, 'private/wechat-state/secret.json'), null);
  assert.equal(await store.getPublicMedia(article.id, 'articles/other/image.png'), null);
  assert.equal((await store.listPublished()).length, 1);
});

test('daily selection is single article and manual jobs never consume a date', async (t) => {
  const store = setup(t);
  const source = await store.initSource({ name: 'Source', fakeid: 'source' });
  const date = '2026-10-19';
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: date });
  const other = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: date });
  const manual = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const key = sourceArticleKey(sample().url);
  assert.equal(await store.getDaily(source.id, date), null);
  await store.addJobArticle(manual.id, sample());
  assert.equal(await store.getDaily(source.id, date), null);
  assert.equal((await store.selectDailyArticle(source.id, date, key, job.id)).job_id, job.id);
  assert.equal(await store.selectDailyArticle(source.id, date, 'article-two', other.id), null);
  assert.equal(await store.selectDailyArticle(source.id, date, 'article-two', job.id), null);
  assert.equal((await store.getJob(job.id)).article_key, key);
  assert.equal(await store.completeDaily(source.id, date), null);
  const { article } = await store.addJobArticle(job.id, sample());
  const lease = await store.claimArticle(article.id, job.id, 60000);
  await store.publishArticle(article.id, { body_key: 'body', manifest: [] }, lease);
  await store.completeDaily(source.id, date);
  assert.equal((await store.selectDailyArticle(source.id, date, key, job.id)).status, 'completed');
});

test('concurrent sources can select only one automatic article for the same Beijing date', async (t) => {
  const store = setup(t);
  const date = '2026-10-19';
  const sources = await Promise.all(['source-a', 'source-b'].map((fakeid) => store.initSource({ name: fakeid, fakeid })));
  const jobs = await Promise.all(sources.map((source) => store.createJob({ kind: 'auto', source_id: source.id, monitor_date: date })));
  const keys = sources.map((_, index) => sourceArticleKey(sample(`automatic-${index}`).url));
  const results = await Promise.all(sources.map((source, index) => store.selectDailyArticle(source.id, date, keys[index], jobs[index].id)));
  assert.equal(results.filter(Boolean).length, 1);
  for (let index = 0; index < sources.length; index++) {
    const chosen = Boolean(results[index]);
    assert.equal((await store.getJob(jobs[index].id)).article_key, chosen ? keys[index] : null);
    assert.equal((await store.getDaily(sources[index].id, date)).selected_article_key, chosen ? keys[index] : null);
  }
});

test('switching sources after completing the daily article cannot select a second article', async (t) => {
  const store = setup(t);
  const date = '2026-10-19';
  const firstSource = await store.initSource({ name: 'A', fakeid: 'source-a' });
  const secondSource = await store.initSource({ name: 'B', fakeid: 'source-b' });
  await store.updateSource(secondSource.id, { enabled: false });
  const firstJob = await store.createJob({ kind: 'auto', source_id: firstSource.id, monitor_date: date });
  const key = sourceArticleKey(sample('first-daily').url);
  await store.selectDailyArticle(firstSource.id, date, key, firstJob.id);
  const { article } = await store.addJobArticle(firstJob.id, sample('first-daily'));
  const lease = await store.claimArticle(article.id, firstJob.id, 60000);
  await store.publishArticle(article.id, { body_key: 'saved-body', manifest: [] }, lease);
  await store.completeDaily(firstSource.id, date);
  await store.updateSource(firstSource.id, { enabled: false });
  await store.updateSource(secondSource.id, { enabled: true });
  const secondJob = await store.createJob({ kind: 'auto', source_id: secondSource.id, monitor_date: date });
  assert.equal(await store.selectDailyArticle(secondSource.id, date, 'second-article', secondJob.id), null);
  assert.equal((await store.getJob(secondJob.id)).article_key, null);
  assert.equal((await store.getDaily(firstSource.id, date)).status, 'completed');
  const nextDay = '2026-10-20';
  const nextJob = await store.createJob({ kind: 'auto', source_id: secondSource.id, monitor_date: nextDay });
  assert.equal((await store.selectDailyArticle(secondSource.id, nextDay, 'next-article', nextJob.id)).job_id, nextJob.id);
});

test('a source disabled while its page was loading cannot make a first daily selection', async (t) => {
  const store = setup(t);
  const source = await store.initSource({ name: 'Source', fakeid: 'source' });
  const date = '2026-10-19';
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: date });
  await store.updateSource(source.id, { enabled: false });
  assert.equal(await store.selectDailyArticle(source.id, date, 'late-list-result', job.id), null);
  assert.equal((await store.getJob(job.id)).article_key, null);
  assert.equal((await store.getDaily(source.id, date)).selected_article_key, null);
  assert.equal((await store.getDaily(source.id, date)).job_id, null);
});

test('a previously selected automatic task can resume on a later day after its source is disabled', async (t) => {
  const store = setup(t);
  const source = await store.initSource({ name: 'Source', fakeid: 'source' });
  const date = '2026-10-19';
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: date });
  await store.selectDailyArticle(source.id, date, 'original-article', job.id);
  await store.updateSource(source.id, { enabled: false });
  const resumed = await store.selectDailyArticle(source.id, '2026-10-20', 'original-article', job.id);
  assert.equal(resumed.job_id, job.id);
  assert.equal(resumed.selected_article_key, 'original-article');
  assert.equal((await store.getJob(job.id)).article_key, 'original-article');
});

test('legacy ID remains stable when its short URL is resolved to the canonical list key', async (t) => {
  const store = setup(t);
  const legacyId = 'a'.repeat(32);
  const legacy = await store.importLegacyArticle({ id: legacyId, ...sample(), success: true });
  const longUrl = 'https://mp.weixin.qq.com/s?__biz=account&mid=123&idx=1&sn=tracking';
  const canonical = sourceArticleKey(longUrl);
  const job = await store.createJob({ kind: 'manual', urls: [longUrl] });
  const newer = await store.addJobArticle(job.id, { url: longUrl, source_key: canonical });
  assert.notEqual(newer.article.id, legacy.id);
  const merged = await store.resolveArticleIdentity(newer.article.id, legacy.source_key, sample().url);
  assert.equal(merged.id, legacyId);
  assert.equal((await store.getArticleByKey(canonical)).id, legacyId);
  assert.equal((await store.getArticle(newer.article.id)).id, legacyId);
  assert.equal((await store.getJobItems(job.id))[0].article_id, legacyId);
  const reused = await store.addJobArticle(job.id, { ...sample(), source_key: canonical });
  assert.equal(reused.article.id, legacyId);
  assert.equal((await store.listPublished()).length, 1);
});

test('collector source publication timestamp is separate from site publication', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const { article } = await store.addJobArticle(job.id, { ...sample(), published_at: 10000, time_trusted: true, author: 'Author' });
  assert.equal(article.first_published_at, 10000);
  assert.equal(article.published_at, null);
  assert.equal(article.metadata.author, 'Author');
  const token = await store.claimArticle(article.id, job.id, 60000);
  const published = await store.publishArticle(article.id, { body_key: 'body', manifest: [] }, token);
  assert.equal(published.first_published_at, 10000);
  assert.ok(published.published_at > 10000);
});

test('failed history items retry without changing a frozen range or cancelling shared articles', async (t) => {
  const store = setup(t);
  const source = await store.initSource({ name: 'Source', fakeid: 'source' });
  const job = await store.createJob({ kind: 'history', source_id: source.id, range_start: 1, range_end: 20000 });
  const { article } = await store.addJobArticle(job.id, sample());
  await store.updateJobItem(job.id, article.id, { status: 'failed', last_error: 'temporary' });
  await store.updateJob(job.id, { status: 'partial_failed', cursor: { page: 3 }, failed_count: 1 });
  await store.setJobControl(job.id, 'retry');
  assert.equal((await store.getJobItems(job.id))[0].status, 'pending');
  const retried = await store.getJob(job.id);
  assert.deepEqual(retried.cursor, { page: 3 });
  assert.equal(retried.range_end, 20000);
  assert.equal((await store.listPendingDispatch()).length, 1);
  await store.setJobControl(job.id, 'pause');
  assert.deepEqual(await store.listPendingDispatch(), []);
  await store.setJobControl(job.id, 'resume');
  assert.equal((await store.listPendingDispatch()).length, 1);
});

test('carryover excludes fully captured items but retains incomplete originals', async (t) => {
  const store = setup(t);
  const source = await store.initSource({ name: 'Source', fakeid: 'source' });
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: '2026-10-19', article_key: sourceArticleKey(sample().url) });
  const { article } = await store.addJobArticle(job.id, sample());
  assert.equal((await store.listCarryoverAutoJobs(source.id)).length, 1);
  const token = await store.claimArticle(article.id, job.id, 60000);
  await store.patchArticle(article.id, { status: 'ready', captured_at: Date.now() }, token);
  assert.deepEqual(await store.listCarryoverAutoJobs(source.id), []);
});

test('concurrent consumers retry an identity lock and still share one article', async (t) => {
  const store = setup(t);
  const first = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const second = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const results = await Promise.allSettled([
    store.addJobArticle(first.id, sample()), store.addJobArticle(second.id, sample()),
  ]);
  const rejected = results.findIndex((result) => result.status === 'rejected');
  assert.notEqual(rejected, -1);
  assert.equal(results[rejected].reason.status, 409);
  const recovered = await store.addJobArticle(rejected === 0 ? first.id : second.id, sample());
  const succeeded = results.find((result) => result.status === 'fulfilled').value;
  assert.equal(recovered.article.id, succeeded.article.id);
  assert.equal(store.db.sqlite.prepare('SELECT COUNT(*) AS total FROM archive_articles').get().total, 1);
});

test('automatic tasks reuse an already published URL alias without consuming a second article', async (t) => {
  const store = setup(t);
  const source = await store.initSource({ name: 'Source', fakeid: 'source' });
  const legacy = await store.importLegacyArticle({ ...sample(), id: 'b'.repeat(32), success: true });
  const canonical = 'wechat:source:123:1';
  const job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: '2026-10-19', article_key: canonical });
  const added = await store.addJobArticle(job.id, { ...sample(), source_key: canonical });
  assert.equal(added.article.id, legacy.id);
  await store.selectDailyArticle(source.id, '2026-10-19', canonical, job.id);
  assert.equal((await store.completeDaily(source.id, '2026-10-19')).status, 'completed');
  assert.deepEqual(await store.listCarryoverAutoJobs(source.id), []);
});

test('foreign-key failure does not leave an outbox entry for an uncreated job', async (t) => {
  const store = setup(t);
  await assert.rejects(store.createJob({ kind: 'baseline', source_id: 'missing' }), /FOREIGN KEY/);
  assert.deepEqual(await store.listJobs(), []);
  assert.deepEqual(await store.listPendingDispatch(), []);
});

test('failed legacy identity cannot replace an already published cloud article', async (t) => {
  const store = setup(t);
  const legacy = await store.importLegacyArticle({ ...sample('old-short'), id: 'd'.repeat(32), success: false });
  const canonicalUrl = 'https://mp.weixin.qq.com/s?__biz=account&mid=321&idx=1';
  const key = sourceArticleKey(canonicalUrl);
  const job = await store.createJob({ kind: 'manual', urls: [canonicalUrl] });
  const { article } = await store.addJobArticle(job.id, { url: canonicalUrl, title: 'Cloud title' });
  const token = await store.claimArticle(article.id, job.id, 60000);
  const metadata = { author: 'Cloud author', source_name: 'Source', retained: 'complete' };
  await store.publishArticle(article.id, { body_key: 'cloud/verified-body', manifest: [], metadata, content_text: 'Verified content' }, token);
  const resolved = await store.resolveArticleIdentity(legacy.id, key, canonicalUrl);
  assert.equal(resolved.id, article.id);
  assert.equal(resolved.status, 'published');
  assert.equal(resolved.body_key, 'cloud/verified-body');
  assert.equal(resolved.content_text, 'Verified content');
  assert.deepEqual(resolved.metadata, metadata);
  assert.equal((await store.getArticle(legacy.id)).id, article.id);
  assert.equal((await store.listPublished()).length, 1);
});

test('ready cloud content outranks a failed historical record and retains its body', async (t) => {
  const store = setup(t);
  const legacy = await store.importLegacyArticle({ ...sample('old-short'), id: 'e'.repeat(32), success: false });
  const job = await store.createJob({ kind: 'manual', urls: [sample('ready').url] });
  const { article } = await store.addJobArticle(job.id, sample('ready'));
  const token = await store.claimArticle(article.id, job.id, 60000);
  await store.patchArticle(article.id, { body_key: 'ready/body', manifest: [], captured_at: 12345, status: 'ready', metadata: { retained: true } }, token);
  const resolved = await store.resolveArticleIdentity(legacy.id, article.source_key, article.url);
  assert.equal(resolved.id, article.id);
  assert.equal(resolved.body_key, 'ready/body');
  assert.deepEqual(resolved.metadata, { retained: true });
  assert.equal((await store.getArticle(legacy.id)).id, article.id);
});

test('two published legacy records resolve deterministically and preserve old URL aliases', async (t) => {
  const store = setup(t);
  const first = await store.importLegacyArticle({ ...sample('legacy-one'), id: '1'.repeat(32), success: true });
  const second = await store.importLegacyArticle({ ...sample('legacy-two'), id: '2'.repeat(32), success: true });
  store.db.sqlite.prepare('UPDATE archive_articles SET created_at=1000').run();
  const resolved = await store.resolveArticleIdentity(second.id, first.source_key, first.url);
  assert.equal(resolved.id, first.id);
  assert.equal((await store.getArticle(second.id)).id, first.id);
  assert.equal((await store.getArticleByKey(second.source_key)).id, first.id);
});

test('an accepted create with an unknown response reuses the original pending dispatch generation', async (t) => {
  const store = setup(t);
  const input = { kind: 'manual', urls: [sample().url] };
  const job = await store.createJob(input, 'create-response-unknown');
  // The caller did not receive create's response or acknowledge dispatch acceptance.
  const replay = await store.createJob(input, 'create-response-unknown');
  const pending = await store.listPendingDispatch();
  assert.equal(replay.workflow_id, job.workflow_id);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].dispatch_generation, 1);
  assert.equal(pending[0].dispatch_reason, 'start');
  assert.equal((await store.getDispatch(job.id)).dispatched_generation, 0);
});

test('a stale dispatch acknowledgement cannot erase a newer continuation or auth request', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  await store.markDispatched(job.id, job.workflow_id, 1);
  const continuation = await store.requestDispatch(job.id, 'continue');
  const authentication = await store.requestDispatch(job.id, 'auth');
  assert.equal(continuation.generation, 2);
  assert.equal(authentication.generation, 3);
  assert.equal(authentication.dispatched_generation, 1);
  assert.equal(await store.markDispatched(job.id, job.workflow_id, continuation.generation), false);
  const [pending] = await store.listPendingDispatch();
  assert.equal(pending.dispatch_generation, 3);
  assert.equal(pending.dispatch_reason, 'auth');
  assert.equal(await store.markDispatched(job.id, job.workflow_id, authentication.generation), true);
  assert.deepEqual(await store.listPendingDispatch(), []);
});

test('resume and retry atomically request distinct dispatch generations', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const { article } = await store.addJobArticle(job.id, sample());
  await store.updateJobItem(job.id, article.id, { status: 'failed', attempts: 3 });
  await store.setJobControl(job.id, 'pause');
  await store.setJobControl(job.id, 'resume');
  assert.equal((await store.getDispatch(job.id)).generation, 2);
  assert.equal((await store.getDispatch(job.id)).reason, 'resume');
  assert.equal((await store.getJobItems(job.id))[0].attempts, 3);
  await store.updateJob(job.id, { status: 'partial_failed' });
  await store.setJobControl(job.id, 'retry');
  assert.equal((await store.getDispatch(job.id)).generation, 3);
  assert.equal((await store.getDispatch(job.id)).reason, 'retry');
  assert.equal((await store.getJobItems(job.id))[0].attempts, 0);
});

test('stale scheduler status updates and controls cannot resurrect a completed job', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  await store.updateJob(job.id, { status: 'completed' });
  assert.equal((await store.updateJob(job.id, { status: 'queued' })).status, 'completed');
  assert.equal((await store.updateJob(job.id, { status: 'retrying' })).status, 'completed');
  assert.equal((await store.setJobControl(job.id, 'cancel')).status, 'completed');
  assert.equal((await store.setJobControl(job.id, 'retry')).status, 'completed');
  assert.equal((await store.requestDispatch(job.id, 'scheduled')).generation, 1);
  assert.deepEqual(await store.listPendingDispatch(), []);
});

test('scheduling changes only the dispatch window and never revives a completed job', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const progress = { poll_tick: 123, scanned_pages: 7, final_poll_cursor: 10, quota_wait_until: 0 };
  await store.updateJob(job.id, { status: 'running', progress, cursor: { list_cursor: 15 } });
  const window = { date: '2026-10-19', start: 100, end: 200, tick: 150 };
  const queued = await store.scheduleJob(job.id, window);
  assert.equal(queued.status, 'queued');
  assert.deepEqual(queued.progress, { ...progress, dispatch_window: window });
  assert.deepEqual(queued.cursor, { list_cursor: 15 });
  await store.updateJob(job.id, { status: 'completed' });
  assert.equal(await store.scheduleJob(job.id, { ...window, tick: 180 }), null);
  assert.deepEqual((await store.getJob(job.id)).progress.dispatch_window, window);
  assert.equal((await store.getJob(job.id)).status, 'completed');
});

test('scheduling cannot bypass future retries, browser quota, authentication, or pause', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const window = { tick: Date.now() };
  const future = Date.now() + 60_000;
  await store.updateJob(job.id, { status: 'retrying', next_retry_at: future });
  assert.equal(await store.scheduleJob(job.id, window), null);
  await store.updateJob(job.id, { status: 'waiting_quota', next_retry_at: null, progress: { quota_wait_until: future } });
  assert.equal(await store.scheduleJob(job.id, window), null);
  await store.updateJob(job.id, { status: 'waiting_auth', progress: {} });
  assert.equal(await store.scheduleJob(job.id, window), null);
  await store.setJobControl(job.id, 'pause');
  assert.equal(await store.scheduleJob(job.id, window), null);
  assert.equal((await store.getJob(job.id)).status, 'paused');
});

test('an incremental checkpoint preserves a dispatch window written after an earlier read', async (t) => {
  const store = setup(t);
  const job = await store.createJob({ kind: 'manual', urls: [sample().url] });
  const oldWindow = { tick: 100 };
  const nextWindow = { tick: 200 };
  await store.scheduleJob(job.id, oldWindow);
  const before = await store.getJob(job.id);
  await store.scheduleJob(job.id, nextWindow);
  const checked = await store.patchJobProgress(job.id, { poll_tick: before.progress.dispatch_window.tick, login_version: null }, {
    cursor: { list_cursor: 5 }, scannedPage: true,
  });
  assert.deepEqual(checked.progress, { dispatch_window: nextWindow, poll_tick: 100, login_version: null, scanned_pages: 1 });
  assert.deepEqual(checked.cursor, { list_cursor: 5 });
  await store.patchJobProgress(job.id, { auth_required: true }, { scannedPage: true });
  const rescheduled = await store.scheduleJob(job.id, { tick: 300 });
  assert.equal(rescheduled.progress.scanned_pages, 2);
  assert.equal(rescheduled.progress.auth_required, true);
  assert.equal(rescheduled.progress.poll_tick, 100);
  await store.setJobControl(job.id, 'pause');
  const paused = await store.patchJobProgress(job.id, {}, { status: 'completed', cursor: { list_cursor: 10 }, scannedPage: true });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.progress.scanned_pages, 3);
  await store.setJobControl(job.id, 'resume');
  await store.updateJob(job.id, { status: 'completed' });
  const terminal = await store.patchJobProgress(job.id, { auth_required: false }, { cursor: { list_cursor: 20 }, scannedPage: true });
  assert.equal(terminal.progress.scanned_pages, 3);
  assert.deepEqual(terminal.cursor, { list_cursor: 10 });
});
