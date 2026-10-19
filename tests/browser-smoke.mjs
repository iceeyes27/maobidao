import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const base = new URL(process.env.ARCHIVE_SMOKE_BASE_URL || "http://127.0.0.1:8787");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Browser smoke tests only run against a local server.");
const testPassword = "local-integration-only";
const publicOnly = process.argv.includes("--public-only");
const reuseLegacy = process.argv.includes("--reuse-legacy");
assert.ok(!reuseLegacy || !publicOnly, "Legacy reuse validation requires the local administrator session.");
const output = fileURLToPath(new URL("../.archive-import/screenshots/", import.meta.url));
await mkdir(output, { recursive: true });
const candidates = [process.env.ARCHIVE_SMOKE_CHROME,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try { await access(candidate); executablePath = candidate; break; } catch { /* Try the next existing browser. */ }
}
assert.ok(executablePath, "Provide an existing Chrome path with ARCHIVE_SMOKE_CHROME; this test never downloads browsers.");

const report = { checks: [], screenshots: [], pageErrors: [], blockedExternalRequests: 0 };
const requests = [];
const browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "zh-CN" });
await context.route("**/*", (route) => {
  if (new URL(route.request().url()).origin === base.origin) return route.continue();
  report.blockedExternalRequests += 1;
  return route.abort("blockedbyclient");
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on("pageerror", (error) => report.pageErrors.push(error.message));
page.on("request", (request) => requests.push({
  url: request.url(), method: request.method(), navigation: request.isNavigationRequest(),
  containsPassword: Boolean(request.postData()?.includes(testPassword)),
}));
const record = (check, details = {}) => { report.checks.push({ check, ...details }); console.log(JSON.stringify({ check, ...details })); };
const screenshot = async (name) => {
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(output, filename), fullPage: true });
  report.screenshots.push(filename);
};
const noOverflow = async (name) => {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport + 1, `${name}: horizontal overflow ${JSON.stringify(dimensions)}`);
  record(name, dimensions);
};

