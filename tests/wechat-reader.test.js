import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectorError } from '../src/archive/collector-security.js';
import { createWechatReader, normalizeReaderCredentials, parseReaderArticle, parseReaderList, readerFetch,
  validateReaderArticleUrl, WECHAT_READER_BIZ } from '../src/archive/wechat-reader.js';

const NOW = Date.UTC(2026, 9, 19, 10);
const SECONDS = Math.floor((NOW - 60000) / 1000);
const URL = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(WECHAT_READER_BIZ)}&mid=2247498657&idx=1&sn=${'a'.repeat(32)}`;
const session = { kind: 'wechat-reader', account_biz: WECHAT_READER_BIZ, uin: '12345', key: 'reader-key', pass_ticket: 'reader-pass', cookie: 'wap_sid2=reader-cookie', expires_at: NOW + 60000 };
const code = expected => error => error instanceof CollectorError && error.code === expected;
const html = (scripts = `var comment_id = '987654321'; var ct = '${SECONDS}';`) => `<html><head><title>猫笔刀</title><meta property="og:url" content="${URL.replace(/&/g, '&amp;')}"></head><body><h1 id="activity-name">当天文章</h1><div id="js_name">猫笔刀</div><div id="js_content"><p>完整公开正文</p><img data-src="https://mmbiz.qpic.cn/article.png"></div><script>${scripts}</script></body></html>`;
const listedItem = (overrides = {}) => ({ title: '新文章', author: '猫笔刀', content_url: URL, ...overrides });
const list = (overrides = {}) => JSON.stringify({ ret: 0, can_msg_continue: 0, next_offset: 10,
  general_msg_list: JSON.stringify({ list: [{ comm_msg_info: { datetime: SECONDS }, app_msg_ext_info: listedItem() }] }), ...overrides });
const resolveHost = async hostname => assert.equal(hostname, 'mp.weixin.qq.com');

test('reader canonical identities discard all authentication and tracking values', () => {
  const identity = validateReaderArticleUrl(`${URL}&key=private&uin=123&pass_ticket=private&scene=124#wechat_redirect`);
  assert.equal(identity.url, URL);
  assert.equal(identity.source_key, `wechat:${WECHAT_READER_BIZ}:2247498657:1`);
  assert.equal(identity.account_biz, WECHAT_READER_BIZ);
  assert.equal(identity.sn, 'a'.repeat(32));
});

test('reader rejects arbitrary destinations, duplicate identity parameters and wrong accounts', () => {
  for (const url of [URL.replace('https:', 'http:'), URL.replace('mp.weixin.qq.com', 'evil.example'),
    URL.replace('mp.weixin.qq.com', 'mp.weixin.qq.com.evil.example'), URL.replace('https://', 'https://u:p@'),
    `${URL}&__biz=${WECHAT_READER_BIZ}`, `${URL}&mid=2247498657`, URL.replace('idx=1', 'idx=0'),
    URL.replace(encodeURIComponent(WECHAT_READER_BIZ), 'another'), URL.replace('/s?', '/mp/profile_ext?')]) {
    assert.throws(() => validateReaderArticleUrl(url), error => error instanceof CollectorError);
  }
});

test('reader credentials are separately typed, bounded and expire before transmission', () => {
  assert.equal(normalizeReaderCredentials(null), null);
  assert.deepEqual(normalizeReaderCredentials(session, { now: NOW }), session);
  assert.equal(normalizeReaderCredentials({ ...session, uin: btoa('12345') }, { now: NOW }).uin, btoa('12345'));
  for (const value of [{ ...session, kind: 'wechat-backend' }, { ...session, account_biz: 'other' },
    { ...session, biz: 'other' }, { ...session, uin: 'x' }, { ...session, uin: btoa('not-a-number') }, { ...session, key: 'private\r\nInjected: yes' },
    { ...session, cookie: 'slave_sid=backend' }, { ...session, cookie: 'x=y; slave_user=backend' },
    { ...session, expires_at: NOW }, { ...session, key: 'a'.repeat(4097) }]) {
    assert.throws(() => normalizeReaderCredentials(value, { now: NOW }), code('READER_LOGIN_REQUIRED'));
  }
});

