import { ArchiveStore } from "./store.js";
import { ArchiveError, adminCookie, beijingDate, checkOrigin, createAdminSession, equalSecret, historyRange, isAdmin, json, publicUrl, readJson, sha256, stableId } from "./core.js";
import { dispatchJob, dispatchPending, signalWaitingJobs } from "./dispatch.js";
import { ensureScheduler } from "./scheduler.js";
import { isRssSource } from "./rss-schedule.js";
import { RSS_ACCOUNT_BIZ, RSS_FEED_URL, RSS_STATE_KEY } from "./rss-source.js";

async function rssCoverage(env) {
  try {
    const object = await env.ARCHIVE_BUCKET?.get(RSS_STATE_KEY);
    if (!object || object.size > 128 * 1024) return {};
    const state = JSON.parse(await object.text());
    if (state.kind !== 'wechat-rss-source-state' || state.feed_url !== RSS_FEED_URL
        || state.account_biz !== RSS_ACCOUNT_BIZ || !Number.isSafeInteger(state.coverage_start)
        || !Number.isSafeInteger(state.coverage_end) || state.coverage_start > state.coverage_end) return {};
    return { rss_feed_url: RSS_FEED_URL, coverage_start: state.coverage_start,
      coverage_end: state.coverage_end, last_checked_at: state.fetched_at };
  } catch { return {}; }
}

export function missingBindings(env) {
  return ["ARCHIVE_DB", "ARCHIVE_BUCKET", "ARCHIVE_BROWSER", "ARCHIVE_WORKFLOW", "ARCHIVE_EXECUTOR", "ARCHIVE_SCHEDULER", "ARCHIVE_SESSION_KEY", "SUBMIT_PASSWORD"].filter((name) => !env[name]);
}

async function collect(env, name, ...args) {
  const response = await env.ARCHIVE_EXECUTOR.getByName("wechat-account").collectorOperation(name, args);
  if (!response.ok) {
    const error = new Error(response.error.message);
    const { code, retryable, retry_at, status } = response.error;
    Object.assign(error, { code, retryable, retry_at, status, name: "CollectorError" });
    throw error;
  }
  const value = response.value;
  return value?.kind === "screenshot" ? new Response(value.bytes, { status: value.status, headers: value.headers }) : value;
}

function requireConfigured(env) {
  const missing = missingBindings(env);
  if (missing.length) throw new ArchiveError("NOT_CONFIGURED", `采集服务尚未配置完成：${missing.join("、")}`, 503);
}

async function requireAdmin(request, env) {
  if (!await isAdmin(request, env)) throw new ArchiveError("UNAUTHENTICATED", "请先登录管理页。", 401);
}

function requireMethod(request, method) {
  if (request.method !== method) throw new ArchiveError("METHOD_NOT_ALLOWED", "不支持此操作。", 405);
}

async function sourceEnableIssue(store, sourceId) {
  const selected = await store.first(`SELECT source_id FROM archive_daily_runs
    WHERE monitor_date=? AND source_id!=? AND selected_article_key IS NOT NULL LIMIT 1`, [beijingDate(), sourceId]);
  if (selected) return { code: "DAILY_ARTICLE_RESERVED", message: "今晚已为其他公众号选定文章，每晚只自动获取一篇，请在下一天更换自动获取来源。当前公众号仍可获取历史文章。" };
  const pending = await store.first(`SELECT job.id FROM archive_jobs job
    WHERE job.kind='auto' AND job.source_id!=? AND job.article_key IS NOT NULL
      AND job.status NOT IN ('cancelled','completed')
      AND NOT EXISTS(SELECT 1 FROM archive_articles article WHERE article.captured_at IS NOT NULL
        AND (article.source_key=job.article_key OR article.id=(
          SELECT article_id FROM archive_article_aliases WHERE alias_key=job.article_key))) LIMIT 1`, [sourceId]);
  if (pending) return { code: "AUTOMATIC_ARTICLE_PENDING", message: "其他公众号还有尚未完整获取的自动文章，请先完成或终止该任务，再更换自动获取来源。当前公众号仍可获取历史文章。" };
  return null;
}

async function countsFor(store, job) {
  const counts = await store.db.prepare(`SELECT COUNT(*) AS matched,
    SUM(CASE WHEN article.captured_at IS NOT NULL THEN 1 ELSE 0 END) AS captured,
    SUM(CASE WHEN article.status='published' THEN 1 ELSE 0 END) AS published,
    SUM(CASE WHEN item.status='failed' THEN 1 ELSE 0 END) AS failed
    FROM archive_job_items item JOIN archive_articles article ON article.id=item.article_id WHERE item.job_id=?`).bind(job.id).first();
  return {
    scanned_pages: Number(job.progress?.scanned_pages || 0),
    matched: counts.matched || 0, captured: counts.captured || 0,
    published: counts.published || 0, failed: counts.failed || 0,
  };
}

