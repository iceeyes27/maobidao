import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { handleAdmin, handleArchiveSubmit } from "../src/archive/api.js";
import { ArchiveStore } from "../src/archive/store.js";
import { beijingDate, createAdminSession } from "../src/archive/core.js";
import { RSS_ACCOUNT_BIZ, RSS_FEED_URL, RSS_STATE_KEY } from "../src/archive/rss-source.js";

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync(new URL("../migrations/0001_archive.sql", import.meta.url), "utf8"));
  sql.exec(readFileSync(new URL("../migrations/0002_admin_attempts.sql", import.meta.url), "utf8"));
  sql.exec(readFileSync(new URL("../migrations/0003_scheduler.sql", import.meta.url), "utf8"));
  const db = {
    prepare(query) {
      const statement = sql.prepare(query);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async first() { return statement.get(...values) || null; },
        async all() { return { results: statement.all(...values) }; },
        async run() { const result = statement.run(...values); return { meta: { changes: result.changes } }; },
        _query: query, get _values() { return values; },
      };
    },
    async batch(statements) {
      sql.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec("COMMIT"); return results; }
      catch (error) { sql.exec("ROLLBACK"); throw error; }
    },
  };
  const env = {
    SUBMIT_PASSWORD: "api-test-password", ARCHIVE_SESSION_KEY: Buffer.alloc(32, 5).toString("base64"),
    ARCHIVE_DB: db, ARCHIVE_BUCKET: {}, ARCHIVE_BROWSER: {}, ARCHIVE_EXECUTOR: {}, ARCHIVE_SCHEDULER: {}, ARCHIVE_ENABLED: "true", ARCHIVE_AUTO_ENABLED: "false",
    ARCHIVE_WORKFLOW: { async get() { throw new Error("Instance not found"); }, async create() { return {}; } },
  };
  return { sql, db, env, store: new ArchiveStore(db) };
}

async function adminRequest(path, env, data, extra = {}) {
  const cookie = await createAdminSession(env.SUBMIT_PASSWORD);
  return new Request(`https://archive.example${path}`, {
    method: data == null ? "GET" : "POST",
    headers: { cookie: `maobidao_admin=${cookie}`, origin: "https://archive.example", "content-type": "application/json", ...extra },
    ...(data == null ? {} : { body: JSON.stringify(data) }),
  });
}

test("administrator data requires a valid signed session", async () => {
  const { env } = fixture();
  await assert.rejects(() => handleAdmin(new Request("https://archive.example/api/admin/status"), env), { status: 401 });
  const response = await handleAdmin(await adminRequest("/api/admin/status", env), env);
  const status = await response.json();
  assert.equal(status.configured, true);
  assert.equal(status.enabled, false);
  assert.deepEqual(status.jobs, []);
});

test('RSS admin status exposes source coverage without private snapshot identities', async t => {
  const { env, store, sql } = fixture();
  t.after(() => sql.close());
  await store.initSource({ name: '猫笔刀', fakeid: `rss:${RSS_ACCOUNT_BIZ}` });
  const state = { kind: 'wechat-rss-source-state', feed_url: RSS_FEED_URL, account_biz: RSS_ACCOUNT_BIZ,
    coverage_start: 1_792_000_000_000, coverage_end: 1_792_001_000_000, fetched_at: 1_792_002_000_000,
    snapshot_key: 'private/internal-snapshot', articles: [{ metadata: { private: 'not-for-status' } }] };
  env.ARCHIVE_BUCKET.get = async key => {
    assert.equal(key, RSS_STATE_KEY);
    const body = JSON.stringify(state);
    return { size: body.length, text: async () => body };
  };
  const status = await (await handleAdmin(await adminRequest('/api/admin/status', env), env)).json();
  assert.equal(status.sources[0].provider, 'rss');
  assert.equal(status.sources[0].coverage_start, state.coverage_start);
  assert.equal(status.sources[0].coverage_end, state.coverage_end);
  assert.equal(status.sources[0].rss_feed_url, RSS_FEED_URL);
  assert.doesNotMatch(JSON.stringify(status), /internal-snapshot|not-for-status/);
});

test('RSS admin status retains its provider with unavailable or corrupt coverage', async t => {
  const { env, store, sql } = fixture();
  t.after(() => sql.close());
  await store.initSource({ name: '猫笔刀', fakeid: `rss:${RSS_ACCOUNT_BIZ}` });
  for (const response of [null, { size: 200_000, text: () => assert.fail('Oversized state must not be allocated') },
    { size: 10, text: async () => 'invalid' }]) {
    env.ARCHIVE_BUCKET.get = async () => response;
    const status = await (await handleAdmin(await adminRequest('/api/admin/status', env), env)).json();
    assert.equal(status.sources[0].provider, 'rss');
    assert.equal(status.sources[0].coverage_start, undefined);
  }
});

