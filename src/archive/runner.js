import * as defaultCollector from './collector.js';
import { automaticWindow, eligibleArticle, sanitizeBody, sha256, sourceArticleKey } from './core.js';
import { ArchiveStore } from './store.js';

const LEASE_MS = 180_000;
const AUTH_CODES = new Set(['LOGIN_EXPIRED', 'LOGIN_REQUIRED', 'LOGIN_STALE', 'CHALLENGE_REQUIRED']);
const encoder = new TextEncoder();

class BusyError extends Error {}

function result(state, jobId) { return { state, job_id: jobId }; }
function failure(message, code = 'ARCHIVE_FAILED', retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}
function errorText(error) { return `${error.code || 'ARCHIVE_FAILED'}: ${error.message || '采集失败'}`; }
function trustedTime(article) {
  const value = article.first_published_at ?? article.published_at;
  return article.time_trusted === true && Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function withLease(store, token, operation) {
  let timer;
  let stopped = false;
  let lost = false;
  let renewal = Promise.resolve();
  const schedule = () => {
    timer = setTimeout(() => {
      renewal = store.renewLease(token, LEASE_MS).then((renewed) => {
        if (!renewed) lost = true;
      }).catch(() => { lost = true; }).finally(() => { if (!stopped && !lost) schedule(); });
    }, 30_000);
  };
  schedule();
  try {
    const value = await operation(() => !lost);
    if (lost) throw new BusyError('Execution lease expired');
    return value;
  } finally {
    stopped = true;
    clearTimeout(timer);
    await renewal;
    await store.releaseLease(token);
  }
}

async function withAccount(context, operation) {
  if (context.quotaRetryAt > context.now()) {
    const error = failure('云端浏览器免费额度暂不可用，等待额度恢复', 'BROWSER_QUOTA_EXCEEDED');
    error.retry_at = context.quotaRetryAt;
    throw error;
  }
  if (context.browserRetryAt > context.now()) {
    const error = failure('云端浏览器暂忙，稍后继续当前任务', 'BROWSER_BUSY', true);
    error.retry_at = context.browserRetryAt;
    throw error;
  }
  const token = await context.store.acquireLease('wechat-account', context.owner, LEASE_MS);
  if (!token) throw new BusyError('The source account is in use');
  return withLease(context.store, token, operation);
}

async function boundary(context) {
  const job = await context.store.getJob(context.job.id);
  context.job = job;
  if (job.status === 'cancelled' || job.status === 'paused') return job.status;
  if (job.kind !== 'auto') {
    const automatic = await context.store.all(`SELECT * FROM archive_jobs
      WHERE kind='auto' AND status IN ('queued','running') AND id!=? ORDER BY created_at LIMIT 100`, [job.id]);
    for (const pending of automatic) {
      const window = pending.progress.dispatch_window || automaticWindow(context.now());
      const time = context.now();
      const active = time >= window.start && time < window.end;
      const final = window.final && window.tick === window.end && time >= window.end
        && time < window.end + 300_000 && !pending.progress.final_capture_used;
      if ((pending.monitor_date === window.date || pending.article_key) && (active || final)) return 'continue';
      if (pending.article_key) {
        const article = await context.store.getArticleByKey(pending.article_key);
        if (article?.captured_at != null && article.status !== 'published') return 'continue';
      }
    }
  }
  return null;
}

function captureAllowed(context, attempts = 0) {
  if (context.job.kind !== 'auto') return true;
  const time = context.now();
  if (time >= context.window.start && time < context.window.end) return true;
  return context.finalGrant && attempts === 0 && !context.job.progress.final_capture_used;
}

async function rememberProgress(context, patch) {
  context.job = await context.store.patchJobProgress(context.job.id, patch);
}

async function checkpointPage(context, cursor, patch = {}) {
  context.job = await context.store.patchJobProgress(context.job.id, {}, {
    last_error: null, ...patch, cursor, scannedPage: true,
  });
}

function pollTick(context) {
  return Number.isSafeInteger(context.window.tick) ? context.window.tick : Math.floor(context.now() / 300_000) * 300_000;
}

async function startAutomaticPoll(context) {
  if (context.job.kind !== 'auto' || context.job.article_key) return null;
  if (!captureAllowed(context)) return 'awaiting_window';
  const tick = pollTick(context);
  const current = await context.store.getJob(context.job.id);
  if (Number.isSafeInteger(current.progress.poll_tick) && current.progress.poll_tick > tick) return 'continue';
  if (current.progress.poll_tick !== tick) {
    context.job = await context.store.patchJobProgress(current.id, { poll_tick: tick }, {
      cursor: { list_cursor: 0, visited: [], enumeration_done: false },
    });
  }
  return null;
}

async function reserveFinalPage(context, cursor) {
  const progress = context.job.progress;
  const tick = pollTick(context);
  // Record before requesting the page: an ambiguous response must never repeat that request.
  if (progress.final_poll_used && (progress.final_poll_tick !== tick
      || !Number.isSafeInteger(progress.final_poll_cursor) || cursor <= progress.final_poll_cursor)) return false;
  await rememberProgress(context, { final_poll_used: true, final_poll_tick: tick, final_poll_cursor: cursor });
  return true;
}

async function markAuth(context, error) {
  const session = await context.store.first('SELECT version FROM archive_session WHERE singleton=1');
  await rememberProgress(context, {
    auth_required: true, login_version: null, auth_failed_version: session?.version ?? 0,
    ...(context.job.kind === 'auto' && context.now() >= context.window.end && context.finalGrant ? { final_capture_used: true } : {}),
  });
  await context.store.updateJob(context.job.id, { status: 'waiting_auth', last_error: errorText(error) });
  return result('waiting_auth', context.job.id);
}

async function markQuota(context, error) {
  const now = context.now();
  const retryAt = Number.isSafeInteger(error.retry_at) && error.retry_at > now
    ? error.retry_at : (Math.floor(now / 86_400_000) + 1) * 86_400_000;
  await rememberProgress(context, { quota_wait_until: retryAt });
  const job = await context.store.updateJob(context.job.id, {
    status: 'waiting_quota', next_retry_at: retryAt, last_error: errorText(error),
  });
  await counters(context);
  return { ...result(['paused', 'cancelled', 'completed'].includes(job.status) ? job.status : 'waiting_quota', job.id), retry_at: retryAt };
}

function browserWaitResult(job, retryAt) {
  const state = job.status === 'partial_failed' ? 'completed'
    : ['paused', 'cancelled', 'completed'].includes(job.status) ? job.status : 'waiting_browser';
  return { ...result(state, job.id), retry_at: retryAt };
}

async function canFinishWithoutBrowser(store, job) {
  if (job.kind === 'auto' && job.article_key) {
    return (await store.getArticleByKey(job.article_key))?.captured_at != null;
  }
  if (!job.cursor?.enumeration_done) return false;
  const items = await store.getJobItems(job.id);
  return items.every((item) => ['completed', 'failed', 'cancelled'].includes(item.status) || item.captured_at != null);
}

async function markBrowserWait(context, error) {
  const now = context.now();
  const retryAt = Number.isSafeInteger(error.retry_at) && error.retry_at > now ? error.retry_at : now + 20_000;
  await rememberProgress(context, { browser_wait_until: retryAt });
  const job = await context.store.updateJob(context.job.id, {
    status: 'retrying', next_retry_at: retryAt, last_error: errorText(error),
  });
  await counters(context);
  return browserWaitResult(job, retryAt);
}

async function markSourceWait(context, error) {
  const time = context.now();
  const retryAt = Number.isSafeInteger(error.retry_at) && error.retry_at > time ? error.retry_at : time + 300_000;
  await rememberProgress(context, { source_wait_until: retryAt });
  const job = await context.store.updateJob(context.job.id, {
    status: 'retrying', next_retry_at: retryAt, last_error: errorText(error),
  });
  await counters(context);
  return { ...result(['paused', 'cancelled', 'completed'].includes(job.status) ? job.status : 'waiting_source', job.id), retry_at: retryAt };
}

async function counters(context) {
  const items = await context.store.getJobItems(context.job.id);
  const counts = {
    discovered_count: items.length,
    completed_count: items.filter((item) => item.status === 'completed').length,
    failed_count: items.filter((item) => item.status === 'failed').length,
  };
  await context.store.updateJob(context.job.id, counts);
  return { items, ...counts };
}

async function markCaptured(context) {
  if (context.job.kind !== 'auto') return;
  for (const date of new Set([context.job.monitor_date, context.window.date])) {
    const daily = await context.store.getDaily(context.job.source_id, date);
    if (daily?.job_id === context.job.id) await context.store.completeDaily(context.job.source_id, date, {
      capture_completed_at: context.now(), status: 'captured',
    });
  }
}

async function markPublished(context) {
  if (context.job.kind !== 'auto') return;
  for (const date of new Set([context.job.monitor_date, context.window.date])) {
    const daily = await context.store.getDaily(context.job.source_id, date);
    if (daily?.job_id === context.job.id) await context.store.completeDaily(context.job.source_id, date);
  }
}

async function verifyStored(context, article) {
  if (!article.body_key) throw failure('文章正文尚未保存', 'BODY_INCOMPLETE', true);
  const body = await context.bucket.head(article.body_key);
  if (!body || body.size < 1) throw failure('文章正文存储校验失败', 'BODY_INCOMPLETE', true);
  for (const image of article.manifest) {
    const stored = await context.bucket.head(image.key);
    if (!stored || stored.size !== image.bytes) throw failure('文章图片存储校验失败', 'IMAGE_INCOMPLETE', true);
  }
}

async function verifiedPut(context, key, value, contentType) {
  try {
    await context.bucket.put(key, value, { httpMetadata: { contentType } });
    const stored = await context.bucket.head(key);
    const size = typeof value === 'string' ? encoder.encode(value).byteLength : value.byteLength;
    if (!stored || stored.size !== size) throw new Error('Object size mismatch');
  } catch {
    throw failure('文章资源写入或存储校验失败', 'STORAGE_WRITE_FAILED', true);
  }
}

async function saveCapture(context, article, captured, token) {
  if (!captured.title?.trim() || !captured.html?.trim() || !Array.isArray(captured.images)) {
    throw failure('来源没有完整可识别的文章正文', 'ARTICLE_INVALID');
  }
  const manifestByKey = new Map();
  const imageMap = new Map();
  for (const image of captured.images) {
    const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes);
    if (!bytes.byteLength || !image.source_url || !/^image\//.test(image.content_type || '')) {
      throw failure('文章图片不完整', 'IMAGE_INCOMPLETE', true);
    }
    const hash = await sha256(bytes);
    const key = `articles/${article.id}/images/${hash}`;
    if (!manifestByKey.has(key)) {
      await verifiedPut(context, key, bytes, image.content_type);
      manifestByKey.set(key, { key, public_id: hash, content_type: image.content_type, bytes: bytes.byteLength });
    }
    imageMap.set(image.source_url, `/media/${article.id}/${hash}`);
  }
  const html = sanitizeBody(captured.html, imageMap);
  if (!html.trim()) throw failure('清理后的文章正文为空', 'ARTICLE_INVALID');
  const bodyKey = `articles/${article.id}/body-${await sha256(html)}.html`;
  await verifiedPut(context, bodyKey, html, 'text/html; charset=utf-8');
  const sourceTime = captured.published_at ?? article.first_published_at;
  const saved = await context.store.patchArticle(article.id, {
    title: captured.title.trim(), account_name: captured.source_name || article.account_name,
    first_published_at: sourceTime, content_text: captured.text || '', summary: (captured.text || '').slice(0, 160),
    metadata: { ...article.metadata, author: captured.author || '', source_name: captured.source_name || '',
      original_url: captured.original_url || article.url },
    body_key: bodyKey, manifest: [...manifestByKey.values()], status: 'ready', captured_at: context.now(), last_error: null,
  }, token);
  if (!saved) throw new BusyError('The article lease is no longer current');
  await markCaptured(context);
  return saved;
}