async function loginAttempt(request, env) {
  if (!env.ARCHIVE_DB) throw new ArchiveError("NOT_CONFIGURED", "管理员存储尚未配置。", 503);
  const key = await sha256(`admin-login:${request.headers.get("cf-connecting-ip") || "local"}`);
  const now = Date.now();
  const row = await env.ARCHIVE_DB.prepare(`INSERT INTO archive_admin_attempts(address_hash,attempts,reset_at)
    VALUES (?,1,?) ON CONFLICT(address_hash) DO UPDATE SET
      attempts=CASE WHEN reset_at<=? THEN 1 ELSE attempts+1 END,
      reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END
    RETURNING attempts,reset_at`).bind(key, now + 15 * 60_000, now, now).first();
  if (row.attempts > 10) throw new ArchiveError("RATE_LIMITED", "登录尝试次数过多，请稍后再试。", 429);
  return key;
}

export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/")) return null;
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) checkOrigin(request);

  if (url.pathname === "/api/admin/login") {
    requireMethod(request, "POST");
    const address = await loginAttempt(request, env);
    const data = await readJson(request, 4096);
    if (!env.SUBMIT_PASSWORD || typeof data.password !== "string" || !await equalSecret(data.password, env.SUBMIT_PASSWORD)) {
      throw new ArchiveError("INVALID_PASSWORD", "管理密码错误。", 401);
    }
    await env.ARCHIVE_DB.prepare("DELETE FROM archive_admin_attempts WHERE address_hash=?").bind(address).run();
    const value = await createAdminSession(env.SUBMIT_PASSWORD);
    return json({ success: true }, 200, { "set-cookie": adminCookie(request, value) });
  }

  await requireAdmin(request, env);
  const store = env.ARCHIVE_DB ? new ArchiveStore(env.ARCHIVE_DB) : null;

  if (url.pathname === "/api/admin/logout") {
    requireMethod(request, "POST");
    return json({ success: true }, 200, { "set-cookie": adminCookie(request, "", 0) });
  }

  if (url.pathname === "/api/admin/status") {
    requireMethod(request, "GET");
    const rows = store ? await store.listSources() : [];
    const coverage = rows.some(isRssSource) ? await rssCoverage(env) : {};
    const sources = rows.map(source => ({ ...source, provider: isRssSource(source) ? 'rss' : 'wechat',
      ...(isRssSource(source) ? coverage : {}) }));
    const jobs = store ? await store.listJobs(30) : [];
    const latestLogin = store ? await env.ARCHIVE_DB.prepare("SELECT id,status,purpose,expires_at FROM archive_login ORDER BY created_at DESC LIMIT 1").first() : null;
    const session = store ? await env.ARCHIVE_DB.prepare("SELECT version,object_key FROM archive_session WHERE singleton=1").first() : null;
    const waiting = jobs.some((job) => job.status === "waiting_auth");
    const login = {
      status: waiting ? "expired" : session?.object_key ? "saved" : latestLogin?.status || "required",
      expires_at: latestLogin?.expires_at || null,
    };
    const byId = new Map(sources.map((source) => [source.id, source.name]));
    const scheduler = store ? await env.ARCHIVE_DB.prepare("SELECT instance_id,last_tick_at,last_success_at,last_error FROM archive_scheduler WHERE singleton=1").first() : null;
    const enriched = [];
    for (const job of jobs) enriched.push({ ...job, source_name: byId.get(job.source_id) || "", counts: await countsFor(store, job) });
    return json({ configured: !missingBindings(env).length, enabled: env.ARCHIVE_AUTO_ENABLED === "true", cloud_enabled: env.ARCHIVE_ENABLED === "true", missing: missingBindings(env), login, sources, jobs: enriched, scheduler });
  }

  requireConfigured(env);

  if (url.pathname === "/api/admin/scheduler/start") {
    requireMethod(request, "POST");
    return json({ scheduler: await ensureScheduler(env) });
  }

  if (url.pathname === "/api/admin/sources/search") {
    requireMethod(request, "GET");
    const query = (url.searchParams.get("q") || "").trim();
    if (!query || query.length > 100) throw new ArchiveError("INVALID_QUERY", "请输入100字以内的公众号名称。");
    const lease = await store.acquireLease("wechat-account", `search:${crypto.randomUUID()}`, 180_000);
    if (!lease) throw new ArchiveError("BUSY", "正在处理采集或登录，请稍后再搜索。", 409);
    try { return json({ sources: await collect(env, "searchSources", query) }); }
    finally { await store.releaseLease(lease); }
  }

  if (url.pathname === "/api/admin/sources") {
    requireMethod(request, "POST");
    const data = await readJson(request);
    if (typeof data.name !== "string" || !data.name.trim() || data.name.length > 100 || typeof data.fakeid !== "string" || !/^[\w=+/-]{1,200}$/.test(data.fakeid)) {
      throw new ArchiveError("INVALID_SOURCE", "请从搜索结果中选择公众号。");
    }
    const lease = await store.acquireLease("source-config", crypto.randomUUID(), 30_000);
    if (!lease) throw new ArchiveError("BUSY", "来源配置正在更新，请稍后再试。", 409);
    let source;
    let notice;
    try {
      const before = await store.listSources();
      source = await store.initSource({ name: data.name.trim(), fakeid: data.fakeid, account_biz: typeof data.account_biz === "string" ? data.account_biz.slice(0, 200) : null });
      const issue = await sourceEnableIssue(store, source.id);
      if (issue || before.some((item) => item.enabled && item.id !== source.id)) {
        source = await store.updateSource(source.id, { enabled: false });
        notice = issue ? `公众号已添加，自动获取保持停用。${issue.message}` : "公众号已添加，自动获取保持停用。同一时间只能自动获取一个公众号，当前公众号仍可获取历史文章。";
      }
    } finally { await store.releaseLease(lease); }
    let job = null;
    if (!source.baseline_completed_at) {
      job = await store.createJob({ kind: "baseline", source_id: source.id }, `baseline:${source.id}`);
      await dispatchJob(env, job);
    }
    return json({ source, job, ...(notice ? { notice } : {}) }, 201);
  }

  const sourceMatch = url.pathname.match(/^\/api\/admin\/sources\/([\w-]+)$/);
  if (sourceMatch) {
    requireMethod(request, "PATCH");
    const data = await readJson(request, 4096);
    if (typeof data.enabled !== "boolean") throw new ArchiveError("INVALID_SOURCE", "请选择启用或停用。");
    const source = await store.getSource(sourceMatch[1]);
    if (!source) throw new ArchiveError("NOT_FOUND", "公众号不存在。", 404);
    const lease = await store.acquireLease("source-config", crypto.randomUUID(), 30_000);
    if (!lease) throw new ArchiveError("BUSY", "来源配置正在更新，请稍后再试。", 409);
    try {
      if (data.enabled && (await store.listSources()).some((item) => item.id !== source.id && item.enabled)) {
        throw new ArchiveError("SOURCE_LIMIT", "当前只允许自动监控一个公众号，请先停用其他来源。", 409);
      }
      if (data.enabled) {
        const issue = await sourceEnableIssue(store, source.id);
        if (issue) throw new ArchiveError(issue.code, issue.message, 409);
      }
      return json({ source: await store.updateSource(source.id, { enabled: data.enabled }) });
    } finally { await store.releaseLease(lease); }
  }

  if (url.pathname === "/api/admin/jobs") {
    requireMethod(request, "POST");
    const data = await readJson(request);
    if (data.kind !== "history") throw new ArchiveError("INVALID_JOB", "请选择历史采集功能。");
    if (typeof data.source_id !== "string") throw new ArchiveError("INVALID_SOURCE", "请选择已配置的公众号。");
    const source = await store.getSource(data.source_id);
    if (!source) throw new ArchiveError("NOT_FOUND", "请选择已配置的公众号。", 404);
    const idempotency = request.headers.get("idempotency-key");
    if (idempotency && !/^[\w-]{1,100}$/.test(idempotency)) throw new ArchiveError("INVALID_KEY", "请求标识无效。");
    const previous = idempotency ? await store.getJob(await stableId(`job:history:${idempotency}`)) : null;
    const range = historyRange(data.start_date, data.end_date, previous?.range_end || Date.now());
    const job = await store.createJob({ kind: "history", source_id: source.id, range_start: range.start, range_end: range.end }, idempotency ? `history:${idempotency}` : null);
    await dispatchJob(env, job);
    return json({ job }, 202);
  }

  const jobMatch = url.pathname.match(/^\/api\/admin\/jobs\/([\w-]+)(?:\/(pause|resume|cancel|retry))?$/);
  if (jobMatch) {
    const job = await store.getJob(jobMatch[1]);
    if (!job) throw new ArchiveError("NOT_FOUND", "任务不存在。", 404);
    if (!jobMatch[2]) {
      requireMethod(request, "GET");
      const offset = Math.max(0, Math.min(1_000_000, Number(url.searchParams.get("offset")) || 0));
      const items = await store.all(`SELECT item.*,article.url,article.title,article.status AS article_status,
        article.captured_at,article.published_at FROM archive_job_items item JOIN archive_articles article ON article.id=item.article_id
        WHERE item.job_id=? ORDER BY item.created_at,item.article_id LIMIT 100 OFFSET ?`, [job.id, Math.trunc(offset)]);
      return json({ job, items, counts: await countsFor(store, job), next_offset: items.length === 100 ? offset + 100 : null });
    }
    requireMethod(request, "POST");
    const updated = await store.setJobControl(job.id, jobMatch[2]);
    if (["resume", "retry"].includes(jobMatch[2])) await dispatchJob(env, updated, { signal: true });
    return json({ job: updated });
  }

  if (url.pathname === "/api/admin/wechat/login") {
    requireMethod(request, "POST");
    const data = request.body ? await readJson(request, 4096) : {};
    const target = data.url ? publicUrl(data.url) : null;
    if (target && target.hostname !== "mp.weixin.qq.com") throw new ArchiveError("INVALID_URL", "验证入口只支持微信官方文章页面。");
    const lease = await store.acquireLease("wechat-account", `login:${crypto.randomUUID()}`, 180_000);
    if (!lease) throw new ArchiveError("BUSY", "正在完成一篇采集，请稍后打开验证入口。", 409);
    try {
      const login = await collect(env, "createLoginSession", target ? { url: target.href } : {});
      return json({ ...login, screenshot_url: `/api/admin/wechat/login/${encodeURIComponent(login.session_id)}/screenshot` });
    } finally { await store.releaseLease(lease); }
  }

  const loginMatch = url.pathname.match(/^\/api\/admin\/wechat\/login\/([\w-]+)(?:\/(finish|screenshot))?$/);
  if (loginMatch) {
    const id = loginMatch[1];
    if (loginMatch[2] === "screenshot") {
      requireMethod(request, "GET");
      return collect(env, "getLoginScreenshot", id);
    }
    if (loginMatch[2] === "finish") {
      requireMethod(request, "POST");
      const lease = await store.acquireLease("wechat-account", `login-finish:${id}`, 90_000);
      if (!lease) throw new ArchiveError("BUSY", "正在完成一篇采集，请稍后确认验证。", 409);
      let result;
      try { result = await collect(env, "finishLoginSession", id); }
      finally { await store.releaseLease(lease); }
      if (result.authenticated) await signalWaitingJobs(env, result.version);
      return json(result);
    }
    requireMethod(request, "GET");
    return json({ ...await collect(env, "getLoginSession", id), screenshot_url: `/api/admin/wechat/login/${encodeURIComponent(id)}/screenshot` });
  }

  if (url.pathname === "/api/admin/dispatch") {
    requireMethod(request, "POST");
    return json({ success: true, dispatched: await dispatchPending(env) });
  }
  throw new ArchiveError("NOT_FOUND", "接口不存在。", 404);
}