test("pasted-link passwords cannot bypass the shared password attempt limit", async () => {
  const { env } = fixture();
  for (let index = 0; index < 10; index++) {
    const request = new Request("https://archive.example/api/submit", { method: "POST", body: JSON.stringify({ password: "incorrect", links: ["https://example.com/article"] }) });
    await assert.rejects(() => handleArchiveSubmit(request, env), { status: 401 });
  }
  const request = new Request("https://archive.example/api/admin/login", { method: "POST", body: JSON.stringify({ password: env.SUBMIT_PASSWORD }) });
  await assert.rejects(() => handleAdmin(request, env), { status: 429 });
});

test("a same-day history retry retains its original frozen time upper bound", async () => {
  const { env, store } = fixture();
  const source = await store.initSource({ name: "Test source", fakeid: "test-source" });
  const data = { kind: "history", source_id: source.id, start_date: beijingDate(), end_date: beijingDate() };
  const first = await handleAdmin(await adminRequest("/api/admin/jobs", env, data, { "idempotency-key": "history-request" }), env);
  const original = (await first.json()).job;
  await new Promise((resolve) => setTimeout(resolve, 10));
  const repeat = await handleAdmin(await adminRequest("/api/admin/jobs", env, data, { "idempotency-key": "history-request" }), env);
  const replay = (await repeat.json()).job;
  assert.equal(replay.id, original.id);
  assert.equal(replay.range_end, original.range_end);
});

test("historical sources do not enlarge the one automatic-source allowance", async () => {
  const { env, store } = fixture();
  const first = await handleAdmin(await adminRequest("/api/admin/sources", env, { name: "First", fakeid: "first" }), env);
  assert.equal((await first.json()).source.enabled, true);
  const second = await handleAdmin(await adminRequest("/api/admin/sources", env, { name: "Second", fakeid: "second" }), env);
  const source = (await second.json()).source;
  assert.equal(source.enabled, false);
  const request = await adminRequest(`/api/admin/sources/${source.id}`, env, { enabled: true });
  await assert.rejects(() => handleAdmin(new Request(request, { method: "PATCH" }), env), { code: "SOURCE_LIMIT" });
  assert.equal((await store.listSources()).filter((item) => item.enabled).length, 1);
});

async function selectedAutomatic(store, { date = beijingDate(), captured = false, published = false, cancelled = false } = {}) {
  const source = await store.initSource({ name: "原公众号", fakeid: "original-source" });
  const job = await store.createJob({ kind: "auto", source_id: source.id, monitor_date: date });
  const { article } = await store.addJobArticle(job.id, { url: "https://mp.weixin.qq.com/s/original-article", title: "原文章" });
  await store.selectDailyArticle(source.id, date, article.source_key, job.id);
  if (captured) await store.db.prepare("UPDATE archive_articles SET captured_at=?,status=? WHERE id=?")
    .bind(Date.now(), published ? "published" : "ready", article.id).run();
  if (published) await store.updateJob(job.id, { status: "completed" });
  if (cancelled) await store.setJobControl(job.id, "cancel");
  await store.updateSource(source.id, { enabled: false });
  return { source, job, article };
}

async function enableSource(env, sourceId) {
  const request = await adminRequest(`/api/admin/sources/${sourceId}`, env, { enabled: true });
  return handleAdmin(new Request(request, { method: "PATCH" }), env);
}

test("switching sources after tonight's capture cannot enlarge the nightly total", async t => {
  const { env, store, sql } = fixture();
  t.after(() => sql.close());
  await selectedAutomatic(store, { captured: true, published: true });
  const other = await store.initSource({ name: "其他公众号", fakeid: "other-source" });
  await store.updateSource(other.id, { enabled: false });
  await assert.rejects(enableSource(env, other.id), { code: "DAILY_ARTICLE_RESERVED", status: 409 });
  assert.equal((await store.getSource(other.id)).enabled, false);
});

test("cancelling tonight's selected article retains that night's reservation", async t => {
  const { env, store, sql } = fixture();
  t.after(() => sql.close());
  await selectedAutomatic(store, { cancelled: true });
  const other = await store.initSource({ name: "其他公众号", fakeid: "other-source" });
  await store.updateSource(other.id, { enabled: false });
  await assert.rejects(enableSource(env, other.id), { code: "DAILY_ARTICLE_RESERVED" });
});

