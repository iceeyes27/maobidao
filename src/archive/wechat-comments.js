import { CollectorError } from './collector-security.js';
import { normalizeReaderCredentials, readerFetch, validateReaderArticleUrl } from './wechat-reader.js';

const ENDPOINT = 'https://mp.weixin.qq.com/mp/appmsg_comment';
const PAGE_SIZE = 100;
const REQUEST_LIMIT = 5;
const COMMENT_LIMIT = 1000;
const REPLY_LIMIT = 1000;
const BODY_LIMIT = 2 * 1024 * 1024;
const fail = (code, message, retryable = false) => { throw new CollectorError(code, message, retryable); };
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
const SAFE_ERRORS = Object.freeze({
  READER_LOGIN_REQUIRED: '公开留言需要有效的微信阅读会话',
  CHALLENGE_REQUIRED: '微信要求阅读安全验证', RATE_LIMITED: '微信暂时限制公开留言访问频率',
  SOURCE_FORMAT_CHANGED: '公开留言响应格式已变化', ARTICLE_IDENTITY_MISMATCH: '公开留言响应的文章标识不一致',
  COMMENTS_UNAVAILABLE: '微信暂未提供这篇文章的公开留言', RESOURCE_TOO_LARGE: '公开留言响应超过允许大小',
  UNSAFE_URL: '公开留言请求目标无效', INVALID_READER_CREDENTIALS: '微信阅读会话格式无效',
});
function safeError(error) {
  const code = Object.hasOwn(SAFE_ERRORS, error?.code) ? error.code : 'UPSTREAM_ERROR';
  return new CollectorError(code, SAFE_ERRORS[code] || '公开留言请求暂时失败', error?.retryable === true);
}

function id(value, { zero = false } = {}) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
  if (!['string', 'number'].includes(typeof value)) return null;
  const text = String(value);
  return /^\d{1,32}$/.test(text) && (zero || !/^0+$/.test(text)) ? text : null;
}

function count(value, maximum = 1_000_000_000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function text(value, maximum, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    fail('SOURCE_FORMAT_CHANGED', '公开留言内容格式已变化');
  }
  return value.replace(/\r\n?/g, '\n');
}

function timestamp(value, now) {
  if (!Number.isInteger(value) || value < 946684800 || value * 1000 > now + 300_000) {
    fail('SOURCE_FORMAT_CHANGED', '公开留言时间格式已变化');
  }
  return value * 1000;
}

function normalizeEntry(row, now, reply = false) {
  if (!plainObject(row)) fail('SOURCE_FORMAT_CHANGED', '公开留言格式已变化');
  const identity = id(reply ? row.reply_id : row.content_id);
  const likes = count(reply ? row.reply_like_num ?? 0 : row.like_num ?? 0);
  if (!identity || likes === null) fail('SOURCE_FORMAT_CHANGED', '公开留言标识格式已变化');
  return {
    id: identity, nickname: text(row.nick_name, 256, true), content: text(row.content, 20_000),
    created_at: timestamp(row.create_time, now), like_count: likes,
  };
}

function normalizeReplies(rows, now) {
  if (!Array.isArray(rows) || rows.length > REPLY_LIMIT) fail('SOURCE_FORMAT_CHANGED', '公开回复列表格式已变化');
  const seen = new Set();
  return rows.filter(row => {
    if (row?.reply_is_elected !== undefined && bool(row.reply_is_elected) === null) fail('SOURCE_FORMAT_CHANGED', '公开回复可见性格式已变化');
    return !row?.is_deleted && !row?.reply_del_flag && row?.reply_is_elected !== 0 && row?.reply_is_elected !== false;
  }).map(row => normalizeEntry(row, now, true))
    .filter(row => !seen.has(row.id) && seen.add(row.id));
}

function bool(value) { return value === true || value === 1 ? true : value === false || value === 0 ? false : null; }
function buffer(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('SOURCE_FORMAT_CHANGED', '公开留言分页格式已变化');
  }
  return value;
}
function sorted(rows) { return rows.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)); }