try {
  if (!publicOnly) {
  const adminResponse = await page.goto(new URL("/admin", base).href, { waitUntil: "domcontentloaded" });
  assert.equal(adminResponse.status(), 200);
  await page.getByRole("heading", { name: "管理员登录", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector("#login-form button").disabled);
  await writeFile(path.join(output, "admin-login.snapshot.txt"), await page.locator("main").ariaSnapshot(), "utf8");
  await screenshot("admin-login-desktop");
  record("管理页登录入口正常，无重定向循环");

  const password = page.getByLabel("管理密码", { exact: true });
  assert.equal(await password.count(), 1);
  await password.fill(testPassword);
  const loginButton = page.getByRole("button", { name: "登录", exact: true });
  assert.equal(await loginButton.count(), 1);
  await loginButton.click();
  await page.locator("#admin-content").waitFor({ state: "visible" });
  assert.equal(await password.inputValue(), "");
  const status = await page.locator("#service-status").textContent();
  assert.ok(status?.trim(), "The server status must be displayed after login.");
  const cookie = (await context.cookies()).find((item) => item.name === "maobidao_admin");
  assert.ok(cookie?.httpOnly);
  assert.equal(cookie.sameSite, "Strict");
  const leaked = await page.evaluate((value) => document.documentElement.outerHTML.includes(value)
    || JSON.stringify(localStorage).includes(value) || JSON.stringify(sessionStorage).includes(value), testPassword);
  assert.equal(leaked, false);
  assert.ok(requests.every((request) => !request.url.includes(testPassword)));
  assert.ok(requests.filter((request) => request.containsPassword).every((request) => new URL(request.url).pathname === "/api/admin/login"));
  record("假密码登录和状态加载正常；密码已清空，未进入页面、地址或浏览器存储", { service: status });

  const source = page.getByLabel("公众号", { exact: true });
  assert.equal(await source.count(), 1);
  assert.equal(await source.inputValue(), "");
  assert.ok((await source.locator("option").textContent()).includes("请先添加公众号"));
  const historyButton = page.getByRole("button", { name: "开始获取", exact: true });
  const beforeJobs = requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === "/api/admin/jobs").length;
  if (await historyButton.isEnabled()) {
    await historyButton.click();
    assert.equal(await source.evaluate((node) => node.validity.valueMissing), true);
  }
  const afterJobs = requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === "/api/admin/jobs").length;
  assert.equal(afterJobs, beforeJobs);
  record("未添加公众号时，历史获取被禁用或由必填校验阻止，没有建立任务");
  await screenshot("admin-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow("管理页移动宽度无横向溢出");
  await screenshot("admin-mobile");

  const viewSite = page.getByRole("link", { name: "查看网站", exact: true });
  assert.equal(await viewSite.count(), 1);
  await viewSite.click();
  } else {
    await page.goto(base.href, { waitUntil: "domcontentloaded" });
    await page.setViewportSize({ width: 390, height: 844 });
  }
  await page.getByRole("heading", { name: "公开文章归档", exact: true }).waitFor();
  const homeSnapshot = await page.locator("main").ariaSnapshot();
  await writeFile(path.join(output, "home.snapshot.txt"), homeSnapshot, "utf8");
  assert.equal(await page.locator(".article-list > .article-item").count(), 26);
  record("首页仅展示 26 篇成功旧归档");
  await noOverflow("首页移动宽度无横向溢出");
  await screenshot("home-mobile");
  await page.setViewportSize({ width: 1360, height: 900 });
  await screenshot("home-desktop");

  const articleLink = page.getByRole("link", { name: "韩国人爽翻了...", exact: true });
  assert.equal(await articleLink.count(), 1);
  const articlePath = await articleLink.getAttribute("href");
  assert.equal(articlePath, "/articles/a7ab296552e7da020642e4150c0b2a4e");
  await articleLink.click();
  await page.getByRole("heading", { name: "韩国人爽翻了...", exact: true }).waitFor();
  assert.ok((await page.locator(".article-body").textContent()).length > 200);
  const articleNavigations = requests.filter((request) => request.navigation && new URL(request.url).pathname.startsWith(articlePath));
  assert.ok(articleNavigations.length <= 2, "Legacy article navigation must not redirect in a loop.");
  await page.waitForFunction(() => [...document.querySelectorAll(".article-body img")].every((image) => image.complete && image.naturalWidth > 0));
  assert.equal(await page.getByRole("link", { name: "查看原文链接", exact: true }).count(), 1);
  const legacyOriginalUrl = await page.getByRole("link", { name: "查看原文链接", exact: true }).getAttribute("href");
  assert.equal(new URL(legacyOriginalUrl).hostname, "mp.weixin.qq.com");
  record("旧文章详情、正文图片和原文链接正常，无重定向循环", { navigationRequests: articleNavigations.length });
  await screenshot("article-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow("旧文章详情移动宽度无横向溢出");
  await screenshot("article-mobile");
  const homeLink = page.getByRole("link", { name: "返回首页", exact: true });
  assert.equal(await homeLink.count(), 1);
  await homeLink.click();
  await page.getByRole("heading", { name: "公开文章归档", exact: true }).waitFor();
  record("旧详情返回首页正常");

  if (!publicOnly) {
  const adminLink = page.getByRole("link", { name: "管理员入口", exact: true });
  assert.equal(await adminLink.count(), 1);
  await adminLink.click();
  await page.locator("#admin-content").waitFor({ state: "visible" });
  assert.equal(await page.getByLabel("管理密码", { exact: true }).inputValue(), "");
  if (reuseLegacy) {
    await page.locator("#links").fill(legacyOriginalUrl);
    const [response] = await Promise.all([
      page.waitForResponse((value) => new URL(value.url()).pathname === "/api/submit" && value.request().method() === "POST"),
      page.getByRole("button", { name: "提交文章", exact: true }).click(),
    ]);
    assert.equal(response.status(), 202);
    const submitted = await response.json();
    assert.match(submitted.job_id, /^[a-f0-9]{32}$/);
    let detail;
    for (let attempt = 0; attempt < 30; attempt++) {
      detail = await page.evaluate(async (url) => {
        const result = await fetch(url, { credentials: "same-origin", cache: "no-store" });
        if (!result.ok) throw new Error(`Task status request failed: ${result.status}`);
        return result.json();
      }, `/api/admin/jobs/${submitted.job_id}`);
      if (detail.job.status === "completed") break;
      assert.ok(!["failed", "partial_failed", "waiting_auth"].includes(detail.job.status), `Legacy reuse unexpectedly requires work: ${detail.job.status}`);
      await page.waitForTimeout(1000);
    }
    assert.equal(detail.job.status, "completed", "The real local Workflow and Durable Object must finish the existing article task.");
    assert.equal(detail.items.length, 1);
    assert.equal(detail.items[0].article_id, articlePath.split("/").at(-1));
    assert.equal(detail.items[0].status, "completed");
    assert.equal(detail.items[0].article_status, "published");
    await page.getByRole("button", { name: "刷新进度", exact: true }).click();
    await page.locator("#job-detail").getByText("已完成", { exact: true }).first().waitFor();
    assert.equal(await page.locator("#job-detail").getByRole("link", { name: "查看网站文章", exact: true }).getAttribute("href"), new URL(articlePath, base).href);
    await noOverflow("旧文复用完成后管理页移动宽度无横向溢出");
    await screenshot("admin-legacy-reused");
    await page.getByRole("link", { name: "查看网站", exact: true }).click();
    await page.getByRole("heading", { name: "公开文章归档", exact: true }).waitFor();
    assert.equal(await page.locator(".article-list > .article-item").count(), 26);
    assert.equal(await page.getByRole("link", { name: "韩国人爽翻了...", exact: true }).getAttribute("href"), articlePath);
    await page.getByRole("link", { name: "管理员入口", exact: true }).click();
    await page.locator("#admin-content").waitFor({ state: "visible" });
    record("管理员贴入已发表旧文，经真实本地 Workflow 和 Durable Object 完成；首页仍为 26 篇，旧地址不变", { job_id: submitted.job_id, article_id: detail.items[0].article_id });
  }
  const logout = page.getByRole("button", { name: "退出登录", exact: true });
  assert.equal(await logout.count(), 1);
  await logout.click();
  await page.getByRole("heading", { name: "管理员登录", exact: true }).waitFor();
  assert.ok(!(await context.cookies()).some((item) => item.name === "maobidao_admin"));
  record("返回管理页复用登录会话，退出后登录凭据清除");
  }
  assert.deepEqual(report.pageErrors, []);
  const allowedWrites = new Set(["/api/admin/login", "/api/admin/logout", "/api/stats"]);
  if (reuseLegacy) allowedWrites.add("/api/submit");
  assert.ok(requests.filter((request) => request.method === "POST").every((request) => allowedWrites.has(new URL(request.url).pathname)));
  assert.equal(requests.filter((request) => request.method === "POST" && new URL(request.url).pathname === "/api/submit").length, reuseLegacy ? 1 : 0);
  record(reuseLegacy ? "仅提交一个已有旧文的复用任务，浏览器未访问真实微信，页面无脚本错误" : "没有真实微信请求，没有建任务或发布请求，页面无脚本错误");
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  await screenshot("failure").catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, publicOnly ? "report-public.json" : reuseLegacy ? "report-reuse.json" : "report.json"), JSON.stringify(report, null, 2), "utf8");
  await context.close();
  await browser.close();
}
