import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { escapeHtml, renderArticle, renderHome, renderNotFound } from "../src/archive/pages.js";

const id = "a7ab296552e7da020642e4150c0b2a4e";
const article = { id, title: "测试文章", author: "作者甲", source_name: "测试公众号", published_at: Date.parse("2026-10-19T21:35:00+08:00"), original_url: "https://mp.weixin.qq.com/s/example" };

test("page metadata escapes text and script boundaries", () => {
  const payload = '</script><img src=x onerror="alert(1)">';
  const html = renderArticle({ ...article, title: payload, author: payload }, "<p>正文</p>");
  assert.ok(html.includes("&lt;/script&gt;&lt;img"));
  assert.ok(!html.includes(payload));
  assert.ok(html.includes("\\u003c/script\\u003e"));
  const json = html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)[1];
  assert.equal(JSON.parse(json).headline, payload);
});

test("source links reject executable and credential-bearing addresses", () => {
  for (const original_url of ["javascript:alert(1)", "data:text/html,test", "https://name:secret@example.com/article"]) {
    const html = renderArticle({ ...article, original_url }, "<p>正文</p>");
    assert.ok(!html.includes('href="javascript:'));
    assert.ok(!html.includes('href="data:'));
    assert.ok(!html.includes("name:secret"));
    assert.ok(!html.includes("查看原文链接"));
  }
});

test("article preserves source, body, and the existing read-counter request", () => {
  const html = renderArticle(article, '<p>正文<img src="/media/image.png" alt="配图"></p>');
  assert.ok(html.includes('href="https://mp.weixin.qq.com/s/example"'));
  assert.ok(html.includes('<img src="/media/image.png"'));
  assert.ok(html.includes('"article_id":"' + id + '"'));
  assert.ok(html.includes('"page":"article"'));
  assert.ok(html.includes('fetch("/api/stats"'));
  assert.ok(html.includes("2026-10-19 21:35:00"));
  assert.ok(html.includes("北京时间"));
});

test("invalid article ids cannot enter the statistics script", () => {
  const html = renderArticle({ ...article, id: '"></script><script>alert(1)</script>' }, "正文");
  assert.ok(!html.includes('fetch("/api/stats"'));
  assert.ok(!html.includes("alert(1)"));
});

test("homepage merges legacy articles once and preserves old article paths", () => {
  const other = { id: "22aaa2d4779c7a7a3c2c3aa4814a206e", title: "旧文章", account_name: "旧作者", publish_time: "2026-06-11 14:23:16", success: true };
  const html = renderHome([article], { legacyArticles: [{ ...article, title: "同一文章旧标题" }, other, { ...other, id: "9930aac267fd39379cb2c78d14998634", success: false }] });
  assert.ok(html.includes("已收录 2 篇文章"));
  assert.ok(html.includes(`/articles/${other.id}`));
  assert.ok(!html.includes("同一文章旧标题"));
  assert.ok(!html.includes("/articles/9930aac267fd39379cb2c78d14998634"));
  assert.ok(html.indexOf("测试文章") < html.indexOf("旧文章"));
});

test("homepage does not expose unpublished records or unsafe IDs", () => {
  const html = renderHome([{ ...article, status: "capturing" }, { ...article, id: 'bad" onclick="alert(1)' }]);
  assert.ok(html.includes("暂无文章。"));
  assert.ok(!html.includes("测试文章"));
  assert.ok(!html.includes("onclick"));
});

test("homepage escapes source summaries and retains site statistics", () => {
  const html = renderHome([{ ...article, summary: "<svg onload=alert(1)>" }]);
  assert.ok(html.includes("&lt;svg onload=alert(1)&gt;"));
  assert.ok(!html.includes("<svg"));
  assert.ok(html.includes('"page":"site"'));
  assert.ok(html.includes('id="site-pv"'));
  assert.ok(html.includes('id="site-uv"'));
  assert.ok(html.includes('href="/admin"'));
});