test("an incomplete article from an older source blocks switching until explicitly ended", async t => {
  const { env, store, sql } = fixture();
  t.after(() => sql.close());
  const previousDate = beijingDate(Date.now() - 86_400_000);
  const { job } = await selectedAutomatic(store, { date: previousDate });
  const other = await store.initSource({ name: "其他公众号", fakeid: "other-source" });
  await store.updateSource(other.id, { enabled: false });
  await assert.rejects(enableSource(env, other.id), { code: "AUTOMATIC_ARTICLE_PENDING", status: 409 });
  await store.setJobControl(job.id, "cancel");
  assert.equal((await (await enableSource(env, other.id)).json()).source.enabled, true);
});

test("an older captured article awaiting website publication does not block the next source", async t => {
  const { env, store, sql } = fixture();
  t.after(() => sql.close());
  const { job, article } = await selectedAutomatic(store, { date: beijingDate(Date.now() - 86_400_000), captured: true });
  // A job may still refer to the pre-merge identity of an already captured article.
  await store.db.prepare("INSERT INTO archive_article_aliases(alias_key,article_id,url) VALUES (?,?,?)")
    .bind("url:https://example.com/old-identity", article.id, "https://example.com/old-identity").run();
  await store.db.prepare("UPDATE archive_jobs SET article_key=? WHERE id=?")
    .bind("url:https://example.com/old-identity", job.id).run();
  const other = await store.initSource({ name: "其他公众号", fakeid: "other-source" });
  await store.updateSource(other.id, { enabled: false });
  assert.equal((await (await enableSource(env, other.id)).json()).source.enabled, true);
});

for (const reason of ["tonight", "carryover"]) {
  test(`adding a source during ${reason} reservation saves it disabled and still permits history`, async t => {
    const { env, store, sql } = fixture();
    t.after(() => sql.close());
    await selectedAutomatic(store, reason === "tonight"
      ? { captured: true, published: true } : { date: beijingDate(Date.now() - 86_400_000) });
    const added = await handleAdmin(await adminRequest("/api/admin/sources", env, { name: "新增公众号", fakeid: "new-source" }), env);
    assert.equal(added.status, 201);
    const { source, notice } = await added.json();
    assert.equal(source.enabled, false);
    assert.match(notice, /自动获取保持停用/);
    assert.match(notice, /仍可获取历史文章/);
    const history = await handleAdmin(await adminRequest("/api/admin/jobs", env, {
      kind: "history", source_id: source.id, start_date: beijingDate(Date.now() - 86_400_000), end_date: beijingDate(),
    }), env);
    assert.equal(history.status, 202);
    assert.equal((await history.json()).job.kind, "history");
  });
}

test("saved login data does not claim the source currently accepts authentication", async () => {
  const { env, sql } = fixture();
  sql.exec("UPDATE archive_session SET object_key='private/state.json',version=1 WHERE singleton=1");
  const response = await handleAdmin(await adminRequest("/api/admin/status", env), env);
  assert.equal((await response.json()).login.status, "saved");
});

test("cross-origin mutation is rejected before changing a task", async () => {
  const { env } = fixture();
  const request = await adminRequest("/api/admin/jobs", env, {}, { origin: "https://different.example" });
  await assert.rejects(() => handleAdmin(request, env), { status: 403 });
});

test("browser operations preserve quota details across the execution boundary", async () => {
  const { env } = fixture();
  env.ARCHIVE_EXECUTOR = { getByName: () => ({ collectorOperation: async () => ({ ok: false,
    error: { code: "BROWSER_QUOTA_EXCEEDED", message: "等待额度恢复", retryable: false, retry_at: 2_000_000_000_000 },
  }) }) };
  await assert.rejects(() => adminRequest("/api/admin/sources/search?q=test", env).then(request => handleAdmin(request, env)),
    { code: "BROWSER_QUOTA_EXCEEDED", retry_at: 2_000_000_000_000, name: "CollectorError" });
});

test("login screenshots remain private while their bytes cross the execution boundary", async () => {
  const { env } = fixture();
  let calls = 0;
  env.ARCHIVE_EXECUTOR = { getByName: () => ({ collectorOperation: async () => {
    calls++;
    return { ok: true, value: { kind: "screenshot", bytes: new Uint8Array([137,80,78,71]).buffer,
      status: 200, headers: [["content-type", "image/png"], ["cache-control", "no-store, private"]] } };
  } }) };
  const path = "/api/admin/wechat/login/test-session/screenshot";
  await assert.rejects(() => handleAdmin(new Request(`https://archive.example${path}`), env), { status: 401 });
  assert.equal(calls, 0);
  const response = await handleAdmin(await adminRequest(path, env), env);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [137,80,78,71]);
});
