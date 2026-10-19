import { automaticWindow, sourceArticleKey } from './core.js';
import * as rssSource from './rss-source.js';
import { ArchiveStore } from './store.js';

const INTERVAL_MS = 300_000;
const STOPPED = new Set(['completed', 'partial_failed', 'failed', 'cancelled', 'paused', 'waiting_auth']);
const SNAPSHOT_KEY = /^private\/rss\/articles\/[a-f0-9]{64}\.json$/;

export const RSS_FAKEID = `rss:${rssSource.RSS_ACCOUNT_BIZ}`;
export const RSS_POLL_SLOT_MS = 6 * 3_600_000;
export function isRssSource(source) { return source?.fakeid === RSS_FAKEID; }

/**
 * Claims the feed read for the tick's six-hour UTC slot (Beijing 02:00, 08:00,
 * 14:00, 20:00). The caller releases the claim when the read did not complete,
 * so the next five-minute tick retries within the same slot.
 */
export async function claimRssPoll(env, store, tick) {
  if (env.ARCHIVE_AUTO_ENABLED !== 'true') return null;
  if (!(await store.listSources()).some(source => source.enabled && isRssSource(source))) return null;
  if (!Number.isSafeInteger(tick) || tick < 0) throw invalid('RSS 检查时间无效。');
  const now = Date.now();
  await store.statement(`DELETE FROM archive_leases WHERE resource LIKE 'rss-poll:%' AND expires_at<=?`, [now]).run();
  const slot = Math.floor(tick / RSS_POLL_SLOT_MS) * RSS_POLL_SLOT_MS;
  // Hold the claim past the slot's end; later slots use their own resource.
  return store.acquireLease(`rss-poll:${slot}`, `tick:${tick}`, Math.max(slot + RSS_POLL_SLOT_MS - now, 0) + RSS_POLL_SLOT_MS);
}

function invalid(message) {
  const error = new Error(message);
  error.code = 'RSS_SCHEDULE_INVALID';
  return error;
}

function entryKey(article) { return article.source_key || sourceArticleKey(article.url); }
function hasSnapshot(article) {
  return article?.metadata?.source_kind === 'rss' && SNAPSHOT_KEY.test(article.metadata.rss_snapshot_key || '');
}

function publicationWindow(article, source, fetchedAt) {
  const time = article.first_published_at ?? article.published_at;
  if (article.time_trusted !== true || !Number.isSafeInteger(time) || time <= source.activated_at || time > fetchedAt) return null;
  const window = automaticWindow(time);
  return time >= window.start && time < window.end ? window : null;
}

function dateWindow(date) {
  const time = Date.parse(`${date}T21:30:00+08:00`);
  const window = Number.isFinite(time) ? automaticWindow(time) : null;
  if (!window || window.date !== date) throw invalid('RSS 自动任务的原文日期无效。');
  return window;
}

function earlier(first, second) {
  const time = article => article.first_published_at ?? article.published_at;
  return time(first) - time(second) || entryKey(first).localeCompare(entryKey(second));
}

async function resumeDate({ env, store, source, window, articles, pendingJob, tick, dispatch, result }) {
  const daily = await store.getDaily(source.id, window.date);
  let job = daily?.job_id ? await store.getJob(daily.job_id) : pendingJob || null;
  if (daily?.selected_article_key && (!job || job.article_key !== daily.selected_article_key)) {
    throw invalid('RSS 当日已选文章与任务记录不一致，请检查原任务。');
  }
  if (await store.first(`SELECT source_id FROM archive_daily_runs WHERE monitor_date=?
      AND source_id!=? AND selected_article_key IS NOT NULL LIMIT 1`, [window.date, source.id])) return;
  if (!job) {
    if (!articles.length) return;
    job = await store.createJob({ kind: 'auto', source_id: source.id, monitor_date: window.date,
      range_start: window.start, range_end: window.end }, `rss-auto:${source.id}:${window.date}`);
  }
  if (STOPPED.has(job.status)) return;
  if (Number.isSafeInteger(job.progress?.dispatch_window?.tick) && job.progress.dispatch_window.tick > tick) return;
  if (job.source_id !== source.id || job.kind !== 'auto') {
    throw invalid('RSS 当日任务与来源或原文日期不一致。');
  }
  // A legacy carryover may also occupy a later day's quota. Its original task
  // retains that reservation; RSS must not turn it into another article/date.
  if (job.monitor_date !== window.date) return;

  // A persisted selection remains authoritative even after it leaves the feed.
  // A failed capture never permits selecting another article for the same date.
  const pinned = daily?.selected_article_key || job.article_key;
  const remembered = job.progress?.selected_article;
  let chosen = hasSnapshot(remembered) && (!pinned || entryKey(remembered) === pinned) ? remembered : null;
  if (!chosen && pinned) chosen = articles.find(article => entryKey(article) === pinned);
  if (!chosen && !pinned) chosen = articles[0];
  if (!chosen || !hasSnapshot(chosen)) return;
  const key = entryKey(chosen);
  if (pinned && key !== pinned) throw invalid('RSS 自动任务不能更换已选文章。');

  const dispatchWindow = { date: window.date, start: tick, end: tick + INTERVAL_MS,
    tick, active: true, final: false, rss: true };
  job = await store.patchJobProgress(job.id, { rss_poll: true, selected_article: chosen, dispatch_window: dispatchWindow });
  if (STOPPED.has(job.status)) return;
  if (!await store.selectDailyArticle(source.id, window.date, key, job.id)) return;
  if (!daily?.selected_article_key) result.selected++;
  await store.addJobArticle(job.id, chosen);
  await store.patchJobProgress(job.id, {}, { cursor: { enumeration_done: true } });

  const updated = await store.scheduleJob(job.id, dispatchWindow);
  if (!updated) return;
  await store.requestDispatch(job.id, 'scheduled');
  try { if (await dispatch(env, updated)) result.dispatched++; }
  catch {
    // The outbox already owns recovery; an ambiguous create must reuse this job.
    console.warn(JSON.stringify({ event: 'archive_rss_dispatch_pending', job_id: job.id }));
  }
}