test('transport appends reading credentials only to approved fixed-host endpoints', async () => {
  let requests = 0;
  const response = await readerFetch('https://mp.weixin.qq.com/mp/appmsg_comment?action=getcomment', {
    credentials: session, now: NOW, resolveHost,
    fetchImpl: async (url, options) => {
      requests++;
      const target = new globalThis.URL(url);
      assert.equal(target.searchParams.get('uin'), session.uin);
      assert.equal(target.searchParams.get('key'), session.key);
      assert.equal(target.searchParams.get('pass_ticket'), session.pass_ticket);
      assert.equal(options.headers.cookie, session.cookie);
      assert.equal(options.redirect, 'manual');
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(requests, 1);
  assert.deepEqual(Object.keys(response).sort(), ['bytes', 'contentType', 'status']);
  await assert.rejects(readerFetch(URL.replace(encodeURIComponent(WECHAT_READER_BIZ), 'other'), { credentials: session, now: NOW, resolveHost, fetchImpl: async () => assert.fail('must not send') }), code('READER_SOURCE_MISMATCH'));
  await assert.rejects(readerFetch('https://evil.example/mp/appmsg_comment', { credentials: session, now: NOW, resolveHost, fetchImpl: async () => assert.fail('must not send') }), code('UNSAFE_URL'));
});

test('transport never follows a redirect with or without reading credentials', async () => {
  for (const credentials of [null, session]) {
    let requests = 0;
    await assert.rejects(readerFetch('https://mp.weixin.qq.com/mp/profile_ext', {
      credentials, now: NOW, resolveHost, fetchImpl: async () => {
        requests++;
        return new Response(null, { status: 302, headers: { location: 'https://evil.example/?key=private' } });
      },
    }), code('CHALLENGE_REQUIRED'));
    assert.equal(requests, 1);
  }
});

test('transport bounds declared and streamed bytes and classifies status without leaking keys', async () => {
  for (const [status, expected] of [[429, 'RATE_LIMITED'], [401, 'READER_LOGIN_REQUIRED'], [403, 'CHALLENGE_REQUIRED'], [503, 'UPSTREAM_ERROR']]) {
    await assert.rejects(readerFetch('https://mp.weixin.qq.com/mp/profile_ext', { resolveHost, fetchImpl: async () => new Response('', { status }) }), code(expected));
  }
  await assert.rejects(readerFetch(URL, { maxBytes: 8, resolveHost, fetchImpl: async () => new Response('too long body') }), code('RESOURCE_TOO_LARGE'));
  await assert.rejects(readerFetch(URL, { maxBytes: 8, resolveHost, fetchImpl: async () => new Response('x', { headers: { 'content-length': '99' } }) }), code('RESOURCE_TOO_LARGE'));
  await assert.rejects(readerFetch('https://mp.weixin.qq.com/mp/profile_ext', { credentials: session, now: NOW, resolveHost,
    fetchImpl: async () => { throw new Error('failed key=reader-key cookie=reader-cookie'); } }), error => code('UPSTREAM_ERROR')(error) && !/reader-key|reader-cookie/.test(error.message));
});

test('public article probe does not request or transmit a stored reading session', async () => {
  const reader = createWechatReader({ now: () => NOW, resolveHost,
    credentialsLoader: async () => assert.fail('public article must remain anonymous'),
    fetchImpl: async (url, options) => {
      assert.equal(url, URL);
      assert.equal(options.headers.cookie, undefined);
      return new Response(html());
    },
  });
  const article = await reader.probeArticle({}, URL);
  assert.equal(article.body_readable, true);
  assert.equal(article.comment_id, '987654321');
  assert.equal(article.published_at, SECONDS * 1000);
  assert.equal(article.time_trusted, true);
  assert.equal(article.image_count, 1);
  assert.equal(article.text, '完整公开正文');
});

test('an article retries exactly once with reading authorization only after an explicit challenge', async () => {
  const calls = [];
  const reader = createWechatReader({ now: () => NOW, resolveHost, credentialsLoader: async () => session,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(calls.length === 1 ? '<body>当前环境异常，请完成安全验证</body>' : html());
    },
  });
  const result = await reader.probeArticle({}, URL);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.cookie, undefined);
  assert.equal(calls[1].options.headers.cookie, session.cookie);
  assert.equal(new globalThis.URL(calls[1].url).searchParams.get('key'), session.key);
  assert.equal(result.article_identity.url, URL);
  assert.doesNotMatch(JSON.stringify(result), /reader-key|reader-cookie|reader-pass/);
});

test('article limits and missing reading authorization do not cause repeated retries', async () => {
  for (const [body, expected] of [['<body>访问过于频繁</body>', 'RATE_LIMITED'], ['<body>该内容已被发布者删除</body>', 'ARTICLE_REMOVED']]) {
    let requests = 0;
    const reader = createWechatReader({ now: () => NOW, resolveHost, credentialsLoader: async () => assert.fail('must not request session'),
      fetchImpl: async () => { requests++; return new Response(body); },
    });
    await assert.rejects(reader.probeArticle({}, URL), code(expected));
    assert.equal(requests, 1);
  }
  let attempts = 0;
  const reader = createWechatReader({ now: () => NOW, resolveHost, credentialsLoader: async () => null,
    fetchImpl: async () => { attempts++; return new Response('<body>当前环境异常，请完成安全验证</body>'); },
  });
  await assert.rejects(reader.probeArticle({}, URL), code('CHALLENGE_REQUIRED'));
  assert.equal(attempts, 1);
});

test('comment id extraction handles ordinary, decoded, XML and window templates', () => {
  for (const script of ["var comment_id = '123' || '0';", 'let comment_id = "123";', "comment_id: JsDecode('123')",
    "d.comment_id = xml ? getXmlValue('comment_id.DATA') : '123';", "window.comment_id = '123';", "window.segment_comment_id = '123';"]) {
    assert.equal(parseReaderArticle(html(script), { url: URL, now: NOW }).comment_id, '123');
  }
});

test('comment id extraction ignores strings, comments, template contents and regex text', () => {
  const script = `// var comment_id = '11';\n/* var comment_id = '22'; */\nconst text = "var comment_id = '33';"; const template = \`var comment_id = '44';\`; const regex = /var comment_id = '55';/; var comment_id = '66';`;
  assert.equal(parseReaderArticle(html(script), { url: URL, now: NOW }).comment_id, '66');
  assert.equal(parseReaderArticle(html("var comment_id = '0';"), { url: URL, now: NOW }).comment_id, null);
  assert.throws(() => parseReaderArticle(html("var comment_id = '12'; window.comment_id = '13';"), { url: URL, now: NOW }), code('READER_RESPONSE_INVALID'));
  assert.equal(parseReaderArticle(html("const ratio=1/2; var comment_id='66';"), { url: URL, now: NOW }).comment_id, '66');
  assert.equal(parseReaderArticle(html("const re=/[\\/]var comment_id = '55';/; var comment_id='66';"), { url: URL, now: NOW }).comment_id, '66');
});

test('unreadable articles, challenges and cross-article canonicals are distinguished', () => {
  for (const [body, expected] of [['<body>当前环境异常，请完成安全验证</body>', 'CHALLENGE_REQUIRED'],
    ['<body>访问过于频繁</body>', 'RATE_LIMITED'], ['<body>该内容已被发布者删除</body>', 'ARTICLE_REMOVED'],
    ['<body>请先登录</body>', 'READER_LOGIN_REQUIRED'], ['<body>空白</body>', 'ARTICLE_INVALID']]) {
    assert.throws(() => parseReaderArticle(body, { url: URL, now: NOW }), code(expected));
  }
  assert.throws(() => parseReaderArticle(html().replace('mid=2247498657', 'mid=2247498658'), { url: URL, now: NOW }), code('READER_SOURCE_MISMATCH'));
  const article = parseReaderArticle(html('var ct = "1999999999";'), { url: URL, now: NOW });
  assert.equal(article.published_at, null);
  assert.equal(article.time_trusted, false);
});

test('mobile reading list includes main and multi-article messages with canonical identities', () => {
  const siblingUrl = URL.replace('idx=1', 'idx=2').replace('https:', 'http:').replace(/&/g, '&amp;');
  const result = parseReaderList(list({ can_msg_continue: 1, next_offset: 10,
    general_msg_list: { list: [{ comm_msg_info: { datetime: SECONDS }, app_msg_ext_info: listedItem({ multi_app_msg_item_list: [listedItem({ title: '第二篇', content_url: siblingUrl })] }) }] },
  }), { now: NOW });
  assert.equal(result.articles.length, 2);
  assert.equal(result.articles[1].url, URL.replace('idx=1', 'idx=2'));
  assert.equal(result.articles[1].published_at, SECONDS * 1000);
  assert.equal(result.articles[1].metadata.source_kind, 'wechat-reader');
  assert.equal(result.has_more, true);
  assert.equal(result.next_cursor, 10);
});

test('reader list rejects cross-source entries, untrusted times and non-advancing cursors', () => {
  assert.throws(() => parseReaderList(list({ general_msg_list: { list: [{ comm_msg_info: { datetime: SECONDS }, app_msg_ext_info: listedItem({ content_url: URL.replace(encodeURIComponent(WECHAT_READER_BIZ), 'other') }) }] } }), { now: NOW }), code('READER_SOURCE_MISMATCH'));
  for (const datetime of [null, String(SECONDS), Math.floor(NOW / 1000) + 10000]) {
    assert.throws(() => parseReaderList(list({ general_msg_list: { list: [{ comm_msg_info: { datetime }, app_msg_ext_info: listedItem() }] } }), { now: NOW }), code('READER_TIME_INVALID'));
  }
  assert.throws(() => parseReaderList(list({ can_msg_continue: 1, next_offset: 0 }), { now: NOW }), code('READER_RESPONSE_INVALID'));
  assert.throws(() => parseReaderList(list({ general_msg_list: 'not json' }), { now: NOW }), code('READER_RESPONSE_INVALID'));
});

test('reader list response classes do not expose upstream diagnostics', () => {
  for (const [body, expected] of [[JSON.stringify({ ret: 200013, errmsg: 'secret key=private' }), 'RATE_LIMITED'],
    [JSON.stringify({ ret: -3, errmsg: 'private' }), 'READER_LOGIN_REQUIRED'],
    [JSON.stringify({ ret: 3, errmsg: '请完成安全验证 private' }), 'CHALLENGE_REQUIRED'],
    ['<html>请先登录 private</html>', 'READER_LOGIN_REQUIRED'], ['{}', 'READER_RESPONSE_INVALID']]) {
    assert.throws(() => parseReaderList(body), error => code(expected)(error) && !error.message.includes('private'));
  }
});

test('reader probes anonymous lists before requiring any authorization', async () => {
  let requestCount = 0;
  const reader = createWechatReader({ resolveHost, now: () => NOW, fetchImpl: async (url, options) => {
    requestCount++;
    const parsed = new globalThis.URL(url);
    assert.equal(parsed.pathname, '/mp/profile_ext');
    assert.equal(parsed.searchParams.get('action'), 'getmsg');
    assert.equal(parsed.searchParams.get('__biz'), WECHAT_READER_BIZ);
    assert.equal(parsed.searchParams.has('key'), false);
    assert.equal(options.headers.cookie, undefined);
    return new Response(list());
  } });
  const result = await reader.probeSource({});
  assert.equal(result.articles.length, 1);
  assert.equal(requestCount, 1);
});

test('reader list uses explicitly supplied ordinary reading credentials', async () => {
  const reader = createWechatReader({ resolveHost, now: () => NOW, credentialsLoader: async () => session,
    fetchImpl: async (url, options) => {
      assert.equal(new globalThis.URL(url).searchParams.get('pass_ticket'), session.pass_ticket);
      assert.equal(options.headers.cookie, session.cookie);
      return new Response(list());
    },
  });
  assert.equal((await reader.listSourceArticles({}, { account_biz: WECHAT_READER_BIZ }, { cursor: 0, count: 20 })).articles.length, 1);
  await assert.rejects(reader.listSourceArticles({}, { account_biz: 'other' }), code('READER_SOURCE_MISMATCH'));
  await assert.rejects(reader.listSourceArticles({}, { account_biz: WECHAT_READER_BIZ }, { count: 21 }), code('INVALID_REQUEST'));
});
