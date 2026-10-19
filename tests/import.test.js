import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildLegacySql } from "../scripts/import-archive.mjs";
import { sourceArticleKey } from "../src/archive/core.js";

const originalId = "a7ab296552e7da020642e4150c0b2a4e";
const secondId = "22aaa2d4779c7a7a3c2c3aa4814a206e";
const cloudId = "9930aac267fd39379cb2c78d14998634";
const row = (patch = {}) => ({ id: originalId, url: "https://mp.weixin.qq.com/s/example", title: "原有文章", account_name: "原作者", source_name: "微信公众号", source_host: "mp.weixin.qq.com", publish_time: "2026-06-12 14:21:25", content_text: "保留正文摘要。", content_html: "<p>正文不进入 SQL。</p>", fetched_at: "2026-06-12 15:26:32", success: true, ...patch });

function setup(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_archive.sql", import.meta.url), "utf8"));
  t.after(() => db.close());
  return db;
}

function apply(db, sql) {
  db.exec("BEGIN");
  try { db.exec(sql); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

test("legacy import is repeatable and preserves old identity, metadata, and static body fallback", (t) => {
  const db = setup(t);
  const result = buildLegacySql({ articles: [row(), row({ id: secondId, url: "https://example.com/failed", success: false, error: "原文已删除。", publish_time: "" })] }, { now: 1000 });
  apply(db, result.sql);
  apply(db, result.sql);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM archive_articles").get().n, 2);
  const saved = db.prepare("SELECT * FROM archive_articles WHERE id=?").get(originalId);
  assert.equal(saved.url, row().url);
  assert.equal(saved.publish_time, "2026-06-12 14:21:25");
  assert.equal(saved.first_published_at, Date.parse("2026-06-12T14:21:25Z"));
  assert.equal(saved.status, "published");
  assert.equal(saved.legacy_fallback, 1);
  assert.equal(saved.body_key, null);
  assert.equal(saved.manifest_json, "[]");
  assert.equal(saved.summary, "保留正文摘要。");
  assert.equal(JSON.parse(saved.metadata_json).filename, `${originalId}.html`);
  assert.equal(db.prepare("SELECT article_id FROM archive_article_aliases WHERE alias_id=?").get(originalId).article_id, originalId);
  assert.equal(db.prepare("SELECT status FROM archive_articles WHERE id=?").get(secondId).status, "failed");
  assert.ok(!result.sql.includes("<p>正文不进入 SQL。</p>"));
  assert.ok(!/\b(?:BEGIN|COMMIT)\s*;/i.test(result.sql));
});

test("legacy strings, including quotes and NUL, are data and cannot execute SQL", (t) => {
  const db = setup(t);
  const title = "O'Brien'); DROP TABLE archive_articles; --\n第二行";
  const summary = "含有\0空字符和'单引号";
  apply(db, buildLegacySql({ articles: [row({ title, summary })] }).sql);
  const saved = db.prepare("SELECT title,hex(summary) AS summary_hex FROM archive_articles").get();
  assert.equal(saved.title, title);
  assert.equal(saved.summary_hex, Buffer.from(summary, "utf8").toString("hex").toUpperCase());
});

test("canonical source dedup preserves every historical article URL via aliases", (t) => {
  const db = setup(t);
  const first = row({ url: "https://mp.weixin.qq.com/s?__biz=account&mid=123&idx=1&scene=1" });
  const second = row({ id: secondId, url: "https://mp.weixin.qq.com/s?__biz=account&mid=123&idx=1&scene=2" });
  const result = buildLegacySql({ articles: [first, second] });
  apply(db, result.sql);
  assert.equal(result.unique, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM archive_articles").get().n, 1);
  for (const id of [originalId, secondId]) assert.equal(db.prepare("SELECT article_id FROM archive_article_aliases WHERE alias_id=?").get(id).article_id, originalId);
});

test("import reuses a newer cloud article without overwriting its fields", (t) => {
  const db = setup(t);
  const key = sourceArticleKey(row().url);
  db.prepare("INSERT INTO archive_articles(id,source_key,url,title,status,body_key,legacy_fallback,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(cloudId, key, row().url, "云端已编辑标题", "published", "articles/new/body.html", 0, 1, 2);
  const sql = buildLegacySql({ articles: [row()] }).sql;
  apply(db, sql);
  apply(db, sql);
  const saved = db.prepare("SELECT * FROM archive_articles").get();
  assert.equal(saved.id, cloudId);
  assert.equal(saved.title, "云端已编辑标题");
  assert.equal(saved.body_key, "articles/new/body.html");
  assert.equal(saved.legacy_fallback, 0);
  assert.equal(saved.updated_at, 2);
  assert.equal(db.prepare("SELECT article_id FROM archive_article_aliases WHERE alias_id=?").get(originalId).article_id, cloudId);
});

test("an existing source alias also prevents a duplicate cloud article", (t) => {
  const db = setup(t);
  db.prepare("INSERT INTO archive_articles(id,source_key,url,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(cloudId, "wechat:account:canonical", row().url, "云端文章", "published", 1, 2);
  db.prepare("INSERT INTO archive_article_aliases(alias_key,article_id,url) VALUES(?,?,?)").run(sourceArticleKey(row().url), cloudId, row().url);
  apply(db, buildLegacySql({ articles: [row()] }).sql);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM archive_articles").get().n, 1);
  assert.equal(db.prepare("SELECT article_id FROM archive_article_aliases WHERE alias_id=?").get(originalId).article_id, cloudId);
});

test("identity collisions abort and roll back instead of changing existing articles", (t) => {
  const db = setup(t);
  db.prepare("INSERT INTO archive_articles(id,source_key,url,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(originalId, "url:https://example.com/unrelated", "https://example.com/unrelated", "既有文章", "published", 1, 2);
  const sql = buildLegacySql({ articles: [row({ id: secondId, url: "https://example.com/valid" }), row()] }).sql;
  assert.throws(() => apply(db, sql), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM archive_articles").get().n, 1);
  assert.equal(db.prepare("SELECT title FROM archive_articles").get().title, "既有文章");
});

test("an occupied historical alias cannot be redirected to another article", (t) => {
  const db = setup(t);
  db.prepare("INSERT INTO archive_articles(id,source_key,url,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(cloudId, "url:https://example.com/unrelated", "https://example.com/unrelated", "既有文章", "published", 1, 2);
  db.prepare("INSERT INTO archive_article_aliases(alias_key,alias_id,article_id,url) VALUES(?,?,?,?)").run(`legacy-id:${originalId}`, originalId, cloudId, "https://example.com/unrelated");
  assert.throws(() => apply(db, buildLegacySql({ articles: [row()] }).sql), /NOT NULL constraint failed/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM archive_articles").get().n, 1);
  assert.equal(db.prepare("SELECT article_id FROM archive_article_aliases WHERE alias_id=?").get(originalId).article_id, cloudId);
});

test("malformed caches and conflicting old identifiers fail before SQL is written", () => {
  assert.throws(() => buildLegacySql({}), /articles/);
  assert.throws(() => buildLegacySql({ articles: [row({ id: "bad" })] }), /32/);
  assert.throws(() => buildLegacySql({ articles: [row({ url: "javascript:alert(1)" })] }), /HTTP/);
  assert.throws(() => buildLegacySql({ articles: [row(), row({ url: "https://example.com/other" })] }), /不同来源/);
});