/** Run inside the account executor: fetching/parsing and all snapshots precede selection. */
export async function dispatchRssSources({ env, store, collector = rssSource, now = Date.now,
  tick = now(), dispatchJob }) {
  const result = { sources: 0, baselined: 0, selected: 0, dispatched: 0 };
  if (env.ARCHIVE_AUTO_ENABLED !== 'true') return result;
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > Number.MAX_SAFE_INTEGER - INTERVAL_MS) {
    throw invalid('RSS 检查时间无效。');
  }
  store ||= new ArchiveStore(env.ARCHIVE_DB);
  const enabled = (await store.listSources()).filter(source => source.enabled);
  if (enabled.length > 1) throw invalid('只能启用一个自动监控来源。');
  if (enabled.some(isRssSource) && typeof dispatchJob !== 'function') throw invalid('RSS 任务派发器尚未配置。');
  for (const listed of enabled.filter(isRssSource)) {
    const lease = await store.acquireLease(`schedule:${listed.id}`, crypto.randomUUID(), 180_000);
    if (!lease) continue;
    try {
      let source = await store.getSource(listed.id);
      if (!source?.enabled || !isRssSource(source)) continue;
      // fetchSource returns only after every feed article has a durable body snapshot.
      const feed = await collector.fetchSource(env, source);
      if (!Array.isArray(feed?.articles) || feed.articles.length > 100
          || !Number.isSafeInteger(feed.fetched_at) || feed.fetched_at < 0
          || feed.articles.some(article => !hasSnapshot(article))) {
        throw invalid('RSS 正文快照尚未完整保存。');
      }
      result.sources++;
      if (!await store.renewLease(lease, 180_000)) throw invalid('RSS 检查租约已失效，下次检查将继续。');
      source = await store.getSource(source.id);
      if (!source?.enabled || !isRssSource(source)) continue;
      if (source.baseline_completed_at == null) {
        await store.completeBaseline(source.id, feed.articles, source.activated_at ?? feed.fetched_at);
        result.baselined++;
        continue;
      }
      if (!Number.isSafeInteger(source.activated_at) || source.activated_at < 0) {
        throw invalid('RSS 来源缺少有效的启用时间。');
      }

      const dates = new Map();
      for (const article of feed.articles) {
        const window = publicationWindow(article, source, feed.fetched_at);
        if (!window || await store.isBaselineArticle(source.id, entryKey(article))) continue;
        if (!dates.has(window.date)) dates.set(window.date, { window, articles: [] });
        dates.get(window.date).articles.push(article);
      }
      // Resume the same fixed article even when more than 20 newer feed entries exist.
      const pending = await store.all(`SELECT * FROM archive_jobs WHERE source_id=? AND kind='auto'
        AND json_extract(progress_json,'$.rss_poll')=1
        AND (article_key IS NOT NULL OR json_type(progress_json,'$.selected_article.source_key')='text')
        AND status NOT IN ('completed','partial_failed','failed','cancelled','paused','waiting_auth')
        ORDER BY created_at,id LIMIT 100`, [source.id]);
      for (const job of pending) {
        if (!dates.has(job.monitor_date)) dates.set(job.monitor_date, { window: dateWindow(job.monitor_date), articles: [] });
        dates.get(job.monitor_date).pendingJob = job;
      }
      for (const [, group] of [...dates].sort(([first], [second]) => first.localeCompare(second))) {
        if (!await store.renewLease(lease, 180_000)) throw invalid('RSS 检查租约已失效，下次检查将继续。');
        group.articles.sort(earlier);
        await resumeDate({ env, store, source, ...group, tick, dispatch: dispatchJob, result });
      }
    } finally { await store.releaseLease(lease); }
  }
  return result;
}
