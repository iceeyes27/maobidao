import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
// Warm ordinary dependencies before Node 22's temporary module hook; this keeps
// CommonJS packages on their normal loader rather than the hook compatibility path.
import '../src/archive/api.js';

// Import the real Worker, routing, storage reader and rendering functions. Only
// deployment-provided base classes need stand-ins when running in Node.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'cloudflare:workers'
      ? { url: 'test:worker-comments-cloudflare', shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'test:worker-comments-cloudflare' ? { format: 'module', shortCircuit: true,
      source: 'export class DurableObject {} export class WorkflowEntrypoint {}' } : next(url, context);
  },
});
const { default: worker } = await import('../worker.js');
hooks.deregister();

const ARTICLE_ID = '1234567890abcdef1234567890abcdef';
const BODY_KEY = `articles/${ARTICLE_ID}/body.html`;
const COMMENTS_KEY = `private/wechat-reader/comments/${ARTICLE_ID}.json`;
const BODY = '<p>Preserved original body and images.</p><img src="/media/saved-photo" alt="Preserved image">';

function fixture(t, { snapshot = null, failure = false, published = true } = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('../migrations/0001_archive.sql', import.meta.url), 'utf8'));
  t.after(() => sql.close());
  const now = Date.now();
  sql.prepare(`INSERT INTO archive_articles(id,source_key,url,title,status,body_key,manifest_json,
    metadata_json,content_text,captured_at,published_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ARTICLE_ID, 'url:https://example.com/original', 'https://example.com/original',
    'Preserved article title', published ? 'published' : 'ready', BODY_KEY, '[]', '{}', 'Preserved original text', now, now, now, now);
  const db = { prepare(query) {
    let values = [];
    return {
      bind(...params) { values = params; return this; },
      async first() { return sql.prepare(query).get(...values) || null; },
      async all() { return { results: sql.prepare(query).all(...values) }; },
    };
  } };
  const reads = [];
  const warnings = [];
  t.mock.method(console, 'warn', value => warnings.push(String(value)));
  const env = { ARCHIVE_ENABLED: 'true', ARCHIVE_DB: db, ARCHIVE_BUCKET: { async get(key) {
    reads.push(key);
    if (key === BODY_KEY) return { size: Buffer.byteLength(BODY), text: async () => BODY };
    assert.equal(key, COMMENTS_KEY);
    if (failure) throw new Error('Private R2 failure with key=synthetic-secret');
    if (!snapshot) return null;
    const text = JSON.stringify(snapshot);
    return { size: Buffer.byteLength(text), text: async () => text };
  } }, ASSETS: { fetch() { assert.fail('Stored article and comments routes must not fall back to static assets'); } } };
  return { env, reads, warnings, fetch: path => worker.fetch(new Request(`https://archive.example${path}`), env) };
}

test('real article route serves the preserved body when optional comment storage fails', async t => {
  const f = fixture(t, { failure: true });
  const response = await f.fetch(`/articles/${ARTICLE_ID}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes(BODY));
  assert.ok(html.includes('Preserved article title'));
  assert.equal(html.includes('archived-comments'), false);
  assert.doesNotMatch(html, /synthetic-secret|Private R2 failure/);
  assert.deepEqual(f.reads, [BODY_KEY, COMMENTS_KEY]);
  assert.equal(f.warnings.length, 1);
  assert.doesNotMatch(f.warnings[0], /synthetic-secret|Private R2 failure/);
});

for (const [name, comments] of [['null comment entry', [null]], ['non-array reply list', [{ nickname: 'Reader', content: 'Public comment', replies: {} }]]]) {
  test(`real article route preserves the body when a saved JSON snapshot contains a ${name}`, async t => {
    const f = fixture(t, { snapshot: { comments, complete: true, checked_at: Date.now() } });
    const response = await f.fetch(`/articles/${ARTICLE_ID}.html`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(BODY));
    assert.equal(html.includes('archived-comments'), false);
    assert.doesNotMatch(html, /REQUEST_FAILED|服务暂时不可用/);
    assert.equal(f.warnings.length, 1);
  });
}

test('real article route renders valid public comments and replies as escaped text beside the original body', async t => {
  const nickname = '</strong><script>alert("nickname")</script>';
  const content = '<img src=x onerror="alert(1)">\nPublic second line';
  const reply = '<svg onload="alert(2)">';
  const f = fixture(t, { snapshot: { complete: true, checked_at: Date.now(), comments: [{ id: '1', nickname,
    content, created_at: Date.now(), like_count: 1, replies: [{ id: '2', nickname: 'Reply reader', content: reply }] }] } });
  const response = await f.fetch(`/articles/${ARTICLE_ID}`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes(BODY));
  assert.ok(html.includes('微信公开留言'));
  assert.ok(html.includes('&lt;/strong&gt;&lt;script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror='));
  assert.ok(html.includes('<br>Public second line'));
  assert.ok(html.includes('&lt;svg onload='));
  for (const payload of [nickname, content, reply]) assert.equal(html.includes(payload), false);
  assert.deepEqual(f.warnings, []);
});

test('public comments HTTP response exposes the saved public fields without internal continuation or authorization data', async t => {
  const comments = [{ id: '1', nickname: 'Public reader', content: 'Public comment', created_at: 1234, like_count: 2, replies: [] }];
  const snapshot = { article_id: ARTICLE_ID, source_key: 'private-internal-source', comments, complete: false,
    checked_at: 5678, next_cursor: { buffer: 'private-pagination-buffer', pending_replies: [] },
    session_revision: 'private-session-revision', credentials: { key: 'synthetic-private-key', uin: 'private-uin' } };
  const f = fixture(t, { snapshot });
  const response = await f.fetch(`/api/articles/${ARTICLE_ID}/comments`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'partial', comments, complete: false, checked_at: 5678 });
  assert.deepEqual(f.reads, [COMMENTS_KEY]);
});

test('an unpublished article cannot expose an otherwise readable comment snapshot', async t => {
  const f = fixture(t, { published: false, snapshot: { comments: [{ content: 'Hidden article comment' }], complete: true } });
  const response = await f.fetch(`/api/articles/${ARTICLE_ID}/comments`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'unavailable', comments: null });
  assert.deepEqual(f.reads, []);
});
