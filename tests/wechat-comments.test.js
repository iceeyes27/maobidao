import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommentCollector } from '../src/archive/wechat-comments.js';
import { CollectorError } from '../src/archive/collector-security.js';
import { WECHAT_READER_BIZ } from '../src/archive/wechat-reader.js';

const TIME = Date.parse('2026-10-19T10:00:00Z');
const ARTICLE = { url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(WECHAT_READER_BIZ)}&mid=2247498657&idx=1&sn=5cdfb9d08d7f6844b121f8618cd9dba3`,
  source_key: `wechat:${WECHAT_READER_BIZ}:2247498657:1` };
const CREDENTIAL = { kind: 'wechat-reader', account_biz: WECHAT_READER_BIZ, uin: '12345',
  key: 'synthetic-key', pass_ticket: 'synthetic-ticket', cookie: 'wxtokenkey=synthetic-cookie', expires_at: TIME + 300000 };
const COMMENT_ID = '1234567890';
const reply = (id = 1, patch = {}) => ({ reply_id: id, content: `Reply ${id}`, nick_name: `Reader ${id}`,
  create_time: TIME / 1000 - 100 + id, reply_like_num: 2, ...patch });
const comment = (id = '1', patch = {}) => ({ content_id: id, content: `Comment ${id}`, nick_name: `Reader ${id}`,
  create_time: TIME / 1000 - 200 + Number(id), like_num: 5, is_elected: 1, ...patch });
const page = (rows = [], patch = {}) => ({ base_resp: { ret: 0 }, elected_comment: rows, buffer: '', continue_flag: false, ...patch });
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const hasCode = expected => error => error instanceof CollectorError && error.code === expected;

function fixture(responder = () => json(page())) {
  const calls = [];
  let loads = 0;
  const collector = createCommentCollector({ now: () => TIME, resolveHost: async host => assert.equal(host, 'mp.weixin.qq.com'),
    fetchImpl: async (url, options) => { calls.push({ url: new URL(url), options }); return responder(url, options, calls.length); },
    credentialsLoader: async () => { loads++; return CREDENTIAL; } });
  return { calls, loads: () => loads, run: options => collector.fetchComments({}, ARTICLE, { commentId: COMMENT_ID, ...options }) };
}

test('anonymous public comments require no login, ignore private collections and expose only public text fields', async () => {
  const f = fixture(() => json(page([comment('2', { openid: 'private-user', logo_url: 'https://example.com/avatar',
    ip_wording: { city: 'private' } }), comment('1')], { friend_comment: [comment('8')], my_comment: [comment('9')] })));
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.equal(result.authenticated, false);
  assert.equal(f.loads(), 0);
  assert.equal(result.requests, 1);
  assert.deepEqual(result.comments.map(row => row.id), ['1', '2']);
  assert.deepEqual(Object.keys(result.comments[0]), ['id', 'nickname', 'content', 'created_at', 'like_count', 'replies', 'replies_complete']);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(f.calls[0].url.origin, 'https://mp.weixin.qq.com');
  assert.equal(f.calls[0].url.pathname, '/mp/appmsg_comment');
  assert.equal(f.calls[0].url.searchParams.get('action'), 'getcomment');
  assert.equal(f.calls[0].url.searchParams.get('comment_id'), COMMENT_ID);
  assert.equal(f.calls[0].url.searchParams.get('appmsgid'), '2247498657');
  assert.equal(f.calls[0].url.searchParams.has('uin'), false);
  assert.equal(f.calls[0].options.headers.cookie, undefined);
  assert.equal(f.calls[0].options.redirect, 'manual');
});

test('explicit end marker with an empty elected list proves an empty public comment result', async () => {
  const result = await fixture().run();
  assert.deepEqual(result.comments, []);
  assert.equal(result.complete, true);
  assert.equal(result.next_cursor, undefined);
});

test('authentication is loaded only after anonymous authentication failure and credentials never enter the result', async () => {
  const f = fixture((_url, _options, call) => call === 1 ? json({ base_resp: { ret: 200003, err_msg: 'secret raw user' } }) : json(page([comment()])));
  const result = await f.run();
  assert.equal(f.loads(), 1);
  assert.equal(result.authenticated, true);
  assert.equal(result.requests, 2);
  assert.equal(f.calls[1].url.searchParams.get('uin'), CREDENTIAL.uin);
  assert.equal(f.calls[1].url.searchParams.get('key'), CREDENTIAL.key);
  assert.equal(f.calls[1].url.searchParams.get('pass_ticket'), CREDENTIAL.pass_ticket);
  assert.equal(f.calls[1].options.headers.cookie, CREDENTIAL.cookie);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});

test('invalid or expired reader authorization never substitutes a backend login cookie', async () => {
  for (const credential of [{ ...CREDENTIAL, kind: 'backend' }, { ...CREDENTIAL, expires_at: TIME },
    { ...CREDENTIAL, cookie: 'slave_sid=private' }, { ...CREDENTIAL, account_biz: 'other' }]) {
    const f = fixture(() => json({ base_resp: { ret: 200003 } }));
    await assert.rejects(f.run({ credentials: credential }), hasCode('READER_LOGIN_REQUIRED'));
    assert.equal(f.calls.length, 1);
  }
});

test('a WeChat verification redirect is never followed, including with provided credentials', async () => {
  const f = fixture(() => new Response('', { status: 302, headers: { location: 'https://example.com/?key=secret' } }));
  await assert.rejects(f.run({ credentials: CREDENTIAL }), hasCode('CHALLENGE_REQUIRED'));
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.url.origin === 'https://mp.weixin.qq.com'));
  assert.equal(f.loads(), 0);
});

test('an anonymous verification response may retry the same official endpoint with a valid reader session once', async () => {
  const f = fixture((_url, _options, call) => call === 1
    ? new Response('', { status: 302, headers: { location: '/mp/wappoc_appmsgcaptcha' } }) : json(page([comment()])));
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.equal(result.authenticated, true);
  assert.equal(f.loads(), 1);
  assert.equal(f.calls[1].url.pathname, '/mp/appmsg_comment');
  assert.equal(f.calls[1].url.searchParams.get('key'), CREDENTIAL.key);
});

test('article and comment identity failures occur before sending a request', async () => {
  let requests = 0;
  const collector = createCommentCollector({ fetchImpl: async () => { requests++; return json(page()); } });
  for (const article of [{ ...ARTICLE, source_key: 'wechat:other:1:1' }, { ...ARTICLE, account_biz: 'other' }]) {
    await assert.rejects(collector.fetchComments({}, article, { commentId: COMMENT_ID }), hasCode('ARTICLE_IDENTITY_MISMATCH'));
  }
  await assert.rejects(collector.fetchComments({}, { ...ARTICLE, metadata: { comment_id: '9876' } },
    { commentId: COMMENT_ID }), hasCode('ARTICLE_IDENTITY_MISMATCH'));
  for (const commentId of ['', '0', '123&action=private', '9'.repeat(33), 9007199254740992]) {
    await assert.rejects(collector.fetchComments({}, ARTICLE, { commentId }), hasCode('COMMENT_ID_REQUIRED'));
  }
  await assert.rejects(collector.fetchComments({}, ARTICLE), hasCode('COMMENT_ID_REQUIRED'));
  assert.equal(requests, 0);
});

test('wrong publisher, unsafe URL and response identity mismatch cannot fetch or attach another article comments', async () => {
  const collector = createCommentCollector({ fetchImpl: async () => { throw new Error('not reached'); } });
  for (const url of [ARTICLE.url.replace(encodeURIComponent(WECHAT_READER_BIZ), 'other'), 'https://example.com/s?__biz=other&mid=1']) {
    await assert.rejects(collector.fetchComments({}, { url }, { commentId: COMMENT_ID }), error => error instanceof CollectorError);
  }
  for (const patch of [{ __biz: 'other' }, { comment_id: '99' }, { appmsgid: '99' }, { idx: '2' }]) {
    await assert.rejects(fixture(() => json(page([comment()], patch))).run(), hasCode('ARTICLE_IDENTITY_MISMATCH'));
  }
});

test('public comment pagination preserves stable identities, deduplicates and sorts by original time', async () => {
  const f = fixture((_url, _options, call) => call === 1
    ? json(page([comment('2')], { continue_flag: true, buffer: 'next-page' }))
    : json(page([comment('2'), comment('1')])));
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.deepEqual(result.comments.map(row => row.id), ['1', '2']);
  assert.equal(f.calls[1].url.searchParams.get('buffer'), 'next-page');
  assert.equal(f.calls[1].url.searchParams.get('offset'), '0');
});

test('missing or stalled pagination never claims that all public comments were saved', async () => {
  for (const patch of [{ continue_flag: undefined }, { continue_flag: true }, { continue_flag: true, buffer: '' }]) {
    await assert.rejects(fixture(() => json(page([comment()], patch))).run(), hasCode('SOURCE_FORMAT_CHANGED'));
  }
  const f = fixture((_url, _options, call) => json(page([comment(String(call))], { continue_flag: true, buffer: 'unchanged' })));
  const result = await f.run();
  assert.equal(result.complete, false);
  assert.equal(result.partial_reason, 'SOURCE_FORMAT_CHANGED');
  assert.equal(result.comments.length, 1);
  const mismatched = await fixture(() => json(page([comment('1')], { elected_comment_total_cnt: 2 }))).run();
  assert.equal(mismatched.complete, false);
  assert.equal(mismatched.partial_reason, 'SOURCE_FORMAT_CHANGED');
  assert.equal(mismatched.next_cursor.main_complete, false);
  await assert.rejects(fixture(() => json(page([], { elected_comment_total_cnt: 2 }))).run(), hasCode('SOURCE_FORMAT_CHANGED'));
});

test('five requests per sweep return a scoped continuation that resumes without losing earlier saved comments', async () => {
  const f = fixture((_url, _options, call) => json(page([comment(String(call))], call <= 5 ? { continue_flag: true, buffer: `p${call}` } : {})));
  const first = await f.run();
  assert.equal(first.complete, false);
  assert.equal(first.partial_reason, 'request_limit');
  assert.equal(first.comments.length, 5);
  assert.equal(first.requests, 5);
  assert.equal(first.next_cursor.buffer, 'p5');
  const second = await f.run({ cursor: first.next_cursor });
  assert.equal(second.complete, true);
  assert.deepEqual(second.comments.map(row => row.id), ['6']);
  assert.equal(f.calls[5].url.searchParams.get('buffer'), 'p5');
  await assert.rejects(f.run({ cursor: { ...first.next_cursor, comment_id: 'other' } }), hasCode('INVALID_COMMENT_CURSOR'));
  await assert.rejects(f.run({ cursor: { ...first.next_cursor, source_key: 'other' } }), hasCode('INVALID_COMMENT_CURSOR'));
});

test('reader-visible inline replies and their further public pages are merged and ordered', async () => {
  const f = fixture((_url, _options, call) => call === 1
    ? json(page([comment('1', { reply_new: { reply_total_cnt: 3, max_reply_id: 2, reply_list: [reply(2)] } })]))
    : json({ base_resp: { ret: 0 }, reply_list: { max_reply_id: 0, reply_list: [reply(2), reply(1), reply(3)] } }));
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.deepEqual(result.comments[0].replies.map(row => row.id), ['1', '2', '3']);
  assert.equal(result.comments[0].replies_complete, true);
  assert.deepEqual(result.replies.map(row => `${row.comment_id}:${row.id}`), ['1:1', '1:3']);
  assert.equal(f.calls[1].url.searchParams.get('action'), 'getcommentreply');
  assert.equal(f.calls[1].url.searchParams.get('content_id'), '1');
  assert.equal(f.calls[1].url.searchParams.get('max_reply_id'), '2');
});

test('deleted replies are excluded from the public saved content', async () => {
  const f = fixture(() => json(page([comment('1', { reply_new: { reply_total_cnt: 1, max_reply_id: 1,
    reply_list: [reply(1), reply(2, { is_deleted: 1 }), reply(3, { reply_del_flag: 1 })] } })])));
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.deepEqual(result.comments[0].replies.map(row => row.id), ['1']);
});

test('explicitly unelected replies are excluded even when a reader session returns them', async () => {
  const f = fixture(() => json(page([comment('1', { reply_new: { reply_total_cnt: 1, max_reply_id: 1,
    reply_list: [reply(1, { reply_is_elected: 1 }), reply(2, { reply_is_elected: 0 }), reply(3, { reply_is_elected: false })] } })])));
  const result = await f.run();
  assert.equal(result.complete, true);
  assert.deepEqual(result.comments[0].replies.map(row => row.id), ['1']);
});

test('null or explicitly zero-count reply blocks represent no replies without requesting another endpoint', async () => {
  for (const reply_new of [null, { reply_total_cnt: 0 }]) {
    const f = fixture(() => json(page([comment('1', { reply_new })])));
    const result = await f.run();
    assert.equal(result.complete, true);
    assert.deepEqual(result.comments[0].replies, []);
    assert.equal(f.calls.length, 1);
  }
});

test('reply pagination preserves partial results when later authentication, throttling or malformed data interrupts it', async () => {
  for (const failure of [{ base_resp: { ret: 200013 } }, { base_resp: { ret: 200003 } }, { base_resp: { ret: 0 }, reply_list: {} }]) {
    const f = fixture((_url, _options, call) => call === 1 ? json(page([comment('1', { reply_new:
      { reply_total_cnt: 2, max_reply_id: 1, reply_list: [reply()] } })])) : json(failure));
    const result = await f.run();
    assert.equal(result.complete, false);
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].replies_complete, false);
    assert.ok(['RATE_LIMITED', 'READER_LOGIN_REQUIRED', 'SOURCE_FORMAT_CHANGED'].includes(result.partial_reason));
    assert.equal(result.next_cursor.pending_replies[0].content_id, '1');
  }
});

test('reply limit is explicit and never fabricates a full archive', async () => {
  const cursor = { source_key: ARTICLE.source_key, comment_id: COMMENT_ID, buffer: '', offset: 1,
    main_complete: true, seen_comments: ['1'], reply_count: 1000,
    pending_replies: [{ content_id: '1', total: 1001, max_reply_id: '1', seen_ids: ['1'] }] };
  const f = fixture();
  const result = await f.run({ cursor });
  assert.equal(result.complete, false);
  assert.equal(result.partial_reason, 'reply_limit');
  assert.equal(result.next_cursor, null);
  assert.equal(f.calls.length, 0);
});

test('a malformed later row keeps a resumable cursor for only fully validated comments', async () => {
  let recovered = false;
  const f = fixture(() => json(page([comment('1'), comment('2', recovered ? {} : { reply_new: { reply_total_cnt: 2 } })])));
  const first = await f.run();
  assert.equal(first.complete, false);
  assert.deepEqual(first.comments.map(row => row.id), ['1']);
  assert.deepEqual(first.next_cursor.seen_comments, ['1']);
  assert.deepEqual(first.next_cursor.pending_replies, []);
  recovered = true;
  const second = await f.run({ cursor: first.next_cursor });
  assert.equal(second.complete, true);
  assert.deepEqual(second.comments.map(row => row.id), ['2']);
});

test('reply work resumes on a subsequent sweep without repeating finished top-level pages', async () => {
  const f = fixture((_url, _options, call) => call === 1
    ? json(page(Array.from({ length: 5 }, (_, index) => comment(String(index + 1), { reply_new:
      { reply_total_cnt: 2, max_reply_id: 1, reply_list: [reply(1)] } }))))
    : json({ base_resp: { ret: 0 }, reply_list: { max_reply_id: 0, reply_list: [reply(2)] } }));
  const first = await f.run();
  assert.equal(first.complete, false);
  assert.equal(first.requests, 5);
  assert.equal(first.next_cursor.pending_replies.length, 1);
  const second = await f.run({ cursor: first.next_cursor });
  assert.equal(second.complete, true);
  assert.equal(second.comments.length, 0);
  assert.equal(second.replies[0].comment_id, '5');
  assert.equal(f.calls[5].url.searchParams.get('action'), 'getcommentreply');
});

test('unexpected cursor fields are not returned and invalid cursor structures are rejected', async () => {
  const base = { source_key: ARTICLE.source_key, comment_id: COMMENT_ID, buffer: '', offset: 0,
    main_complete: false, seen_comments: [], reply_count: 0, pending_replies: [] };
  const f = fixture((_url, _options, call) => json(page([comment(String(call))], { continue_flag: true, buffer: `p${call}` })));
  const result = await f.run({ cursor: { ...base, secret: 'hidden' } });
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  for (const patch of [{ seen_comments: ['1', '1'] }, { seen_comments: [1] }, { buffer: 'x\nsecret' }, { reply_count: 1001 },
    { pending_replies: [{ content_id: '2', max_reply_id: '1', seen_ids: [], total: 1 }] }]) {
    await assert.rejects(f.run({ cursor: { ...base, ...patch } }), error => error instanceof CollectorError);
  }
});

test('bad content, identifiers, counts and publication times are not accepted as public comments', async () => {
  for (const patch of [{ content_id: 'x' }, { content_id: 9007199254740992 }, { content: 'x'.repeat(20_001) },
    { content: 'x\u0000' }, { nick_name: 'x'.repeat(257) }, { create_time: 0 }, { create_time: TIME / 1000 + 301 },
    { like_num: -1 }, { reply_new: { reply_total_cnt: 0, max_reply_id: 0, reply_list: [reply()] } }]) {
    await assert.rejects(fixture(() => json(page([comment('1', patch)]))).run(), hasCode('SOURCE_FORMAT_CHANGED'));
  }
});

test('transport errors, oversized responses and malformed JSON reveal neither URLs nor credentials nor upstream nicknames', async () => {
  const failures = [() => { throw new Error('https://mp.weixin.qq.com/?key=SECRET&uin=234 nickname=PERSON'); },
    () => { throw new CollectorError('UPSTREAM_ERROR', 'https://secret.invalid key=SECRET nickname=PERSON', true); },
    () => json({ base_resp: { ret: 40001, err_msg: 'https://secret.invalid key=SECRET nickname=PERSON' } }),
    () => new Response('{bad JSON SECRET PERSON'),
    () => new Response('x', { headers: { 'content-length': String(3 * 1024 * 1024) } })];
  for (const failure of failures) {
    await assert.rejects(fixture(failure).run(), error => {
      assert.ok(error instanceof CollectorError);
      assert.doesNotMatch(String(error.stack), /SECRET|PERSON|https:\/\//);
      return true;
    });
  }
});

test('rate, challenge, unauthenticated, busy and unknown responses have distinct safe outcomes', async () => {
  for (const [response, code] of [[{ base_resp: { ret: 200013 } }, 'RATE_LIMITED'], [{ base_resp: { ret: -1 } }, 'UPSTREAM_ERROR'],
    [{ base_resp: { ret: 200008 } }, 'CHALLENGE_REQUIRED'], [{ base_resp: { ret: 40001 } }, 'COMMENTS_UNAVAILABLE'],
    [{ base_resp: { ret: '0' } }, 'SOURCE_FORMAT_CHANGED'], [{ elected_comment: [] }, 'SOURCE_FORMAT_CHANGED']]) {
    await assert.rejects(fixture(() => json(response)).run(), hasCode(code));
  }
  await assert.rejects(fixture(() => new Response('<html>当前环境异常，请完成安全验证</html>')).run(), hasCode('CHALLENGE_REQUIRED'));
});

test('known reader authentication errors and message-only auth failures may use reader authorization', async () => {
  for (const base_resp of [{ ret: -6 }, { ret: -1, err_msg: 'no session' }, { ret: 40001, err_msg: 'invalid key' }]) {
    const f = fixture((_url, _options, call) => call === 1 ? json({ base_resp }) : json(page()));
    const result = await f.run();
    assert.equal(result.complete, true);
    assert.equal(result.authenticated, true);
    assert.equal(f.loads(), 1);
  }
  for (const [err_msg, code] of [['freq control', 'RATE_LIMITED'], ['captcha required', 'CHALLENGE_REQUIRED']]) {
    const f = fixture(() => json({ base_resp: { ret: -1, err_msg } }));
    await assert.rejects(f.run(), hasCode(code));
    assert.equal(f.loads(), code === 'CHALLENGE_REQUIRED' ? 1 : 0);
  }
});
