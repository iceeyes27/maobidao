import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArticleHtml } from '../src/archive/article-parser.js';
import { CollectorError } from '../src/archive/collector-security.js';
import { sanitizeBody } from '../src/archive/core.js';

const url = 'https://mp.weixin.qq.com/s/example';
const parse = html => parseArticleHtml(html, { url, wechat: true });
const article = (body, head = '', extra = '') => `<!doctype html><html><head><title>Fallback title</title>${head}</head><body><h1 id="activity-name">真实标题 &amp; 来源</h1><span id="js_author_name">作者甲</span><span id="js_name">公众号甲</span><div id="js_content">${body}</div>${extra}</body></html>`;
const hasCode = code => error => error instanceof CollectorError && error.code === code;

test('nested WeChat content preserves its exact body, metadata and decoded text', () => {
  const doc = parse(article('<section><p>第一段 <strong>加粗</strong> &amp; 实体</p><p>第二段</p></section>', '<meta property="article:published_time" content="2026-10-20T21:35:00+08:00">', '<footer>不属于正文</footer>'));
  assert.equal(doc.invalid, false);
  assert.equal(doc.challenge, false);
  assert.equal(doc.removed, false);
  assert.equal(doc.title, '真实标题 & 来源');
  assert.equal(doc.author, '作者甲');
  assert.equal(doc.source_name, '公众号甲');
  assert.equal(doc.date, '2026-10-20T21:35:00+08:00');
  assert.equal(doc.text, '第一段 加粗 & 实体第二段');
  assert.match(doc.html, /<section><p>第一段 <strong>加粗<\/strong>/);
  assert.ok(!doc.html.includes('不属于正文'));
  assert.deepEqual(doc.images, []);
});

test('lazy image precedence and relative URLs are deterministic and srcset is removed', () => {
  const doc = parse(article('<img data-src="//mmbiz.qpic.cn/a.png" data-original="/wrong.png" src="/placeholder.png" srcset="/small.png 1x, /large.png 2x"><img data-original="../b.jpg"><img src="/c.webp">'));
  assert.deepEqual(doc.images, ['https://mmbiz.qpic.cn/a.png', 'https://mp.weixin.qq.com/b.jpg', 'https://mp.weixin.qq.com/c.webp']);
  assert.ok(!/data-src|data-original|srcset/.test(doc.html));
  assert.match(doc.html, /src="https:\/\/mmbiz.qpic.cn\/a.png"/);
  assert.equal(doc.invalid, false);
});

test('missing or invalid image sources remain visible to caller validation', () => {
  const doc = parse(article('<img srcset="/one.png 1x, /two.png 2x"><img src="https://[broken"><img data-src="javascript:alert(1)">'));
  assert.deepEqual(doc.images, ['', 'https://[broken', 'javascript:alert(1)']);
  assert.match(doc.html, /src=""/);
});

test('an image-only article remains supported and duplicate source URLs are retained for caller deduplication', () => {
  const doc = parse(article('<img src="/one.png"><img src="/one.png">'));
  assert.equal(doc.invalid, false);
  assert.equal(doc.text, '');
  assert.equal(doc.images.length, 2);
});

test('script strings, comments and template content cannot impersonate real article elements', () => {
  const html = '<html><head><script>const fake = `<div id="js_content">Fake</div><h1 id="activity-name">Fake title</h1><meta property="og:url" content="https://evil.example/">`;</script></head><body><!-- <div id="js_content">Comment</div> --><template><div id="js_content">Template</div></template><p>没有正文</p></body></html>';
  const doc = parse(html);
  assert.equal(doc.invalid, true);
  assert.equal(doc.html, '');
  assert.equal(doc.title, '');
  assert.deepEqual(doc.images, []);
});

test('script, style and auxiliary text are excluded without executing any source script', () => {
  delete globalThis.articleParserExecuted;
  const doc = parse(article('正文<script>globalThis.articleParserExecuted = true;</script><style>.x{color:red}</style><nav>导航</nav><noscript>替代文本</noscript><form>表单</form><template>模板</template><p>结尾</p>'));
  assert.equal(globalThis.articleParserExecuted, undefined);
  assert.equal(doc.text, '正文结尾');
  assert.ok(!sanitizeBody(doc.html).includes('globalThis.articleParserExecuted'));
});

test('only genuine literal ct assignments supply WeChat creation time', () => {
  for (const value of ['1792532100', '"1792532100"', "'1792532100'"]) {
    assert.equal(parse(article('<p>正文</p>', `<script>var ct = ${value};</script>`)).created_seconds, 1792532100);
  }
  const fake = '<script>// var ct = "1000000000";\n/* var ct = "1000000001"; */ const x = "var ct = 1000000002;"; const re = /var ct = 1000000003;/; var ct = "1792532100";</script><script src="/remote.js">var ct = 1000000004;</script>';
  assert.equal(parse(article('<p>正文</p>', fake)).created_seconds, 1792532100);
  assert.equal(parse(article('<p>正文</p>', '<script>var ct = Date.now();</script>')).created_seconds, null);
});