async function publishReady(context, article, token) {
  await verifyStored(context, article);
  const published = await context.store.publishArticle(article.id, {
    body_key: article.body_key, manifest: article.manifest, captured_at: article.captured_at,
  }, token);
  if (!published) {
    const current = await context.store.getArticle(article.id);
    if (current?.status !== 'published') throw new BusyError('The article lease is no longer current');
  }
  await context.store.updateJobItem(context.job.id, article.id, { status: 'completed', last_error: null });
  await markPublished(context);
}

async function processItem(context, item) {
  let article = await context.store.getArticle(item.article_id);
  if (article.status === 'published') {
    await context.store.updateJobItem(context.job.id, article.id, { status: 'completed', last_error: null });
    await markCaptured(context);
    await markPublished(context);
    return null;
  }
  const windowDate = context.job.kind === 'auto' ? context.window.date : null;
  if (context.job.kind === 'auto' && item.attempt_window !== windowDate) {
    item = await context.store.updateJobItem(context.job.id, article.id, {
      status: 'pending', attempts: 0, attempt_window: windowDate, last_error: null,
    });
  }
  if (article.captured_at == null && (!captureAllowed(context, item.attempts) || item.attempts >= 3)) return 'awaiting_window';
  let token = await context.store.claimArticle(article.id, context.owner, LEASE_MS);
  if (!token) throw new BusyError('The article is in use');
  try {
    return await withLease(context.store, token, async () => {
      if (article.captured_at != null) {
        await publishReady(context, article, token);
        return null;
      }
      while (item.attempts < 3) {
        if (!captureAllowed(context, item.attempts)) return 'awaiting_window';
        const control = await boundary(context);
        if (control) return control;
        const before = item.attempts;
        if (context.job.kind === 'auto' && context.now() >= context.window.end) {
          await rememberProgress(context, { final_capture_used: true });
        }
        item = await context.store.updateJobItem(context.job.id, article.id, {
          attempts: before + 1, attempt_window: windowDate, status: 'running', last_error: null,
        });
        try {
          const captured = await withAccount(context, () => context.collector.captureArticle(context.env, article));
          if (context.job.kind !== 'manual' && captured.published_at != null
              && (captured.published_at < context.job.range_start || captured.published_at >= context.job.range_end)) {
            throw failure('正文首次发布时间与选定范围不一致', 'PUBLICATION_TIME_MISMATCH');
          }
          const canonical = captured.source_key || sourceArticleKey(captured.original_url || article.url);
          if (canonical !== article.source_key || captured.original_url && captured.original_url !== article.url) {
            const resolved = await context.store.resolveArticleIdentity(article.id, canonical, captured.original_url || article.url);
            if (resolved.id !== article.id) {
              await context.store.releaseLease(token);
              article = resolved;
              if (article.status === 'published') {
                await context.store.updateJobItem(context.job.id, article.id, { status: 'completed', last_error: null });
                await markCaptured(context); await markPublished(context);
                return null;
              }
              token = await context.store.claimArticle(article.id, context.owner, LEASE_MS);
              if (!token) throw new BusyError('The canonical article is in use');
              if (article.captured_at != null) {
                await markCaptured(context);
                await publishReady(context, article, token);
                return null;
              }
            } else article = resolved;
            context.job = await context.store.getJob(context.job.id);
          }
          article = await saveCapture(context, article, captured, token);
          await publishReady(context, article, token);
          return null;
        } catch (error) {
          if (error instanceof BusyError) {
            await context.store.updateJobItem(context.job.id, article.id, { attempts: before, status: 'pending' });
            throw error;
          }
          if (['BROWSER_QUOTA_EXCEEDED', 'BROWSER_BUSY', 'RATE_LIMITED'].includes(error.code)) {
            await context.store.updateJobItem(context.job.id, article.id, {
              attempts: before, status: 'pending', last_error: null,
            });
            await context.store.patchArticle(article.id, { status: 'pending', last_error: null }, token);
            throw error;
          }
          if (AUTH_CODES.has(error.code)) {
            await context.store.updateJobItem(context.job.id, article.id, { attempts: before, status: 'pending', last_error: errorText(error) });
            throw error;
          }
          const current = await context.store.getArticle(article.id);
          if (current?.captured_at != null) {
            await context.store.updateJobItem(context.job.id, article.id, { status: 'pending', last_error: errorText(error) });
            throw error;
          }
          if (!error.code) throw error;
          await context.store.updateJobItem(context.job.id, article.id, { last_error: errorText(error) });
          if (!error.retryable || item.attempts >= 3) {
            await context.store.updateJobItem(context.job.id, article.id, { status: 'failed', last_error: errorText(error) });
            if (context.job.kind === 'auto') return 'awaiting_window';
            return null;
          }
          await context.store.updateJobItem(context.job.id, article.id, { status: 'pending' });
          if (context.job.kind === 'auto') return captureAllowed(context, item.attempts) ? 'continue' : 'awaiting_window';
          // The Workflow schedules the next attempt with a delay; other history items may continue now.
          return null;
        }
      }
      return context.job.kind === 'auto' ? 'awaiting_window' : null;
    });
  } finally {
    // Identity merging can replace the original article token during the operation.
    if (token) await context.store.releaseLease(token);
  }
}