function responseBody(resource) {
  let body;
  const value = new TextDecoder().decode(resource.bytes);
  try { body = JSON.parse(value); }
  catch {
    if (/当前环境异常|安全验证|验证码|captcha|wappoc_appmsgcaptcha/i.test(value)) {
      fail('CHALLENGE_REQUIRED', '微信要求阅读安全验证');
    }
    fail('SOURCE_FORMAT_CHANGED', '微信未返回可识别的公开留言数据');
  }
  if (!plainObject(body) || !plainObject(body.base_resp) || !Number.isInteger(body.base_resp.ret)) {
    fail('SOURCE_FORMAT_CHANGED', '公开留言响应格式已变化');
  }
  const ret = body.base_resp.ret;
  const message = String(body.base_resp.err_msg || body.errmsg || body.err_msg || '').slice(0, 1000);
  if ([200013, 45009].includes(ret) || /访问过于频繁|操作过于频繁|freq(?:uency)?\s*(?:limit|control)|too\s+(?:many|frequent)/i.test(message)) {
    fail('RATE_LIMITED', '微信暂时限制公开留言访问频率', true);
  }
  if ([200008, 200014].includes(ret) || /当前环境异常|安全验证|验证码|captcha|verify\s*(?:you|code)/i.test(message)) {
    fail('CHALLENGE_REQUIRED', '微信要求阅读安全验证');
  }
  if ([200003, 200004, 200005, -3, -6].includes(ret) || /请(?:先|重新)?登录|登录(?:已)?(?:失效|过期)|not\s*login|no\s*session|invalid\s*(?:session|key)|session\s*expired/i.test(message)) {
    fail('READER_LOGIN_REQUIRED', '公开留言需要有效的微信阅读会话');
  }
  if (ret === -1) fail('UPSTREAM_ERROR', '微信公开留言服务暂时繁忙', true);
  if (ret !== 0) fail('COMMENTS_UNAVAILABLE', '微信暂未提供这篇文章的公开留言');
  return body;
}

function initialCursor(value, identity, commentId) {
  if (value == null) return { source_key: identity.source_key, comment_id: commentId,
    buffer: '', offset: 0, main_complete: false, seen_comments: [], reply_count: 0, pending_replies: [] };
  if (!plainObject(value) || value.source_key !== identity.source_key || value.comment_id !== commentId
      || typeof value.main_complete !== 'boolean' || count(value.offset, 1_000_000) === null
      || count(value.reply_count, REPLY_LIMIT) === null || !Array.isArray(value.seen_comments)
      || value.seen_comments.length > COMMENT_LIMIT || value.seen_comments.some(item => typeof item !== 'string' || !id(item))
      || new Set(value.seen_comments).size !== value.seen_comments.length || !Array.isArray(value.pending_replies)
      || value.pending_replies.length > COMMENT_LIMIT) fail('INVALID_COMMENT_CURSOR', '公开留言进度无效');
  buffer(value.buffer);
  const cursor = { source_key: identity.source_key, comment_id: commentId, buffer: value.buffer,
    offset: value.offset, main_complete: value.main_complete, seen_comments: [...value.seen_comments],
    reply_count: value.reply_count, pending_replies: structuredClone(value.pending_replies) };
  const seenParents = new Set();
  let replyIds = 0;
  for (const item of cursor.pending_replies) {
    if (!plainObject(item) || typeof item.content_id !== 'string' || typeof item.max_reply_id !== 'string'
        || !id(item.content_id) || !id(item.max_reply_id, { zero: true })
        || count(item.total, 1_000_000) === null || !Array.isArray(item.seen_ids)
        || item.seen_ids.length > REPLY_LIMIT || item.seen_ids.some(entry => typeof entry !== 'string' || !id(entry))
        || new Set(item.seen_ids).size !== item.seen_ids.length || seenParents.has(item.content_id)
        || !cursor.seen_comments.includes(item.content_id)) fail('INVALID_COMMENT_CURSOR', '公开回复进度无效');
    seenParents.add(item.content_id);
    replyIds += item.seen_ids.length;
    if (replyIds > cursor.reply_count) fail('INVALID_COMMENT_CURSOR', '公开回复进度无效');
  }
  cursor.pending_replies = cursor.pending_replies.map(item => ({ content_id: item.content_id,
    max_reply_id: item.max_reply_id, total: item.total, seen_ids: [...item.seen_ids] }));
  return cursor;
}