test('canonical WeChat identity is normalized from real metadata and not source script text', () => {
  const doc = parse(article('<p>正文</p>', '<meta property="og:url" content="/s?__biz=accountABC&amp;mid=42&amp;idx=2"><script>const fake = \'<meta property="og:url" content="https://evil.example/">\';</script>'));
  assert.equal(doc.canonical, 'https://mp.weixin.qq.com/s?__biz=accountABC&mid=42&idx=2');
  assert.equal(parse(article('正文', '<link rel="canonical" href="/s?__biz=accountABC&amp;mid=43">')).canonical, 'https://mp.weixin.qq.com/s?__biz=accountABC&mid=43');
  for (const target of ['https://evil.example/s?__biz=abc&mid=42', 'javascript:alert(1)', '/s/no-identity']) {
    assert.equal(parse(article('正文', `<meta property="og:url" content="${target}">`)).canonical, '');
  }
});

test('the original standard URL remains the canonical fallback when it already contains identity', () => {
  const original = 'https://mp.weixin.qq.com/s?__biz=ABC&mid=42&idx=1';
  assert.equal(parseArticleHtml(article('正文'), { url: original, wechat: true }).canonical, original);
});

test('missing or empty WeChat body reports invalid and real challenge or deletion text is recognized', () => {
  assert.equal(parse('<body>当前环境异常，请完成安全验证</body>').challenge, true);
  assert.equal(parse('<body>当前环境异常，请完成安全验证<div id="js_content"></div></body>').challenge, true);
  assert.equal(parse(article('')).invalid, true);
  assert.equal(parse('<body>该内容已被发布者删除</body>').removed, true);
  assert.equal(parse(article('正文', '<script>const message = "该内容已被发布者删除 当前环境异常";</script>')).removed, false);
  assert.equal(parse(article('正文', '<script>const message = "请完成安全验证";</script>')).challenge, false);
  assert.equal(parse(article('这篇正文讨论“访问过于频繁”的提示。')).challenge, false);
});

test('generic articles select the first supported main element in document order', () => {
  const doc = parseArticleHtml('<title>General title</title><main><h1>Main heading</h1><p>Main text</p></main><article>Later article</article>', { url: 'https://news.example/path/page', wechat: false });
  assert.equal(doc.title, 'Main heading');
  assert.equal(doc.text, 'Main headingMain text');
  assert.ok(!doc.html.includes('Later article'));
  assert.equal(doc.created_seconds, null);
  const fragment = parseArticleHtml('<p>Plain fragment</p>', { url: 'https://news.example/a', wechat: false });
  assert.equal(fragment.text, 'Plain fragment');
  const withoutBody = parseArticleHtml('<html><head><title>Page title</title></head><p>Only body content</p></html>', { url: 'https://news.example/a', wechat: false });
  assert.equal(withoutBody.title, 'Page title');
  assert.equal(withoutBody.text, 'Only body content');
  assert.equal(withoutBody.html, '<p>Only body content</p>');
});

test('metadata fallbacks use real tags and role main without requiring a browser-inserted body', () => {
  const doc = parseArticleHtml('<head><meta property="og:title" content="Meta title"><meta name="author" content="Meta author"><meta property="og:site_name" content="Meta source"><meta name="date" content="2026-10-20"></head><div role="main"><time datetime="wrong">Text</time><p>Body</p></div>', { url: 'https://news.example/a', wechat: false });
  assert.equal(doc.title, 'Meta title');
  assert.equal(doc.author, 'Meta author');
  assert.equal(doc.source_name, 'Meta source');
  assert.equal(doc.date, '2026-10-20');
});

test('a generic verification page is distinguished from a complete article mentioning verification', () => {
  assert.equal(parseArticleHtml('<body>Verify you are human</body>', { url, wechat: false }).challenge, true);
  assert.equal(parseArticleHtml('<article><h1>About verification</h1>Verify you are human</article>', { url, wechat: false }).challenge, false);
});

test('inline background image URLs including escaped CSS cannot be silently omitted', () => {
  for (const style of ['background-image:url(/hidden.png)', 'background: URL("/hidden.png") center', 'back\\67 round: u\\72l(/hidden.png)', 'background: image-set("/hidden.png" 1x)', 'mask-image:url(/hidden.png)', 'border-image-source:url(/hidden.png)']) {
    assert.equal(parse(article(`<p style='${style}'>正文</p>`)).unsupported_background, true, style);
  }
});