test("homepage pagination exposes the next page without pretending its page count is the total", () => {
  const first = renderHome([article], { page: 0, hasMore: true });
  assert.ok(first.includes('href="/?page=1"'));
  assert.ok(first.includes("本页显示 1 篇文章"));
  assert.ok(!first.includes("上一页"));
  const next = renderHome([article], { page: 1, hasMore: false });
  assert.ok(next.includes('href="/">上一页'));
  assert.ok(next.includes("第 2 页"));
  assert.ok(!next.includes("下一页"));
  const malformed = renderHome([article], { page: '"><script>alert(1)</script>', hasMore: true });
  assert.ok(malformed.includes('href="/?page=1"'));
  assert.ok(!malformed.includes("alert(1)"));
});

test("dates handle seconds, milliseconds, invalid values and legacy display", () => {
  assert.ok(renderArticle({ ...article, published_at: article.published_at / 1000 }, "").includes("2026-10-19 21:35:00"));
  assert.ok(renderArticle({ ...article, published_at: "2026-06-12 14:21:25" }, "").includes("2026-06-12 14:21:25"));
  const html = renderArticle({ ...article, published_at: "not-a-date" }, "");
  assert.ok(!html.includes("Invalid Date"));
  assert.ok(!html.includes("not-a-date"));
  const legacy = { ...article, published_at: null, publish_time: "2026-06-12 14:21:25" };
  assert.ok(renderHome([legacy]).includes("2026-06-12 22:21:25"));
  assert.ok(renderArticle({ ...article, first_published_at: article.published_at, published_at: Date.now() }, "").includes("2026-10-19 21:35:00"));
});

test("not-found page has a usable home link", () => {
  assert.ok(renderNotFound().includes('href="/"'));
  assert.ok(renderNotFound().includes("文章未找到"));
  assert.equal(escapeHtml('&<>"\''), "&amp;&lt;&gt;&quot;&#39;");
});