async function enumerate(context) {
  const job = context.job;
  const cursor = job.cursor || { list_cursor: 0 };
  if (job.kind === 'manual') {
    if (!cursor.enumeration_done) {
      for (const url of job.urls) await context.store.addJobArticle(job.id, { url });
      await context.store.updateJob(job.id, { cursor: { ...cursor, enumeration_done: true } });
    }
    return null;
  }
  if (job.kind === 'auto' && job.article_key) {
    const existing = await context.store.getArticleByKey(job.article_key);
    const selected = job.progress.selected_article;
    if (!existing && !selected) throw failure('已绑定文章缺少恢复地址', 'ARTICLE_IDENTITY_MISSING');
    await context.store.addJobArticle(job.id, existing || { ...selected, source_key: job.article_key });
    return null;
  }
  if (cursor.enumeration_done && job.kind !== 'auto') return null;
  const source = await context.store.getSource(job.source_id);
  if (!source) throw failure('来源公众号不存在', 'SOURCE_NOT_FOUND');
  if (job.kind === 'auto' && (!source.enabled || source.baseline_completed_at == null)) return 'paused';
  let pageCursor = Number(cursor.list_cursor || 0);
  const visited = new Set(cursor.visited || []);
  for (let pageIndex = 0; pageIndex < context.maxPages; pageIndex++) {
    const control = await boundary(context);
    if (control) return control;
    if (job.kind === 'auto' && !captureAllowed(context)) return 'awaiting_window';
    if (job.kind === 'auto' && context.now() >= context.window.end && context.finalGrant) {
      if (!await reserveFinalPage(context, pageCursor)) return 'awaiting_window';
    }
    const page = await withAccount(context, () => context.collector.listSourceArticles(context.env, source, { cursor: pageCursor, count: 5 }));
    if (!Array.isArray(page.articles) || typeof page.has_more !== 'boolean') throw failure('来源分页格式无效', 'SOURCE_FORMAT_CHANGED');
    if (page.has_more && (!Number.isSafeInteger(page.next_cursor) || page.next_cursor <= pageCursor || visited.has(page.next_cursor))) {
      throw failure('来源分页游标没有前进', 'SOURCE_FORMAT_CHANGED');
    }
    if (job.kind === 'baseline') {
      await context.store.completeBaseline(source.id, page.articles, context.now());
      await checkpointPage(context, { list_cursor: page.next_cursor, enumeration_done: true }, { status: 'completed' });
      return 'completed';
    }
    if (job.kind === 'auto') {
      const eligible = [];
      for (const entry of page.articles) {
        if (trustedTime(entry) != null && eligibleArticle(entry, source, { start: job.range_start, end: job.range_end })
            && !await context.store.isBaselineArticle(source.id, entry.source_key || sourceArticleKey(entry.url))) eligible.push(entry);
      }
      eligible.sort((a, b) => trustedTime(a) - trustedTime(b) || (a.source_key || a.url).localeCompare(b.source_key || b.url));
      if (eligible.length) {
        const chosen = eligible[0];
        const key = chosen.source_key || sourceArticleKey(chosen.url);
        await rememberProgress(context, { selected_article: chosen });
        const selected = await context.store.selectDailyArticle(source.id, job.monitor_date, key, job.id);
        if (!selected) throw new BusyError('Another automatic job selected the daily article');
        await context.store.addJobArticle(job.id, chosen);
        await checkpointPage(context, { ...cursor, list_cursor: page.next_cursor, enumeration_done: true });
        context.job = await context.store.getJob(job.id);
        return null;
      }
    } else {
      for (const entry of page.articles) {
        const publishedAt = trustedTime(entry);
        if (publishedAt != null && (publishedAt < job.range_start || publishedAt >= job.range_end)) continue;
        const added = await context.store.addJobArticle(job.id, entry);
        if (publishedAt == null) await context.store.updateJobItem(job.id, added.article.id, {
          status: 'failed', last_error: 'UNTRUSTED_TIME: 无法核实文章首次发布时间，未纳入历史范围',
        });
      }
    }
    visited.add(pageCursor);
    pageCursor = page.next_cursor;
    const complete = !page.has_more;
    await checkpointPage(context, {
      list_cursor: complete && job.kind === 'auto' ? 0 : pageCursor,
      visited: complete && job.kind === 'auto' ? [] : [...visited], enumeration_done: complete && job.kind !== 'auto',
    });
    if (complete) return job.kind === 'auto' ? 'idle' : null;
  }
  return null;
}