test('colors, gradients, quoted content and font URLs do not become background image failures', () => {
  const doc = parse(article('<p style="background:linear-gradient(red, blue);background-color:#fff">正文</p>', '@not-css', ''));
  // Only style elements, not arbitrary head text, are parsed as CSS.
  assert.equal(doc.unsupported_background, false);
  assert.equal(parse(article('<p>正文</p>', '<style>@font-face {font-family:test;src:url(/font.woff)} #js_content::before{content:"url(example)"} #js_content{background:red}</style>')).unsupported_background, false);
});

test('static background rules match article elements while unrelated navigation backgrounds are ignored', () => {
  assert.equal(parse(article('<p class="hero">正文</p>', '<style>.hero{background-image:url(/one.png)}</style>')).unsupported_background, true);
  assert.equal(parse(article('<p>正文</p>', '<style>.navigation{background:url(/icon.png)}</style>', '<nav class="navigation">导航</nav>')).unsupported_background, false);
});

test('pseudo-elements, dynamic states and conditional rules are conservatively checked', () => {
  for (const selector of ['#js_content::before', '#js_content:after', '::before', '#js_content:hover']) {
    assert.equal(parse(article('正文', `<style>@media (min-width:99999px){${selector}{background-image:url(/pseudo.png)}}</style>`)).unsupported_background, true, selector);
  }
  assert.equal(parse(article('<p data-message="::before">正文</p>', '<style>[data-message="::before"]::after{background:url(/pseudo.png)}</style>')).unsupported_background, true);
  assert.equal(parse(article('<p data-message="a, b">正文</p>', '<style>[data-message="a, b"]::after{background:url(/pseudo.png)}</style>')).unsupported_background, true);
});

test('background CSS variables cannot conceal URLs while known color variables remain supported', () => {
  assert.equal(parse(article('<p style="background:var(--cover)">正文</p>', '<style>:root{--cover:url(/hidden.png)}</style>')).unsupported_background, true);
  assert.equal(parse(article('<p style="background:var(--unknown)">正文</p>')).unsupported_background, true);
  assert.equal(parse(article('<p style="background:var(--color)">正文</p>', '<style>:root{--color:#fff}</style>')).unsupported_background, false);
  assert.equal(parse(article('<p style="background:var(--color, linear-gradient(red, blue))">正文</p>')).unsupported_background, false);
  assert.equal(parse(article('<p style="background:var(--a)">正文</p>', '<style>:root{--a:var(--b);--b:var(--a)}</style>')).unsupported_background, true);
});

test('inherited image declarations cannot bypass the background completeness check', () => {
  assert.equal(parse(article('<p style="background:inherit">正文</p>', '<style>body{background-image:url(/inherited.png)}</style>')).unsupported_background, true);
});

test('unresolved stylesheet imports, malformed selectors and animated image backgrounds refuse incomplete capture', () => {
  for (const css of ['@import "/external.css";', '#js_content:unsupported-state {background:url(/hidden.png)}', '@keyframes rotate {to{background:url(/hidden.png)}}', '#js_content { background:url(/hidden.png)']) {
    assert.equal(parse(article('正文', `<style>${css}</style>`)).unsupported_background, true, css);
  }
});

test('ordinary omitted end tags do not lose nested article content', () => {
  const doc = parse(article('<p>One<p>Two<ul><li>Three<li>Four</ul>'));
  assert.equal(doc.text, 'OneTwoThreeFour');
  assert.match(doc.html, /<p>One<\/p><p>Two/);
});

test('deep or unusually large DOM and CSS fail with a bounded resource error', () => {
  assert.throws(() => parse(article('<div>'.repeat(5000) + '正文' + '</div>'.repeat(5000))), hasCode('RESOURCE_TOO_LARGE'));
  assert.throws(() => parse(article('<i>x</i>'.repeat(60_000))), hasCode('RESOURCE_TOO_LARGE'));
  assert.throws(() => parse(article('正文', `<style>/*${'x'.repeat(256 * 1024)}*/</style>`)), hasCode('RESOURCE_TOO_LARGE'));
});

test('invalid inputs have explicit errors and parsing never requests an external resource', () => {
  assert.throws(() => parseArticleHtml(null, { url, wechat: true }), hasCode('ARTICLE_INVALID'));
  assert.throws(() => parseArticleHtml('body', { url: 'invalid', wechat: true }), hasCode('INVALID_URL'));
  assert.throws(() => parse('x'.repeat(4 * 1024 * 1024 + 1)), hasCode('RESOURCE_TOO_LARGE'));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Network forbidden'); };
  try {
    assert.equal(parse(article('<img src="https://mmbiz.qpic.cn/image.png">', '<link rel="stylesheet" href="https://evil.example/style.css"><script src="https://evil.example/script.js"></script>')).images.length, 1);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});