async function adminHarness({ loggedIn = true, configured = true, failHistoryOnce = false, jobs = [], scheduler = null, detailPages = null, sourceNotice = null, fetchOverride = null } = {}) {
  class Node {
    constructor() { this.children = []; this.events = {}; this.value = ""; this.hidden = false; this.disabled = false; this.textContent = ""; }
    addEventListener(name, callback) { this.events[name] = callback; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = [...children]; }
    removeAttribute(name) { delete this[name]; }
    querySelector() { this.button ||= new Node(); return this.button; }
    get firstChild() { return this.children[0]; }
    get childElementCount() { return this.children.length; }
    set innerHTML(_value) { throw new Error("Untrusted HTML insertion is forbidden"); }
  }
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const document = { hidden: false, events: {}, getElementById: get, createElement: () => new Node(), addEventListener(name, callback) { this.events[name] = callback; } };
  const timers = new Map();
  const requests = [];
  let timerId = 0;
  const status = { configured, login: { status: "saved" }, sources: [{ id: "source-1", name: "测试公众号", enabled: true }], jobs, scheduler };
  const fetch = async (path, options = {}) => {
    requests.push({ path, ...options });
    const override = await fetchOverride?.(path, options);
    if (override !== undefined) return override;
    if (path === "/api/admin/jobs" && failHistoryOnce) { failHistoryOnce = false; throw new Error("Network interrupted"); }
    if (path === "/api/admin/login") loggedIn = true;
    const authorized = path === "/api/admin/login" || loggedIn;
    const detailUrl = new URL(path, "https://archive.example");
    const detail = detailUrl.pathname.match(/^\/api\/admin\/jobs\/([^/]+)$/);
    const data = path === "/api/admin/status" ? status
      : path.startsWith("/api/admin/sources/search?") ? { sources: sourceNotice ? [{ name: "新增公众号", fakeid: "new-source" }] : [] }
      : path === "/api/admin/sources" && options.method === "POST" ? { success: true, notice: sourceNotice }
      : detail && !options.method ? { job: jobs.find((job) => job.id === detail[1]), items: [], ...detailPages?.[detailUrl.searchParams.get("offset") || "0"] }
      : { success: true };
    return { ok: authorized, status: authorized ? 200 : 401, json: async () => authorized ? data : { error: "请先登录" } };
  };
  const window = { events: {}, addEventListener(name, callback) { this.events[name] = callback; }, confirm: () => true };
  const context = vm.createContext({ document, window, location: { origin: "https://archive.example" }, fetch, URL, Intl, Date, crypto: globalThis.crypto,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    get localStorage() { throw new Error("Passwords must not be stored in localStorage"); },
  });
  vm.runInContext(await readFile(new URL("../public/assets/admin.js", import.meta.url), "utf8"), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  const submit = async (id) => {
    const node = get(id);
    await node.events.submit({ preventDefault() {}, submitter: node.querySelector("button"), currentTarget: node });
    await settle();
  };
  return { get, document, requests, timers, submit, settle };
}

test("admin login clears the password and uses the cookie for later reads", async () => {
  const admin = await adminHarness({ loggedIn: false });
  admin.get("password").value = "test-password";
  await admin.submit("login-form");
  assert.equal(admin.get("password").value, "");
  assert.equal(admin.get("admin-content").hidden, false);
  const login = admin.requests.find((request) => request.path === "/api/admin/login");
  assert.deepEqual(JSON.parse(login.body), { password: "test-password" });
  assert.equal(admin.requests.at(-1).method, undefined);
  assert.equal(admin.requests.at(-1).credentials, "same-origin");
});

test("admin background polling only reads and stops while the page is hidden", async () => {
  const admin = await adminHarness();
  assert.equal(admin.timers.size, 1);
  const [id, tick] = [...admin.timers.entries()][0];
  assert.equal(tick.delay, 5000);
  admin.timers.delete(id);
  await tick.callback();
  assert.ok(admin.requests.every((request) => !request.method || request.method === "GET"));
  const before = admin.requests.length;
  admin.document.hidden = true;
  await admin.document.events.visibilitychange();
  assert.equal(admin.timers.size, 0);
  assert.equal(admin.requests.length, before);
  admin.document.hidden = false;
  await admin.document.events.visibilitychange();
  assert.ok(admin.requests.length > before);
  assert.equal(admin.timers.size, 1);
});

test("admin history rejects impossible and reversed dates before creating a task", async () => {
  const admin = await adminHarness();
  admin.get("history-source").value = "source-1";
  admin.get("start-date").value = "2026-02-30";
  admin.get("end-date").value = "2026-03-01";
  await admin.submit("history-form");
  assert.equal(admin.get("history-message").textContent, "请选择有效的开始日期。");
  admin.get("start-date").value = "2026-02-03";
  admin.get("end-date").value = "2026-02-01";
  await admin.submit("history-form");
  assert.equal(admin.get("history-message").textContent, "结束日期不能早于开始日期。");
  assert.ok(!admin.requests.some((request) => request.path === "/api/admin/jobs"));
});

test("admin retries an ambiguous history submission with the same idempotency key", async () => {
  const admin = await adminHarness({ failHistoryOnce: true });
  admin.get("history-source").value = "source-1";
  admin.get("start-date").value = "2026-02-01";
  admin.get("end-date").value = "2026-02-03";
  await admin.submit("history-form");
  await admin.submit("history-form");
  const writes = admin.requests.filter((request) => request.path === "/api/admin/jobs");
  assert.equal(writes.length, 2);
  assert.match(writes[0].headers["Idempotency-Key"], /^[a-f0-9-]{36}$/);
  assert.equal(writes[0].headers["Idempotency-Key"], writes[1].headers["Idempotency-Key"]);
});

test("admin disables new tasks until configured and describes saved login honestly", async () => {
  const disabled = await adminHarness({ configured: false });
  assert.equal(disabled.get("history-form").querySelector("button").disabled, true);
  assert.equal(disabled.get("links-form").querySelector("button").disabled, true);
  assert.equal(disabled.get("wechat-login-button").disabled, true);
  assert.equal(disabled.get("scheduler-start-button").disabled, true);
  const ready = await adminHarness();
  assert.ok(ready.get("service-status").textContent.includes("已保存登录状态，采集时验证"));
});

function nodeText(node) {
  return `${node.textContent || ""}${node.children.map(nodeText).join("")}`;
}

function findNode(node, text) {
  if (node.textContent === text) return node;
  for (const child of node.children) {
    const result = findNode(child, text);
    if (result) return result;
  }
  return null;
}

test("admin quota waiting retains its retry time in both task list and details", async () => {
  const job = { id: "quota-job", kind: "history", status: "waiting_quota", next_retry_at: Date.parse("2026-10-20T00:00:00Z") };
  const admin = await adminHarness({ jobs: [job] });
  const list = nodeText(admin.get("jobs-list"));
  assert.ok(list.includes("等待额度恢复"));
  assert.ok(list.includes("最早重试："));
  assert.ok(list.includes("08:00（北京时间）"));
  assert.ok(!list.includes("重试失败项"));
  const details = findNode(admin.get("jobs-list"), "查看详情");
  await details.events.click();
  assert.ok(nodeText(admin.get("job-detail")).includes("08:00（北京时间）"));
  assert.ok(admin.requests.every((request) => !request.method || request.method === "GET"));
});

test("admin shows scheduler health without automatically starting it", async () => {
  const admin = await adminHarness({ scheduler: { instance_id: "scheduler-test", last_success_at: Date.now() } });
  assert.ok(admin.get("scheduler-status").textContent.includes("最近成功检查："));
  assert.ok(!admin.requests.some((request) => request.path === "/api/admin/scheduler/start"));
  const button = admin.get("scheduler-start-button");
  await button.events.click({ currentTarget: button });
  assert.equal(admin.requests.filter((request) => request.path === "/api/admin/scheduler/start" && request.method === "POST").length, 1);
  assert.ok(admin.get("page-message").textContent.includes("定时检查已安排"));
});

test("admin history details navigate all item pages and retain the page on refresh", async () => {
  const job = { id: "history-job", kind: "history", status: "running" };
  const admin = await adminHarness({ jobs: [job], detailPages: {
    0: { items: [{ title: "第一页文章", status: "completed" }], next_offset: 100 },
    100: { items: [{ title: "第二页文章", status: "failed" }], next_offset: null },
  } });
  await findNode(admin.get("jobs-list"), "查看详情").events.click();
  await findNode(admin.get("job-detail"), "下一页文章").events.click();
  assert.ok(nodeText(admin.get("job-detail")).includes("第二页文章"));
  assert.equal(findNode(admin.get("job-detail"), "下一页文章"), null);
  const [timerId, tick] = [...admin.timers.entries()][0];
  admin.timers.delete(timerId);
  await tick.callback();
  assert.ok(nodeText(admin.get("job-detail")).includes("第二页文章"));
  await findNode(admin.get("job-detail"), "上一页文章").events.click();
  assert.ok(nodeText(admin.get("job-detail")).includes("第一页文章"));
  assert.ok(admin.requests.some((request) => request.path === "/api/admin/jobs/history-job?offset=100"));
  assert.ok(admin.requests.every((request) => !request.method || request.method === "GET"));
});

test("admin explains why an added source remains disabled for automatic monitoring", async () => {
  const notice = "公众号已添加，自动获取保持停用。今晚已选定文章，当前公众号仍可获取历史文章。";
  const admin = await adminHarness({ sourceNotice: notice });
  admin.get("source-query").value = "新增公众号";
  await admin.submit("source-search-form");
  await findNode(admin.get("source-results"), "添加公众号").events.click();
  assert.equal(admin.get("source-message").textContent, notice);
  assert.equal(admin.requests.filter((request) => request.path === "/api/admin/sources" && request.method === "POST").length, 1);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const apiResponse = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const loginSession = (id) => ({ session_id: id, status: "waiting", purpose: "account",
  screenshot_url: `/api/admin/wechat/login/${id}/screenshot` });
async function openWechat(admin) {
  const button = admin.get("wechat-login-button");
  return button.events.click({ currentTarget: button });
}

for (const lateResult of ["stale", "server-error", "network-error"]) {
  test(`a late ${lateResult} response for login A cannot change the newer login B`, async () => {
    const oldPoll = deferred();
    let created = 0;
    const admin = await adminHarness({ fetchOverride: (path, options) => {
      if (path === "/api/admin/wechat/login" && options.method === "POST") return apiResponse(loginSession(++created === 1 ? "A" : "B"));
      if (path === "/api/admin/wechat/login/A") return oldPoll.promise;
    } });
    await openWechat(admin);
    const refreshing = admin.get("refresh-button").events.click();
    await admin.settle();
    assert.ok(admin.requests.some((request) => request.path === "/api/admin/wechat/login/A"));
    await openWechat(admin);
    const before = admin.get("wechat-message").textContent;
    if (lateResult === "network-error") oldPoll.reject(new Error("Old request disconnected"));
    else oldPoll.resolve(lateResult === "stale"
      ? apiResponse({ status: "stale", expires_at: 1, screenshot_url: "/api/admin/wechat/login/A/screenshot" }) : apiResponse({ error: "Old request failed" }, 500));
    await refreshing;
    assert.equal(admin.get("wechat-message").textContent, before);
    assert.equal(admin.get("wechat-screenshot").hidden, false);
    assert.match(admin.get("wechat-screenshot").src, /\/B\/screenshot\?/);
    assert.equal(admin.get("page-message").textContent, "");
  });
}

test("a late successful confirmation of login A cannot confirm a newly opened login B", async () => {
  const oldFinish = deferred();
  let created = 0;
  const admin = await adminHarness({ fetchOverride: (path, options) => {
    if (path === "/api/admin/wechat/login" && options.method === "POST") return apiResponse(loginSession(++created === 1 ? "A" : "B"));
    if (path === "/api/admin/wechat/login/A/finish") return oldFinish.promise;
  } });
  await openWechat(admin);
  const button = admin.get("wechat-finish-button");
  const finishing = button.events.click({ currentTarget: button });
  await admin.settle();
  await openWechat(admin);
  oldFinish.resolve(apiResponse({ authenticated: true, version: 1, purpose: "account" }));
  await finishing;
  assert.ok(admin.get("wechat-message").textContent.includes("请打开登录页面"));
  assert.match(admin.get("wechat-screenshot").src, /\/B\/screenshot\?/);
  assert.equal(admin.get("wechat-finish-button").hidden, false);
});

for (const lateStatus of ["waiting", "expired"]) {
  test(`a poll started before successful confirmation cannot apply its late ${lateStatus} response`, async () => {
    const oldPoll = deferred();
    const admin = await adminHarness({ fetchOverride: (path, options) => {
      if (path === "/api/admin/wechat/login" && options.method === "POST") return apiResponse(loginSession("A"));
      if (path === "/api/admin/wechat/login/A") return oldPoll.promise;
      if (path === "/api/admin/wechat/login/A/finish") return apiResponse({ authenticated: true, version: 1, purpose: "account" });
    } });
    await openWechat(admin);
    const refreshing = admin.get("refresh-button").events.click();
    await admin.settle();
    const button = admin.get("wechat-finish-button");
    await button.events.click({ currentTarget: button });
    const message = admin.get("wechat-message");
    assert.equal(message.textContent, "微信已登录，可以继续获取文章。");
    // The completed view must not be rendered again by an obsolete request.
    let lateWrites = 0;
    let text = message.textContent;
    Object.defineProperty(message, "textContent", {
      get: () => text, set: (value) => { lateWrites++; text = value; }, configurable: true,
    });
    oldPoll.resolve(apiResponse({ status: lateStatus, expires_at: 1, screenshot_url: "/api/admin/wechat/login/A/screenshot" }));
    await refreshing;
    assert.equal(message.textContent, "微信已登录，可以继续获取文章。");
    assert.equal(lateWrites, 0);
    assert.equal(admin.get("wechat-finish-button").hidden, true);
    assert.equal(admin.get("wechat-screenshot").hidden, true);
  });
}

test("the latest login creation wins even when an earlier creation responds last", async () => {
  const oldStart = deferred();
  const job = { id: "verify-job", kind: "manual", status: "waiting_auth" };
  const admin = await adminHarness({ jobs: [job], detailPages: {
    0: { items: [{ title: "待验证文章", status: "pending", url: "https://mp.weixin.qq.com/s/article" }] },
  }, fetchOverride: (path, options) => {
    if (path === "/api/admin/wechat/login" && options.method === "POST") {
      return JSON.parse(options.body).url ? apiResponse({ ...loginSession("B"), purpose: "article" }) : oldStart.promise;
    }
  } });
  await findNode(admin.get("jobs-list"), "查看详情").events.click();
  const first = openWechat(admin);
  await admin.settle();
  await findNode(admin.get("job-detail"), "处理文章验证").events.click();
  oldStart.resolve(apiResponse(loginSession("A")));
  await first;
  assert.ok(admin.get("wechat-message").textContent.includes("完成微信要求的验证"));
  assert.match(admin.get("wechat-screenshot").src, /\/B\/screenshot\?/);
});