/** Durable state lives in D1; this function processes only bounded pages and articles. */
export async function runArchiveBatch(env, jobId, {
  now = Date.now, maxPages = 10, maxArticles = 20, dispatchWindow, collector = defaultCollector, store,
} = {}) {
  store ||= new ArchiveStore(env.ARCHIVE_DB);
  let job = await store.getJob(jobId);
  if (!job) throw failure('采集任务不存在', 'JOB_NOT_FOUND');
  if (job.status === 'cancelled' || job.status === 'paused') return result(job.status, jobId);
  if (job.status === 'completed' || job.status === 'partial_failed') return result('completed', jobId);
  const quotaRetryAt = Number(job.progress.quota_wait_until || (job.status === 'waiting_quota' ? job.next_retry_at : 0) || 0);
  if (quotaRetryAt > now()) {
    const selected = job.article_key ? await store.getArticleByKey(job.article_key) : null;
    if (selected?.captured_at == null) {
      if (job.status !== 'waiting_quota' || job.next_retry_at !== quotaRetryAt) {
        job = await store.updateJob(jobId, { status: 'waiting_quota', next_retry_at: quotaRetryAt });
      }
      return { ...result(['paused', 'cancelled', 'completed'].includes(job.status) ? job.status : 'waiting_quota', jobId), retry_at: quotaRetryAt };
    }
  }
  const browserRetryAt = Number(job.progress.browser_wait_until || 0);
  if (browserRetryAt > now() && !await canFinishWithoutBrowser(store, job)) {
    if (job.status !== 'retrying' || job.next_retry_at !== browserRetryAt) {
      job = await store.updateJob(jobId, { status: 'retrying', next_retry_at: browserRetryAt });
    }
    return browserWaitResult(job, browserRetryAt);
  }
  const sourceRetryAt = Number(job.progress.source_wait_until || 0);
  if (sourceRetryAt > now() && !await canFinishWithoutBrowser(store, job)) {
    return { ...result('waiting_source', job.id), retry_at: sourceRetryAt };
  }
  if (!env.ARCHIVE_BUCKET) throw failure('尚未配置文章存储', 'CONFIG_MISSING');
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(maxArticles) || maxArticles < 1) throw failure('批次大小无效', 'INVALID_BATCH');
  const owner = `${jobId}:${crypto.randomUUID()}`;
  const token = await store.acquireLease(`job:${jobId}`, owner, LEASE_MS);
  if (!token) return result('busy', jobId);
  const window = dispatchWindow || job.progress.dispatch_window || automaticWindow(now());
  const context = { env, job, store, now, collector, owner, bucket: env.ARCHIVE_BUCKET,
    maxPages, maxArticles, window, quotaRetryAt, browserRetryAt,
    finalGrant: job.kind === 'auto' && window.final === true && window.tick === window.end
      && now() >= window.end && now() < window.end + 300_000 && !job.progress.final_capture_used,
  };
  const execute = async () => {
    try {
      const control = await boundary(context);
      if (control) return result(control, jobId);
      if (context.quotaRetryAt && context.quotaRetryAt <= now()) {
        await rememberProgress(context, { quota_wait_until: null });
        await store.updateJob(jobId, { next_retry_at: null });
      }
      if (context.browserRetryAt && context.browserRetryAt <= now()) {
        await rememberProgress(context, { browser_wait_until: null });
        if (context.job.next_retry_at === context.browserRetryAt) await store.updateJob(jobId, { next_retry_at: null });
      }
      if (sourceRetryAt && sourceRetryAt <= now()) {
        await rememberProgress(context, { source_wait_until: null });
        if (context.job.next_retry_at === sourceRetryAt) await store.updateJob(jobId, { next_retry_at: null });
      }
      await store.updateJob(jobId, { status: 'running' });
      const pollState = await startAutomaticPoll(context);
      if (pollState) {
        await store.updateJob(jobId, { status: pollState === 'continue' ? 'queued' : pollState });
        return result(pollState, jobId);
      }
      const enumeration = await enumerate(context);
      if (enumeration) {
        if (enumeration === 'completed') return result('completed', jobId);
        await store.updateJob(jobId, { status: enumeration === 'idle' ? 'queued' : enumeration });
        await counters(context);
        return result(enumeration, jobId);
      }
      job = context.job = await store.getJob(jobId);
      const items = await store.getJobItems(jobId);
      let processed = 0;
      for (const item of items) {
        if (item.status === 'completed' || item.status === 'cancelled') continue;
        if (item.status === 'failed' && !(job.kind === 'auto' && item.attempt_window !== window.date)) {
          if (job.kind === 'auto') {
            await store.updateJob(jobId, { status: 'awaiting_window' });
            return result('awaiting_window', jobId);
          }
          continue;
        }
        const interrupted = await boundary(context);
        if (interrupted) return result(interrupted, jobId);
        if (processed >= maxArticles) return result('continue', jobId);
        const state = await processItem(context, item);
        processed++;
        await counters(context);
        if (state) {
          await store.updateJob(jobId, { status: state === 'continue' ? 'queued' : state });
          return result(state, jobId);
        }
      }
      const summary = await counters(context);
      const current = await store.getJob(jobId);
      if (current.status === 'paused' || current.status === 'cancelled') return result(current.status, jobId);
      if (current.cursor?.enumeration_done || job.kind === 'auto' && job.article_key) {
        if (summary.items.some((item) => !['completed', 'failed', 'cancelled'].includes(item.status))) return result('continue', jobId);
        const status = summary.failed_count ? 'partial_failed' : 'completed';
        if (status === 'completed' && job.kind === 'auto') { await markCaptured(context); await markPublished(context); }
        await store.updateJob(jobId, { status, ...(status === 'completed' ? { last_error: null, next_retry_at: null } : {}) });
        return result('completed', jobId);
      }
      return result('continue', jobId);
    } catch (error) {
      if (error instanceof BusyError || error.status === 409) {
        const current = await store.getJob(jobId);
        return result(['paused', 'cancelled'].includes(current.status) ? current.status : 'busy', jobId);
      }
      if (error.code === 'BROWSER_QUOTA_EXCEEDED') return markQuota(context, error);
      if (error.code === 'BROWSER_BUSY') return markBrowserWait(context, error);
      if (error.code === 'RATE_LIMITED') return markSourceWait(context, error);
      if (AUTH_CODES.has(error.code)) return markAuth(context, error);
      await store.updateJob(jobId, { status: 'failed', last_error: errorText(error) });
      await counters(context);
      throw error;
    }
  };
  try {
    return await withLease(store, token, execute);
  } catch (error) {
    if (error instanceof BusyError) return result('busy', jobId);
    throw error;
  }
}
