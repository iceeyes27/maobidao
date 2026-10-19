#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceArticleKey } from "../src/archive/core.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_OUTPUT = path.join(ROOT, ".archive-import", "legacy.sql");
const ID = /^[a-f0-9]{32}$/i;

function sql(value) {
  if (value === undefined || value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("导入时间必须是有效的整数。");
    return String(value);
  }
  const text = String(value);
  // SQL source cannot contain a literal NUL. A UTF-8 blob cast preserves it without interpreting data as SQL.
  if (text.includes("\0")) return `CAST(X'${Buffer.from(text, "utf8").toString("hex")}' AS TEXT)`;
  return `'${text.replaceAll("'", "''")}'`;
}

function legacyTime(value, { wechat = false } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text);
  // wechat_to_site.py writes WeChat ct with timezone.utc and then removes its timezone.
  // Generic pages already carry their source timezone; do not guess when it is absent.
  if (naive && !wechat) return null;
  const normalized = naive ? `${text.replace(" ", "T")}Z` : text;
  const milliseconds = Date.parse(normalized);
  if (!Number.isSafeInteger(milliseconds)) return null;
  if (naive && new Date(milliseconds).toISOString().slice(0, 10) !== text.slice(0, 10)) return null;
  return milliseconds;
}

function normalize(row, index, now) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`第 ${index + 1} 条文章格式无效。`);
  if (!ID.test(row.id || "")) throw new Error(`第 ${index + 1} 条文章缺少原有的 32 位文章标识。`);
  if (typeof row.success !== "boolean") throw new Error(`第 ${index + 1} 条文章缺少明确的获取结果。`);
  const id = row.id.toLowerCase();
  const sourceKey = sourceArticleKey(row.url);
  const wechat = new URL(row.url).hostname === "mp.weixin.qq.com";
  const contentText = String(row.content_text || "");
  const summary = typeof row.summary === "string" ? row.summary : `${contentText.slice(0, 160)}${contentText.length > 160 ? "…" : ""}`;
  const capturedAt = row.success ? legacyTime(row.fetched_at, { wechat: true }) || now : null;
  const metadata = {
    author: String(row.author || row.account_name || ""),
    source_name: String(row.source_name || ""), source_host: String(row.source_host || ""),
    filename: `${id}.html`, fetched_at: String(row.fetched_at || ""),
  };
  return {
    id, source_key: sourceKey, url: row.url, title: String(row.title || ""),
    account_name: String(row.account_name || ""), publish_time: String(row.publish_time || ""),
    first_published_at: legacyTime(row.publish_time, { wechat }), status: row.success ? "published" : "failed",
    metadata_json: JSON.stringify(metadata), content_text: contentText, summary,
    captured_at: capturedAt, published_at: capturedAt, last_error: row.success ? null : String(row.error || "旧文章获取失败。"),
    created_at: now, updated_at: now,
  };
}

function targetArticle(key) {
  return `COALESCE((SELECT article_id FROM archive_article_aliases WHERE alias_key=${sql(key)}),(SELECT id FROM archive_articles WHERE source_key=${sql(key)}))`;
}

export function buildLegacySql(cache, { now = Date.now() } = {}) {
  if (!cache || !Array.isArray(cache.articles)) throw new Error("文章缓存必须包含 articles 数组。");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("导入时间无效。");
  const articles = cache.articles.map((row, index) => normalize(row, index, now));
  const byId = new Map();
  const bySource = new Map();
  for (const article of articles) {
    if (byId.has(article.id) && byId.get(article.id) !== article.source_key) throw new Error(`原文章标识 ${article.id} 对应不同来源，导入已停止。`);
    byId.set(article.id, article.source_key);
    const previous = bySource.get(article.source_key);
    if (!previous || (previous.status === "failed" && article.status === "published")) bySource.set(article.source_key, article);
  }
  const lines = [
    "-- Legacy article metadata only. Existing Static Assets remain the body/image source.",
    "-- D1 file imports supply their transaction; do not add BEGIN/COMMIT statements.",
    "-- https://developers.cloudflare.com/d1/best-practices/import-export-data/",
    "PRAGMA defer_foreign_keys = true;",
  ];
  const columns = ["id", "source_key", "url", "title", "account_name", "publish_time", "first_published_at", "status", "metadata_json", "content_text", "summary", "captured_at", "published_at", "last_error", "created_at", "updated_at"];
  for (const article of bySource.values()) {
    lines.push(`INSERT INTO archive_articles (${columns.join(",")},legacy_fallback)
SELECT ${columns.map((column) => sql(article[column])).join(",")},1
WHERE NOT EXISTS (SELECT 1 FROM archive_articles WHERE source_key=${sql(article.source_key)})
  AND NOT EXISTS (SELECT 1 FROM archive_article_aliases WHERE alias_key=${sql(article.source_key)});`);
  }
  const seenAliases = new Set();
  for (const article of articles) {
    if (seenAliases.has(article.id)) continue;
    seenAliases.add(article.id);
    const target = targetArticle(article.source_key);
    const collision = `(EXISTS(SELECT 1 FROM archive_articles WHERE id=${sql(article.id)} AND id!=target.id)
      OR EXISTS(SELECT 1 FROM archive_article_aliases WHERE (alias_key=${sql(`legacy-id:${article.id}`)} OR alias_id=${sql(article.id)}) AND article_id!=target.id))`;
    // A conflicting old URL must fail the transaction instead of silently pointing to another article.
    // NULL violates article_id's existing NOT NULL constraint; this does not create helper tables or change schema.
    lines.push(`INSERT INTO archive_article_aliases (alias_key,alias_id,article_id,url)
SELECT ${sql(`legacy-id:${article.id}`)},${sql(article.id)},CASE WHEN ${collision} THEN NULL ELSE target.id END,${sql(article.url)}
FROM archive_articles target WHERE target.id=${target}
ON CONFLICT(alias_key) DO NOTHING;`);
    lines.push(`INSERT INTO archive_article_aliases (alias_key,article_id,url)
SELECT ${sql(article.source_key)},target.id,${sql(article.url)} FROM archive_articles target WHERE target.id=${target}
ON CONFLICT(alias_key) DO NOTHING;`);
  }
  return {
    sql: `${lines.join("\n\n")}\n`, articles: articles.length, unique: bySource.size,
    published: [...bySource.values()].filter((article) => article.status === "published").length,
    failed: [...bySource.values()].filter((article) => article.status === "failed").length,
  };
}

export async function main(args = process.argv.slice(2)) {
  let output = DEFAULT_OUTPUT;
  let selectedOutput = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log("用法：node scripts/import-archive.mjs [--output 文件路径]\n只生成旧文章导入 SQL，不连接或修改数据库。");
      return;
    }
    let value;
    if (argument === "--output") value = args[++index];
    else if (argument.startsWith("--output=")) value = argument.slice("--output=".length);
    else throw new Error(`不支持的参数：${argument}`);
    if (selectedOutput || !value || value.startsWith("--")) throw new Error("请提供一个有效的 --output 文件路径。");
    selectedOutput = true;
    output = path.resolve(value);
  }
  const input = await readFile(path.join(ROOT, "data", "articles-cache.json"), "utf8");
  const result = buildLegacySql(JSON.parse(input.replace(/^\uFEFF/, "")));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, result.sql, { encoding: "utf8" });
  console.log(`已生成 ${output}\n来源 ${result.articles} 条，去重后 ${result.unique} 条，其中成功 ${result.published} 篇、失败 ${result.failed} 条。未执行数据库导入。`);
  return { ...result, output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
