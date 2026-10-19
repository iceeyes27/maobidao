import { ArchiveStore } from './store.js';
import { createWechatReader, validateReaderArticleUrl, WECHAT_READER_BIZ } from './wechat-reader.js';
import { createCommentCollector } from './wechat-comments.js';
import { loadReaderSession, readerSessionStatus } from './reader-session.js';

const PROBE_KEY = 'private/wechat-reader/probe.json';
const encoder = new TextEncoder();
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const CODES = new Set(['READER_LOGIN_REQUIRED', 'READER_SESSION_EXPIRED', 'READER_SESSION_INVALID',
  'CHALLENGE_REQUIRED', 'RATE_LIMITED', 'ARTICLE_REMOVED', 'ARTICLE_INVALID', 'READER_RESPONSE_INVALID',
  'READER_SOURCE_MISMATCH', 'COMMENTS_UNAVAILABLE', 'SOURCE_FORMAT_CHANGED', 'RESOURCE_TOO_LARGE']);

function problem(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function failed(error) { return { state: 'blocked', code: CODES.has(error?.code) ? error.code : 'UPSTREAM_ERROR' }; }
async function putJson(env, key, value, etag) {
  return env.ARCHIVE_BUCKET.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl: 'private, no-store' },
    ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
  });
}
async function decodeJsonObject(object, maxBytes = 64 * 1024) {
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > maxBytes) throw problem('READER_RESPONSE_INVALID', '阅读验证记录无效');
  const text = await object.text();
  if (encoder.encode(text).byteLength > maxBytes) throw problem('READER_RESPONSE_INVALID', '阅读验证记录超过允许大小');
  return JSON.parse(text);
}
async function readJson(env, key, maxBytes = 64 * 1024) {
  const object = await env.ARCHIVE_BUCKET.get(key);
  return object ? decodeJsonObject(object, maxBytes) : null;
}
async function finishQueuedBusyProbe(env, probeId) {
  const object = await env.ARCHIVE_BUCKET.get(PROBE_KEY);
  if (!object) return;
  const current = await decodeJsonObject(object);
  if (current?.probe_id !== probeId || current.state !== 'queued' || typeof object.etag !== 'string' || !object.etag) return;
  const blocked = { state: 'blocked', code: 'BUSY' };
  // A running or newer probe may have replaced this queued snapshot during the
  // read. R2's conditional write leaves that newer record untouched.
  await putJson(env, PROBE_KEY, { probe_id: probeId, state: 'busy', started_at: current.started_at,
    checked_at: Date.now(), session_revision: current.session_revision ?? null,
    discovery: blocked, article: blocked, comments: blocked }, object.etag);
}
async function optionalCredentials(env) {
  try { return await loadReaderSession(env); }
  catch (error) {
    if (['READER_LOGIN_REQUIRED', 'READER_SESSION_EXPIRED'].includes(error.code)) return null;
    throw error;
  }
}

export async function readingStatus(env) {
  if (!env.ARCHIVE_BUCKET?.get) return { session: { configured: false }, probe: null };
  let session;
  try { session = await readerSessionStatus(env); }
  catch (error) { session = { configured: false, code: failed(error).code }; }
  let probe = null;
  try { probe = await readJson(env, PROBE_KEY); } catch { /* Keep the admin page available on a corrupt diagnostic. */ }
  if (probe && probe.session_revision !== (session.revision || null)) {
    probe = { probe_id: probe.probe_id, state: 'session_changed', checked_at: probe.checked_at || null };
  }
  // Only these explicit fields cross the admin boundary; no raw responses or input URLs.
  return { session, probe: probe ? { probe_id: probe.probe_id, state: probe.state, checked_at: probe.checked_at || null,
    discovery: probe.discovery, article: probe.article, comments: probe.comments } : null };
}

async function probeArticleUrl(env, input) {
  if (input != null && input !== '') return validateReaderArticleUrl(input).url;
  const store = new ArchiveStore(env.ARCHIVE_DB);
  const latest = await store.first(`SELECT url FROM archive_articles WHERE status='published' AND source_key LIKE ?
    ORDER BY first_published_at DESC,id DESC LIMIT 1`, [`wechat:${WECHAT_READER_BIZ}:%`]);
  if (!latest) throw problem('READER_SOURCE_MISMATCH', '请填写猫笔刀文章的原文链接', 400);
  return validateReaderArticleUrl(latest.url).url;
}

/** Queue diagnostics with public identity only. Reading credentials never enter Workflow parameters. */
export async function requestReadingProbe(env, input) {
  const url = await probeArticleUrl(env, input);
  const store = new ArchiveStore(env.ARCHIVE_DB);
  const lease = await store.acquireLease('reader-probe-request', crypto.randomUUID(), 30000);
  if (!lease) throw problem('BUSY', '阅读验证正在准备，请稍后查看');
  try {
    const current = await readJson(env, PROBE_KEY);
    if (current && ['queued', 'running'].includes(current.state) && current.started_at > Date.now() - 300000) {
      throw problem('BUSY', '阅读验证正在进行，请等待当前结果');
    }
    const probeId = crypto.randomUUID();
    const session = await readerSessionStatus(env);
    await putJson(env, PROBE_KEY, { probe_id: probeId, state: 'queued', started_at: Date.now(), session_revision: session.revision });
    const id = `reader-probe-${probeId}`;
    try { await env.ARCHIVE_WORKFLOW.create({ id, params: { action: 'probe-reader', probe_id: probeId, url } }); }
    catch (error) {
      try { await (await env.ARCHIVE_WORKFLOW.get(id)).status(); }
      catch {
        await putJson(env, PROBE_KEY, { probe_id: probeId, state: 'failed', checked_at: Date.now(), session_revision: session.revision });
        throw problem('UPSTREAM_ERROR', '阅读验证暂时无法启动，请稍后重试', 503);
      }
    }
    return { probe_id: probeId, status: 'queued' };
  } finally { await store.releaseLease(lease); }
}

