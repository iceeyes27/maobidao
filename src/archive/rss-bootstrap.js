import { ArchiveStore } from './store.js';
import { createRssSource, RSS_ACCOUNT_BIZ } from './rss-source.js';
import { RSS_FAKEID } from './rss-schedule.js';
import { stableId } from './core.js';

export const RSS_BOOTSTRAP_KEY = 'private/rss/bootstrap-20261019.xml';

/** Operator-only import: freeze the original feed before changing source configuration. */
export async function bootstrapRss(env, { store = new ArchiveStore(env.ARCHIVE_DB), dispatchJob } = {}) {
  const sourceId = await stableId(`source:${RSS_FAKEID}`);
  const existing = await store.getJob(await stableId(`job:rss-bootstrap:${sourceId}:20261019`));
  if (existing?.progress.rss_prepared || existing && ['completed', 'cancelled', 'partial_failed', 'failed'].includes(existing.status)) {
    return { state: 'already_prepared', source_id: sourceId, job_id: existing.id,
      article_count: existing.progress.rss_articles?.length || 0, dispatched: false };
  }
  const object = await env.ARCHIVE_BUCKET.get(RSS_BOOTSTRAP_KEY);
  if (!object || object.size < 1 || object.size > 4 * 1024 * 1024) throw new Error('Initial RSS backup is missing or invalid');
  const xml = await object.text();
  const activatedAt = object.uploaded instanceof Date ? object.uploaded.getTime() : Date.now();
  const feed = await createRssSource({
    now: () => activatedAt,
    // The operator already stored this public feed in private R2. Parsing still
    // applies the same XML, account identity, time, image and body validations.
    fetchImpl: async () => new Response(xml, { headers: { 'content-type': 'application/rss+xml' } }),
    resolveHost: async () => {},
  }).fetchSource(env, { account_biz: RSS_ACCOUNT_BIZ });
  const lease = await store.acquireLease('source-config', `rss-bootstrap:${crypto.randomUUID()}`, 180_000);
  if (!lease) throw Object.assign(new Error('Source configuration is busy'), { status: 409 });
  let job;
  let source;
  try {
    const sources = await store.listSources();
    const target = item => item.fakeid === RSS_ACCOUNT_BIZ || item.account_biz === RSS_ACCOUNT_BIZ;
    if (sources.some(item => item.enabled && item.fakeid !== RSS_FAKEID && !target(item))) {
      throw new Error('Another automatic source is enabled');
    }
    source = await store.initSource({ name: '猫笔刀', fakeid: RSS_FAKEID, account_biz: RSS_ACCOUNT_BIZ, enabled: false });
    const start = Math.min(...feed.articles.map(article => article.published_at));
    const end = Math.max(...feed.articles.map(article => article.published_at)) + 1;
    job = await store.createJob({ kind: 'history', source_id: source.id, range_start: start, range_end: end },
      `rss-bootstrap:${source.id}:20261019`, { paused: true, preparing: true });
    if (job.progress.rss_prepared || ['completed', 'cancelled', 'partial_failed', 'failed'].includes(job.status)) {
      return { state: 'already_prepared', source_id: source.id, job_id: job.id,
        article_count: feed.articles.length, dispatched: false };
    }
    await store.patchJobProgress(job.id, { rss_bootstrap: true, rss_articles: feed.articles,
      coverage_start: start, coverage_end: end - 1, coverage_limited: false });
    for (const article of feed.articles) await store.addJobArticle(job.id, article);
    await store.patchJobProgress(job.id, {}, { cursor: { enumeration_done: true } });
    await store.completeBaseline(source.id, feed.articles, activatedAt);
    for (const old of sources.filter(item => item.fakeid !== RSS_FAKEID && target(item))) {
      await store.updateSource(old.id, { enabled: false });
      const pending = await store.all(`SELECT id FROM archive_jobs WHERE source_id=?
        AND status NOT IN ('cancelled','completed','partial_failed','failed','paused')`, [old.id]);
      for (const previous of pending) await store.setJobControl(previous.id, 'pause');
    }
    source = await store.updateSource(source.id, { enabled: true });
    // Preparation and release are atomic: the dispatch outbox cannot expose a
    // half-filled history job, and retries preserve later administrator controls.
    await store.db.batch([
      store.statement(`UPDATE archive_jobs SET status='queued',
        progress_json=json_set(progress_json,'$.rss_prepared',json('true'),'$.preparing',json('false')),updated_at=?
        WHERE id=? AND status='paused' AND COALESCE(json_extract(progress_json,'$.rss_prepared'),0)=0`, [Date.now(), job.id]),
      store.statement(`UPDATE archive_dispatch_outbox SET reason='start',dispatched_at=NULL,
        generation=generation+1 WHERE job_id=? AND changes()>0`, [job.id]),
    ]);
    job = await store.getJob(job.id);
  } finally { await store.releaseLease(lease); }
  const dispatched = dispatchJob ? await dispatchJob(env, job) : false;
  return { state: 'prepared', source_id: source.id, job_id: job.id, article_count: feed.articles.length,
    coverage_start: job.range_start, coverage_end: job.range_end - 1, dispatched };
}
