import test from "node:test";
import assert from "node:assert/strict";
import { automaticWindow, historyRange, eligibleArticle, sourceArticleKey, sanitizeBody, publicUrl, createAdminSession, isAdmin, readJson } from "../src/archive/core.js";

test("automatic window uses Beijing time and has one final check", () => {
  assert.equal(automaticWindow(Date.parse("2026-10-19T13:29:59Z")).active, false);
  assert.equal(automaticWindow(Date.parse("2026-10-19T13:30:00Z")).active, true);
  assert.equal(automaticWindow(Date.parse("2026-10-19T15:30:00Z")).final, true);
  assert.equal(automaticWindow(Date.parse("2026-10-19T15:30:01Z")).active, false);
  const window = automaticWindow(Date.parse("2026-10-19T15:30:00Z"));
  assert.equal(eligibleArticle({ published_at: window.end - 1 }, {}, window), true);
  assert.equal(eligibleArticle({ published_at: window.end }, {}, window), false);
  assert.equal(eligibleArticle({ published_at: window.start, time_trusted: false }, {}, window), false);
  assert.equal(eligibleArticle({ published_at: window.start }, { activated_at: window.start + 1 }, window), false);
});

test("history includes the end date, clamps today, and rejects rollover dates", () => {
  const now = Date.parse("2026-10-19T14:00:00Z");
  assert.deepEqual(historyRange("2026-10-17", "2026-10-18", now), { start: Date.parse("2026-10-16T16:00:00Z"), end: Date.parse("2026-10-18T16:00:00Z") });
  assert.equal(historyRange("2026-10-19", "2026-10-19", now).end, now);
  assert.throws(() => historyRange("2026-02-30", "2026-10-19", now));
  assert.throws(() => historyRange("2026-10-20", "2026-10-21", now));
});

test("WeChat article identity ignores volatile sharing parameters", () => {
  assert.equal(sourceArticleKey("https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=2&sn=a&scene=1"), sourceArticleKey("https://mp.weixin.qq.com/s?scene=2&idx=2&mid=123&__biz=abc&sn=b"));
  assert.notEqual(sourceArticleKey("https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1"), sourceArticleKey("https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=2"));
});

test("sanitizer removes scripts, handlers, external images, and dangerous styles", () => {
  const body = sanitizeBody('<script>alert(1)</script><p onclick="evil()" style="background:url(https://evil.test/a)">body</p><img src="https://wximg.example/a"><img src="https://tracking.example/a"><a href="javascript:evil()">link</a>', new Map([["https://wximg.example/a", "/media/123/image"]]));
  assert.match(body, /src="\/media\/123\/image"/);
  assert.doesNotMatch(body, /script|onclick|tracking|javascript|background:/);
});

test("public URL parser rejects internal names, IP literals, credentials, and uncommon ports", () => {
  for (const value of ["http://localhost/", "http://127.0.0.1", "http://2130706433", "http://[::1]", "https://a.internal/", "https://user:pass@example.com", "http://example.com:8123"]) assert.throws(() => publicUrl(value));
});

test("admin cookies are signed, expire, and are invalid after a password change", async () => {
  const now = Date.now();
  const value = await createAdminSession("a-test-password", now);
  const request = new Request("https://example.com/api/admin/status", { headers: { cookie: `maobidao_admin=${value}` } });
  assert.equal(await isAdmin(request, { SUBMIT_PASSWORD: "a-test-password" }, now + 100), true);
  assert.equal(await isAdmin(request, { SUBMIT_PASSWORD: "changed" }, now + 100), false);
  assert.equal(await isAdmin(request, { SUBMIT_PASSWORD: "a-test-password" }, now + 8 * 3_600_000), false);
});

test("JSON size is checked even without Content-Length", async () => {
  const request = new Request("https://example.com", { method: "POST", body: JSON.stringify({ value: "x".repeat(1024) }) });
  await assert.rejects(() => readJson(request, 100), { code: "TOO_LARGE" });
});