async function savePublicComments(env, identity, collected) {
  const store = new ArchiveStore(env.ARCHIVE_DB);
  const article = await store.getArticleByKey(identity.source_key);
  if (!article || article.status !== 'published') return null;
  const key = `private/wechat-reader/comments/${article.id}.json`;
  const previous = await readJson(env, key, 2 * 1024 * 1024);
  const comments = new Map((previous?.comments || []).map(comment => [comment.id, comment]));
  for (const comment of collected.comments) {
    const older = comments.get(comment.id);
    comments.set(comment.id, { ...comment, replies: [...new Map([...(older?.replies || []), ...comment.replies].map(reply => [reply.id, reply])).values()] });
  }
  for (const reply of collected.replies || []) {
    const comment = comments.get(reply.comment_id);
    if (comment) {
      const { comment_id, ...publicReply } = reply;
      comment.replies = [...new Map([...comment.replies, publicReply].map(item => [item.id, item])).values()];
    }
  }
  for (const comment of comments.values()) {
    comment.replies.sort((first, second) => first.created_at - second.created_at || first.id.localeCompare(second.id));
    if (collected.complete || collected.next_cursor) {
      comment.replies_complete = !(collected.next_cursor?.pending_replies || []).some(pending => pending.content_id === comment.id);
    }
  }
  const saved = { article_id: article.id, source_key: identity.source_key, complete: collected.complete,
    checked_at: collected.fetched_at, comments: [...comments.values()], next_cursor: collected.next_cursor || null };
  if (encoder.encode(JSON.stringify(saved)).byteLength > 2 * 1024 * 1024) throw problem('RESOURCE_TOO_LARGE', '公开留言保存结果超过允许大小');
  await putJson(env, key, saved);
  return { count: saved.comments.length, reply_count: saved.comments.reduce((sum, comment) => sum + comment.replies.length, 0) };
}

/** The executor returns metrics only; even authenticated requests keep the normal archive untouched. */
export async function runReadingProbe(env, { url: input, probe_id: probeId = crypto.randomUUID() } = {}, {
  reader = createWechatReader({ credentialsLoader: optionalCredentials }),
  comments = createCommentCollector({ credentialsLoader: optionalCredentials }),
  store = new ArchiveStore(env.ARCHIVE_DB),
} = {}) {
  if (!UUID.test(probeId)) throw problem('INVALID_REQUEST', '阅读验证标识无效', 400);
  const url = await probeArticleUrl(env, input);
  const lease = await store.acquireLease('wechat-reader', probeId, 240000);
  if (!lease) {
    await finishQueuedBusyProbe(env, probeId);
    return { state: 'busy', probe_id: probeId };
  }
  try {
    const session = await readerSessionStatus(env);
    const report = { probe_id: probeId, state: 'running', started_at: Date.now(), session_revision: session.revision,
      discovery: { state: 'pending' }, article: { state: 'pending' }, comments: { state: 'pending' } };
    await putJson(env, PROBE_KEY, report);
    let page;
    try {
      page = await reader.probeSource(env, { cursor: 0, count: 5 });
      report.discovery = { state: page.articles.length ? 'available' : 'empty', article_count: page.articles.length,
        time_trusted_count: page.articles.filter(article => article.time_trusted).length };
    } catch (error) { report.discovery = failed(error); }
    let article;
    try {
      article = await reader.probeArticle(env, url);
      report.article = { state: 'available', body_readable: true, comment_id_present: Boolean(article.comment_id),
        image_count: article.image_count, text_length: article.text_length };
    } catch (error) { report.article = failed(error); }
    if (!article?.comment_id) report.comments = { state: 'blocked', code: article ? 'COMMENT_ID_REQUIRED' : 'ARTICLE_VERIFICATION_REQUIRED' };
    else {
      try {
        const identity = article.article_identity;
        const known = await store.getArticleByKey(identity.source_key);
        const previous = known ? await readJson(env, `private/wechat-reader/comments/${known.id}.json`, 2 * 1024 * 1024) : null;
        const collected = await comments.fetchComments(env, { url: identity.url, source_key: identity.source_key },
          { commentId: article.comment_id, ...(previous?.next_cursor ? { cursor: previous.next_cursor } : {}) });
        const totals = await savePublicComments(env, identity, collected);
        report.comments = { state: collected.complete ? 'available' : 'partial',
          ...(totals || { count: collected.comments.length, reply_count: collected.comments.reduce((sum, comment) => sum + comment.replies.length, 0) }),
          complete: collected.complete };
      } catch (error) { report.comments = failed(error); }
    }
    const after = await readerSessionStatus(env);
    report.checked_at = Date.now();
    report.state = after.revision !== session.revision ? 'session_changed'
      : report.discovery.state === 'available' && report.article.state === 'available' ? 'verified' : 'attention';
    await putJson(env, PROBE_KEY, report);
    return { ...report, session_revision: undefined };
  } finally { await store.releaseLease(lease); }
}

export async function publicArticleComments(env, articleId) {
  if (!/^[a-f\d]{32}$/.test(articleId)) return null;
  const article = await new ArchiveStore(env.ARCHIVE_DB).getArticle(articleId);
  if (!article || article.status !== 'published') return null;
  const saved = await readJson(env, `private/wechat-reader/comments/${article.id}.json`, 2 * 1024 * 1024);
  return saved ? { comments: saved.comments, complete: saved.complete, checked_at: saved.checked_at } : null;
}