export async function handleArchiveSubmit(request, env) {
  if (request.method === "OPTIONS") return json({ success: true });
  if (request.method === "GET") return json({ success: true, message: "文章提交接口已部署。", mode: "cloud", configured: !missingBindings(env).length });
  requireMethod(request, "POST");
  checkOrigin(request);
  requireConfigured(env);
  const data = await readJson(request);
  if (!await isAdmin(request, env)) {
    const address = await loginAttempt(request, env);
    if (!env.SUBMIT_PASSWORD || !await equalSecret(data.password, env.SUBMIT_PASSWORD)) {
      throw new ArchiveError("UNAUTHENTICATED", "管理密码错误或尚未登录。", 401);
    }
    await env.ARCHIVE_DB.prepare("DELETE FROM archive_admin_attempts WHERE address_hash=?").bind(address).run();
  }
  if (!Array.isArray(data.links) || !data.links.length || data.links.length > 50) throw new ArchiveError("INVALID_LINKS", "每次可提交1至50个文章链接。");
  const urls = [...new Set(data.links.map((item) => publicUrl(item).href))];
  const store = new ArchiveStore(env.ARCHIVE_DB);
  const key = request.headers.get("idempotency-key");
  if (key && !/^[\w-]{1,100}$/.test(key)) throw new ArchiveError("INVALID_KEY", "请求标识无效。");
  const job = await store.createJob({ kind: "manual", urls }, key ? `manual:${key}` : null);
  await dispatchJob(env, job);
  return json({ success: true, job_id: job.id, job, added: urls.length, message: "采集任务已创建，可在管理页查看进度。" }, 202);
}