/** Reads only elected public comments and their reader-visible replies. Never calls an author/admin endpoint. */
export function createCommentCollector({ fetchImpl = fetch, resolveHost, credentialsLoader, now = Date.now } = {}) {
  async function fetchComments(env, article, options = {}) {
    const identity = validateReaderArticleUrl(article?.original_url || article?.url);
    if (article.source_key && article.source_key !== identity.source_key) fail('ARTICLE_IDENTITY_MISMATCH', '文章标识与公开留言目标不一致');
    if (article.account_biz && article.account_biz !== identity.account_biz) fail('ARTICLE_IDENTITY_MISMATCH', '文章公众号与公开留言目标不一致');
    const commentId = id(options.commentId ?? article.metadata?.comment_id ?? article.comment_id);
    if (!commentId) fail('COMMENT_ID_REQUIRED', '需要先从原文确认公开留言标识');
    for (const known of [article.metadata?.comment_id, article.comment_id]) {
      if (known !== undefined && known !== null && id(known) !== commentId) {
        fail('ARTICLE_IDENTITY_MISMATCH', '公开留言标识与原文记录不一致');
      }
    }
    const cursor = initialCursor(options.cursor, identity, commentId);
    const comments = [];
    const replies = [];
    let authenticated = false;
    let credentials = null;
    let credentialTried = false;
    let requests = 0;
    let partialReason = null;

    async function request(action, params) {
      const target = new URL(ENDPOINT);
      target.search = new URLSearchParams({ action, scene: '0', appmsgid: identity.mid, idx: identity.idx,
        __biz: identity.account_biz, comment_id: commentId, limit: String(PAGE_SIZE), f: 'json',
        comment_scene: '0', x5: '0', ...params }).toString();
      async function send() {
        requests++;
        const resource = await readerFetch(target.href, { fetchImpl, resolveHost, maxBytes: BODY_LIMIT,
          accept: 'application/json,text/plain', credentials, now: now() });
        const body = responseBody(resource);
        // Some versions echo scope fields. An echo must never contradict the request.
        for (const [name, expected] of [['__biz', identity.account_biz], ['comment_id', commentId], ['appmsgid', identity.mid], ['idx', identity.idx]]) {
          if (body[name] !== undefined && String(body[name]) !== String(expected)) fail('ARTICLE_IDENTITY_MISMATCH', '公开留言响应的文章标识不一致');
        }
        return body;
      }
      try { return await send(); }
      catch (error) {
        if (!['READER_LOGIN_REQUIRED', 'CHALLENGE_REQUIRED'].includes(error?.code)
            || credentials || credentialTried || requests >= REQUEST_LIMIT) throw error;
        credentialTried = true;
        const supplied = options.credentials ?? (credentialsLoader ? await credentialsLoader(env, identity) : null);
        credentials = normalizeReaderCredentials(supplied, { now: now() });
        if (!credentials) throw error;
        const body = await send();
        authenticated = true;
        return body;
      }
    }

    try {
      while (!cursor.main_complete && requests < REQUEST_LIMIT) {
        if (cursor.seen_comments.length >= COMMENT_LIMIT) { partialReason = 'comment_limit'; break; }
        const body = await request('getcomment', { buffer: cursor.buffer, offset: '0' });
        if (!Array.isArray(body.elected_comment) || body.elected_comment.length > PAGE_SIZE) {
          fail('SOURCE_FORMAT_CHANGED', '微信未返回公开精选留言列表');
        }
        const more = bool(body.continue_flag);
        if (more === null) fail('SOURCE_FORMAT_CHANGED', '公开留言缺少分页结束标记');
        const declaredTotal = body.elected_comment_total_cnt;
        if (declaredTotal !== undefined && count(declaredTotal, 1_000_000) === null) {
          fail('SOURCE_FORMAT_CHANGED', '公开留言数量格式已变化');
        }
        const next = buffer(body.buffer ?? '');
        if (more && (!next || next === cursor.buffer || body.elected_comment.length === 0)) {
          fail('SOURCE_FORMAT_CHANGED', '公开留言分页未取得进展');
        }
        const seen = new Set(cursor.seen_comments);
        for (const raw of body.elected_comment) {
          // Account/private/friend/my_comment collections are deliberately ignored.
          if (raw?.is_elected !== undefined && bool(raw.is_elected) === null) fail('SOURCE_FORMAT_CHANGED', '公开留言可见性格式已变化');
          if (raw?.is_elected === 0 || raw?.is_elected === false) continue;
          const entry = normalizeEntry(raw, now());
          if (seen.has(entry.id)) continue;
          if (seen.size >= COMMENT_LIMIT) { partialReason = 'comment_limit'; break; }
          entry.replies = [];
          entry.replies_complete = true;
          let pendingReply = null;
          if (raw.reply_new != null) {
            const reply = raw.reply_new;
            if (!plainObject(reply) || count(reply.reply_total_cnt, 1_000_000) === null) fail('SOURCE_FORMAT_CHANGED', '公开回复数量格式已变化');
            const all = normalizeReplies(reply.reply_list ?? (reply.reply_total_cnt === 0 ? [] : undefined), now());
            entry.replies = all.slice(0, Math.max(0, REPLY_LIMIT - cursor.reply_count));
            if (reply.reply_total_cnt < all.length) fail('SOURCE_FORMAT_CHANGED', '公开回复数量与列表不一致');
            entry.replies_complete = entry.replies.length === reply.reply_total_cnt;
            if (!entry.replies_complete) {
              const max = id(reply.max_reply_id, { zero: true });
              if (!max) fail('SOURCE_FORMAT_CHANGED', '公开回复缺少分页标识');
              pendingReply = { content_id: entry.id, total: reply.reply_total_cnt,
                max_reply_id: max, seen_ids: entry.replies.map(row => row.id) };
            }
          }
          sorted(entry.replies);
          seen.add(entry.id);
          // Commit one completely validated comment at a time. If a later row
          // fails, the continuation can retry this page without dropping saved rows.
          cursor.seen_comments = [...seen];
          cursor.reply_count += entry.replies.length;
          if (pendingReply) cursor.pending_replies.push(pendingReply);
          comments.push(entry);
        }
        cursor.seen_comments = [...seen];
        cursor.offset += body.elected_comment.length;
        cursor.buffer = next;
        cursor.main_complete = !more && !partialReason;
        if (cursor.main_complete && declaredTotal !== undefined && declaredTotal > seen.size) {
          cursor.main_complete = false;
          fail('SOURCE_FORMAT_CHANGED', '公开留言数量与分页结束标记不一致');
        }
      }
      while (cursor.pending_replies.length && requests < REQUEST_LIMIT && !partialReason) {
        if (cursor.reply_count >= REPLY_LIMIT) { partialReason = 'reply_limit'; break; }
        const pending = cursor.pending_replies[0];
        const body = await request('getcommentreply', { content_id: pending.content_id, max_reply_id: pending.max_reply_id });
        const group = body.reply_list;
        if (!plainObject(group)) fail('SOURCE_FORMAT_CHANGED', '微信未返回公开回复列表');
        const entries = normalizeReplies(group.reply_list, now());
        const seen = new Set(pending.seen_ids);
        const additions = entries.filter(row => !seen.has(row.id));
        const remaining = REPLY_LIMIT - cursor.reply_count;
        for (const entry of additions.slice(0, remaining)) { seen.add(entry.id); replies.push({ comment_id: pending.content_id, ...entry }); }
        cursor.reply_count += Math.min(additions.length, remaining);
        pending.seen_ids = [...seen];
        if (seen.size >= pending.total) { cursor.pending_replies.shift(); continue; }
        const next = id(group.max_reply_id, { zero: true });
        if (!next || next === pending.max_reply_id || additions.length === 0) {
          fail('SOURCE_FORMAT_CHANGED', '公开回复分页未取得进展');
        }
        pending.max_reply_id = next;
      }
    } catch (error) {
      const safe = safeError(error);
      if (!comments.length && !replies.length) throw safe;
      partialReason = safe.code;
    }
    const complete = cursor.main_complete && cursor.pending_replies.length === 0 && !partialReason;
    if (!complete && !partialReason) partialReason = 'request_limit';
    for (const entry of comments) {
      entry.replies.push(...replies.filter(reply => reply.comment_id === entry.id).map(({ comment_id, ...reply }) => reply));
      sorted(entry.replies);
      entry.replies_complete = !cursor.pending_replies.some(pending => pending.content_id === entry.id);
    }
    return { source_key: identity.source_key, comment_id: commentId, comments: sorted(comments), replies: sorted(replies),
      complete, fetched_at: now(), authenticated, requests,
      ...(complete ? {} : { partial_reason: partialReason, next_cursor: ['comment_limit', 'reply_limit'].includes(partialReason) ? null : cursor }) };
  }
  return { fetchComments };
}
