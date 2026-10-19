(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { authenticated: false, configured: null, version: 0, sessionVersion: 0, sources: [], jobs: [], detailId: null, detailOffset: 0, session: null, refreshing: false, timer: null, submissions: {} };
  const labels = {
    queued: "等待开始", pending: "等待处理", pending_dispatch: "等待开始", running: "进行中", scanning: "正在查找文章",
    capturing: "正在获取文章", publishing: "正在更新网站", captured: "文章已完整保存", published: "网站已更新",
    paused: "已暂停", cancelled: "已取消", canceled: "已取消", completed: "已完成", complete: "已完成",
    failed: "失败", partial_failed: "部分失败", waiting_auth: "等待扫码登录", awaiting_login: "等待扫码登录",
    waiting_login: "等待扫码登录", waiting_retry: "等待下次继续", waiting_window: "等待下一晚继续",
    awaiting_window: "等待下一晚继续", retrying: "稍后继续处理", saved: "已保存登录状态，采集时验证",
    waiting_quota: "等待额度恢复",
    waiting: "等待处理", no_update: "未发现符合条件的新文章", succeeded: "已完成", skipped: "已收录，直接复用",
    ready: "登录正常", authenticated: "登录正常", logged_in: "登录正常", expired: "登录已过期", unknown: "尚未登录",
  };
  const kindLabels = { baseline: "准备公众号", auto: "每日自动获取", automatic: "每日自动获取", history: "历史文章", manual: "文章链接", links: "文章链接", link: "文章链接" };

  function message(id, text, ok = true) {
    const node = $(id);
    node.textContent = text || "";
    node.className = ok ? "result ok" : "result error";
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function readableError(value) {
    return String(value || "操作未完成，请稍后重试。").replace(/^[A-Z][A-Z0-9_]{1,80}:\s*/, "");
  }

  const sessionId = (session) => session?.session_id || session?.id;
  const sessionReady = (session) => session?.authenticated === true
    || ["ready", "authenticated", "logged_in", "completed"].includes(session?.status);
  const sessionScope = (id) => ({ version: state.version, sessionVersion: state.sessionVersion, id });
  const currentSession = (scope) => scope.version === state.version && scope.sessionVersion === state.sessionVersion
    && (scope.id === undefined || scope.id === sessionId(state.session));
  const relevantError = (error) => !error.sessionScope || currentSession(error.sessionScope);
  function scopedError(error, scope) {
    error.sessionScope = scope;
    return error;
  }

  function submissionKey(kind, payload) {
    const fingerprint = JSON.stringify(payload);
    if (state.submissions[kind]?.fingerprint !== fingerprint) state.submissions[kind] = { fingerprint, key: crypto.randomUUID() };
    return state.submissions[kind].key;
  }

  function safeLink(value, sameOrigin = false) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, location.origin);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
      if (sameOrigin && url.origin !== location.origin) return null;
      if (!sameOrigin && url.protocol !== "https:" && url.origin !== location.origin) return null;
      return url.href;
    } catch { return null; }
  }

  function showLogin(text = "") {
    state.version += 1;
    state.sessionVersion += 1;
    state.authenticated = false;
    state.configured = null;
    state.session = null;
    state.detailId = null;
    state.detailOffset = 0;
    state.sources = [];
    state.jobs = [];
    state.submissions = {};
    clearTimeout(state.timer);
    $("admin-content").hidden = true;
    $("logout-button").hidden = true;
    $("login-panel").hidden = false;
    $("wechat-screenshot").removeAttribute("src");
    $("wechat-live-view").removeAttribute("href");
    $("links").value = "";
    $("reader-article-url").value = "";
    $("reader-session-url").value = "";
    $("reader-results").replaceChildren();
    $("reader-session-status").textContent = "";
    $("reader-probe-status").textContent = "";
    message("reader-message", "");
    message("reader-session-message", "");
    for (const id of ["sources-list", "source-results", "jobs-list", "job-detail"]) $(id).replaceChildren();
    message("page-message", "");
    message("login-message", text, false);
  }

  async function api(path, options = {}) {
    const version = state.version;
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options,
        headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
    } catch { throw new Error("暂时无法连接，请检查网络后重试。"); }
    let data;
    try { data = await response.json(); }
    catch { throw new Error("服务暂时无法使用，请稍后重试。"); }
    if (version !== state.version) throw new Error("登录状态已变化，请重新操作。");
    if (response.status === 401 && path !== "/api/admin/login") showLogin(state.authenticated ? "登录已失效，请重新登录。" : "");
    if (!response.ok || data.success === false) {
      const reason = typeof data.error === "string" ? data.error : data.error?.message || data.message;
      const error = new Error(readableError(reason));
      error.code = data.code;
      error.retry_at = data.retry_at;
      if (error.code === "BROWSER_QUOTA_EXCEEDED" && Number.isSafeInteger(error.retry_at) && error.retry_at > Date.now()) {
        error.message = `今日浏览器运行预算已暂停使用，最早可于 ${formatDate(error.retry_at)}（北京时间）后重试。微信登录与任务进度已保留。`;
      }
      throw error;
    }
    return data;
  }

  const post = (path, body = {}, headers = {}) => api(path, { method: "POST", body: JSON.stringify(body), headers });

  async function busy(button, action) {
    if (button.disabled) return;
    button.busy = true;
    button.disabled = true;
    try { await action(); }
    finally {
      button.busy = false;
      button.disabled = button.requiresConfiguration === true && state.configured === false
        || button.requiresSource === true && !state.sources.length;
    }
  }

  function actionButton(text, action, danger = false, requiresConfiguration = true) {
    const button = element("button", text, danger ? "danger" : "secondary");
    button.type = "button";
    button.requiresConfiguration = requiresConfiguration;
    button.disabled = requiresConfiguration && state.configured === false;
    button.addEventListener("click", () => busy(button, action).catch((error) => { if (relevantError(error)) message("page-message", error.message, false); }));
    return button;
  }

  function setConfigured(configured) {
    if (state.configured === configured) return;
    state.configured = configured;
    for (const id of ["source-search-form", "history-form", "links-form", "reader-probe-form", "reader-session-form"]) {
      const button = $(id).querySelector("button[type=submit]") || $(id).querySelector("button");
      button.requiresConfiguration = true;
      button.disabled = !configured;
    }
    for (const id of ["wechat-login-button", "scheduler-start-button"]) {
      $(id).requiresConfiguration = true;
      $(id).disabled = !configured;
    }
  }

  function todayInBeijing() {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const value = (type) => parts.find((part) => part.type === type).value;
    return `${value("year")}-${value("month")}-${value("day")}`;
  }

  function dateValue(value) {
    if (!value) return null;
    let normalized = value;
    if (typeof value === "number") normalized = value < 1e12 ? value * 1000 : value;
    else if (/^\d{10,13}$/.test(String(value))) normalized = Number(value) * (String(value).length <= 10 ? 1000 : 1);
    else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)) normalized = `${value.replace(" ", "T")}Z`;
    const date = new Date(normalized);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function formatDate(value) {
    const date = dateValue(value);
    return date ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date) : "";
  }

  function calendarDate(value) {
    const date = dateValue(value);
    if (!date) return "";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    return ["year", "month", "day"].map(type => parts.find(part => part.type === type).value).join("-");
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function retryNotice(job) {
    const date = formatDate(job.next_retry_at);
    if (date) return element("p", `最早重试：${date}（北京时间）`, "help");
    if (job.status === "waiting_quota") return element("p", "额度恢复后继续当前任务。", "help");
    return null;
  }

  function renderScheduler(scheduler) {
    const last = formatDate(scheduler?.last_success_at);
    const stale = scheduler?.last_success_at && Date.now() - Number(scheduler.last_success_at) > 10 * 60_000;
    let text;
    if (!scheduler?.instance_id && !last) text = "尚无定时检查记录。";
    else if (last) text = `最近成功检查：${last}（北京时间）。`;
    else text = "定时检查已安排，等待首次执行。";
    if (scheduler?.last_error) text += ` ${readableError(scheduler.last_error)}`;
    if (stale) text += " 检查记录已超过 10 分钟未更新，请恢复定时检查。";
    $("scheduler-status").textContent = text;
  }

  const readerErrors = {
    BUSY: "另一项阅读操作正在进行，请稍后重新验证",
    READER_LOGIN_REQUIRED: "需要有效的微信阅读授权",
    READER_SESSION_EXPIRED: "微信阅读授权已过期，请重新导入",
    READER_SESSION_INVALID: "阅读授权无效，请使用含阅读状态的官方链接",
    READER_SOURCE_MISMATCH: "链接不属于指定公众号或缺少文章标识",
    CHALLENGE_REQUIRED: "微信要求安全验证，当前尚未读取成功",
    RATE_LIMITED: "微信暂时限制访问频率",
    ARTICLE_REMOVED: "原文已删除或当前不可见",
    ARTICLE_INVALID: "尚未取得完整正文",
    ARTICLE_VERIFICATION_REQUIRED: "需先读取原文，才能确认公开留言",
    COMMENT_ID_MISSING: "文章未返回可用的公开留言标识",
    COMMENT_ID_REQUIRED: "文章未返回可用的公开留言标识",
    COMMENTS_UNAVAILABLE: "尚未读取到公开留言",
    SOURCE_FORMAT_CHANGED: "微信返回格式发生变化，当前未能完整读取",
    READER_RESPONSE_INVALID: "微信未返回有效阅读数据",
    READER_TIME_INVALID: "未能确认原文发布时间",
    ARTICLE_IDENTITY_MISMATCH: "返回内容与目标文章不一致，未保存",
    UPSTREAM_ERROR: "微信访问暂时失败，请稍后重试",
  };
  const readerSucceeded = value => ["available", "succeeded", "completed", "complete", "readable", "verified", "success"].includes(value?.state);
  const readerCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  function readerStage(value, kind) {
    if (value?.code) return readerErrors[value.code] || "本次未能验证成功";
    if (["queued", "pending", "running", "checking"].includes(value?.state)) return "正在验证";
    if (kind === "discovery" && value?.state === "empty") return "列表未返回文章，实时发现能力尚未确认";
    if (readerSucceeded(value) || kind === "comments" && value?.state === "partial") {
      if (kind === "discovery") {
        const count = readerCount(value.article_count);
        return count === null ? "列表可读取，文章数量尚未确认" : count > 0 ? `已读取 ${count} 篇文章的列表` : "列表未返回文章，实时发现能力尚未确认";
      }
      if (kind === "article") return `正文可读取；${value.comment_id_present === true ? "已取得公开留言标识" : "未取得公开留言标识"}`;
      const count = readerCount(value.count);
      const replies = readerCount(value.reply_count);
      if (count === null) return "留言请求已返回，数量尚未确认";
      return `已读取 ${count} 条公开留言${replies === null ? "" : `、${replies} 条回复`}；${value.complete === true ? "本次获取完成" : "尚未确认全部获取完成"}`;
    }
    if (["blocked", "failed", "error", "unavailable", "restricted"].includes(value?.state)) return "本次未能读取，请查看授权或微信访问状态";
    if (["skipped", "not_attempted", "not_started"].includes(value?.state)) return "尚未执行";
    return "尚未验证";
  }

  function renderReader(reader) {
    const session = reader?.session;
    const expires = formatDate(session?.expires_at);
    $("reader-session-status").textContent = session?.expired === true
      ? "微信阅读授权已过期；公众号后台登录不能替代此授权。"
      : session?.configured === true ? `已保存短期阅读授权${expires ? `，程序将于 ${expires}（北京时间）停止使用` : ""}；实际可用状态以验证结果为准。`
        : "尚未配置微信阅读授权，将先尝试公开访问。";
    const probe = reader?.probe;
    const checked = formatDate(probe?.checked_at);
    $("reader-probe-status").textContent = probe?.state === "session_changed" ? "阅读授权已变化，请重新验证。"
      : ["queued", "pending", "running", "checking"].includes(probe?.state)
      ? "验证正在云端进行，可关闭页面后再查看。"
      : checked ? `最近验证：${checked}（北京时间）。` : "尚未验证。";
    $("reader-results").replaceChildren();
    for (const [kind, title] of [["discovery", "新文章列表"], ["article", "文章正文"], ["comments", "公开留言与回复"]]) {
      const row = element("li", undefined, "admin-row");
      row.append(element("strong", title), element("p", readerStage(probe?.state === "session_changed" ? null : probe?.[kind], kind), "help"));
      $("reader-results").append(row);
    }
  }

  function publicReaderUrl(value) {
    if (!value) return undefined;
    let url;
    try { url = new URL(value); } catch { throw new Error("请输入有效的微信公开文章链接，或留空验证最新文章。"); }
    if (url.origin !== "https://mp.weixin.qq.com" || url.username || url.password || url.port
        || !(url.pathname === "/s" || /^\/s\/[A-Za-z\d_-]+$/.test(url.pathname))) {
      throw new Error("请使用微信官方公开文章链接，或留空验证最新文章。");
    }
    if ([...url.searchParams.keys()].some(key => /^(?:key|uin|pass_ticket|appmsg_token|wxtoken|cookie)$/i.test(key))
        || /(?:^|[?&#])(?:key|uin|pass_ticket|appmsg_token|wxtoken|cookie)=/i.test(url.hash)) {
      $("reader-article-url").value = "";
      throw new Error("此链接含阅读授权信息，请使用下方“导入一次微信阅读授权”。");
    }
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (!["__biz", "mid", "idx", "sn"].includes(key)) url.searchParams.delete(key);
    return url.href;
  }

  async function queueReaderProbe(url) {
    await post("/api/admin/reader/probe", url ? { url } : {});
    message("reader-message", "验证已安排，结果会自动更新。关闭页面后仍会继续。");
    await refresh();
  }

  const isRss = source => source?.provider === "rss";
  const sourceEnabled = source => source.enabled === true || source.enabled === 1;
  const automaticSource = () => state.sources.find(sourceEnabled) || state.sources.find(isRss);

  function coverageRange(value) {
    const start = formatDate(value?.coverage_start);
    const end = formatDate(value?.coverage_end);
    return start && end ? `当前提供范围：${start} 至 ${end}（北京时间）。` : "当前提供范围尚未确认。";
  }

  function renderHistoryCoverage() {
    const source = state.sources.find(item => String(item.id) === $("history-source").value);
    const node = $("history-coverage");
    if (!isRss(source)) { node.textContent = ""; return; }
    const first = calendarDate(source.coverage_start);
    const last = calendarDate(source.coverage_end);
    const start = $("start-date").value;
    const end = $("end-date").value;
    const outside = first && last && ((validDate(start) && start < first) || (validDate(end) && end > last));
    node.textContent = `公开订阅源仅提供当前最近 20 篇。${coverageRange(source)}${outside
      ? "所选日期超出此范围，范围外文章无法获取；任务仅保存可获取部分。"
      : "公开源未收录的文章无法补齐，任务仅保存可获取部分。"}`;
  }

  function renderAutomaticRules() {
    const source = automaticSource();
    if (isRss(source)) {
      $("automatic-summary").textContent = "每 6 小时检查一次公开订阅源（北京时间约 2:00、8:00、14:00、20:00），自动保存原文在北京时间 21:30—23:30 发布的文章，每个原文日期一篇。正文和图片完整保存后更新网站。";
      $("automatic-baseline-help").textContent = "首次另行保存公开源当前最近 20 篇。公开源更新可能延迟 0—24 小时，因此文章可能在次日收录，无法保证当晚完成。";
    } else {
      $("automatic-summary").textContent = "每天北京时间 21:30—23:30，每 5 分钟检查一次，每晚自动获取一篇该时段发布的新文章，完整获取后更新网站。";
      $("automatic-baseline-help").textContent = "公众号后台来源首次启用时已有文章不会自动补充。遇到未完成任务，下一晚先继续该篇。";
    }
  }

  function renderSources() {
    const list = $("sources-list");
    const select = $("history-source");
    const selected = select.value;
    list.replaceChildren();
    select.replaceChildren();
    select.append(element("option", state.sources.length ? "请选择来源" : "请先添加来源"));
    select.firstChild.value = "";
    for (const source of state.sources) {
      const enabled = sourceEnabled(source);
      const row = element("li");
      const content = element("div", undefined, "admin-row");
      const copy = element("div", undefined, "item-copy");
      const name = element("strong", source.name || "未命名公众号");
      name.append(element("span", enabled ? "已启用" : "已停用", "admin-state"));
      copy.append(name);
      copy.append(element("p", isRss(source) ? "公开订阅源 · 无需微信扫码 · 更新可能延迟 0—24 小时" : "公众号后台 · 需要微信登录", "help"));
      if (isRss(source)) copy.append(element("p", `仅当前最近 20 篇，未收录的文章无法补齐。${coverageRange(source)}`, "help"));
      if (source.last_error) copy.append(element("p", readableError(source.last_error), "result error"));
      content.append(copy, actionButton(enabled ? "停用自动获取" : "启用自动获取", async () => {
        await api(`/api/admin/sources/${encodeURIComponent(source.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: !enabled }) });
        message("page-message", enabled ? "已停用该来源的自动获取。" : "已启用该来源的自动获取。");
        await refresh();
      }));
      row.append(content);
      list.append(row);
      const option = element("option", `${source.name || "未命名公众号"}${isRss(source) ? "（公开订阅源）" : ""}${enabled ? "" : "（自动获取已停用）"}`);
      option.value = source.id;
      select.append(option);
    }
    if (!state.sources.length) list.append(element("li", "尚未添加来源。", "help"));
    if (state.sources.some((source) => String(source.id) === selected)) select.value = selected;
    const historyButton = $("history-form").querySelector("button[type=submit]") || $("history-form").querySelector("button");
    historyButton.requiresSource = true;
    historyButton.disabled = historyButton.busy === true || state.configured === false || !state.sources.length;
    renderHistoryCoverage();
    renderAutomaticRules();
  }

  function limitedCoverage(job) {
    return job.progress?.coverage_limited === true || job.progress?.coverage_limited === 1;
  }

  function jobStatus(job) {
    return limitedCoverage(job) && ["completed", "complete"].includes(job.status) ? "已保存可获取部分" : labels[job.status] || "等待处理";
  }

  function coverageNotice(job) {
    return limitedCoverage(job) ? element("p", `本任务仅保存公开源可获取的部分，未收录的文章无法补齐。${coverageRange(job.progress)}`, "help") : null;
  }

  function progress(job, counts) {
    counts = { ...(job.progress || {}), ...(job.counts || {}), ...(counts || {}) };
    const number = (...values) => {
      const value = values.find((item) => item !== undefined && item !== null);
      return Number.isFinite(Number(value)) ? Number(value) : 0;
    };
    const values = [
      ["已扫描", number(counts.scanned_pages, job.scanned_pages), "页"],
      ["找到", number(counts.matched, counts.total, job.matched_count, job.discovered_count), "篇"],
      ["完整获取", number(counts.captured, counts.capture_complete, job.captured_count, job.completed_count), "篇"],
      ["网站已更新", number(counts.published, job.published_count, job.completed_count), "篇"],
      ["失败", number(counts.failed, job.failed_count), "篇"],
    ];
    const node = element("div", undefined, "job-counts");
    for (const [label, value, unit] of values) node.append(element("span", `${label} ${value} ${unit}`));
    return node;
  }

  function jobActions(job) {
    if (job.progress?.preparing === true) return ["cancel"];
    if (Array.isArray(job.allowed_actions)) return job.allowed_actions.filter((action) => ["pause", "resume", "cancel", "retry"].includes(action));
    if (["completed", "complete", "cancelled", "canceled", "no_update", "succeeded"].includes(job.status)) return [];
    if (job.status === "paused") return ["resume", "cancel"];
    if (["failed", "partial_failed"].includes(job.status)) return ["retry", "cancel"];
    if (["waiting_auth", "awaiting_login", "waiting_login", "waiting_retry", "waiting_window", "awaiting_window", "waiting_quota"].includes(job.status)) return ["cancel"];
    return ["pause", "cancel"];
  }

  async function changeJob(job, action) {
    if (action === "cancel" && !window.confirm("确定结束本次任务吗？已完成的文章会保留，尚未开始的项目将停止。")) return;
    await post(`/api/admin/jobs/${encodeURIComponent(job.id)}/${action}`);
    message("page-message", { pause: "已请求暂停任务。", resume: "任务将继续执行。", cancel: "已请求结束本次任务。", retry: "已安排重试未完成的项目。" }[action]);
    await refresh();
  }

  function renderJobs() {
    const list = $("jobs-list");
    list.replaceChildren();
    for (const job of state.jobs) {
      const item = element("li");
      const row = element("div", undefined, "admin-row");
      const copy = element("div", undefined, "item-copy");
      copy.append(element("strong", `${kindLabels[job.kind] || "文章任务"}${job.source_name ? ` · ${job.source_name}` : ""}`));
      copy.append(element("span", jobStatus(job), `admin-state${["failed", "partial_failed"].includes(job.status) ? " error" : ""}`));
      const date = formatDate(job.created_at);
      if (date) copy.append(element("p", `${date}（北京时间）`, "help"));
      if (job.start_date && job.end_date) copy.append(element("p", `${job.start_date} 至 ${job.end_date}（含结束日）`, "help"));
      copy.append(progress(job));
      const coverage = coverageNotice(job);
      if (coverage) copy.append(coverage);
      const retry = retryNotice(job);
      if (retry) copy.append(retry);
      if (job.last_error || job.error) copy.append(element("p", readableError(job.last_error || job.error), "result error"));
      const actions = element("div", undefined, "admin-actions");
      actions.append(actionButton("查看详情", async () => { if (state.detailId !== job.id) state.detailOffset = 0; state.detailId = job.id; await loadDetail(); }, false, false));
      for (const action of jobActions(job)) actions.append(actionButton({ pause: "暂停", resume: "继续", cancel: ["auto", "automatic"].includes(job.kind) ? "终止本次任务" : "取消任务", retry: "重试失败项" }[action], () => changeJob(job, action), action === "cancel"));
      row.append(copy, actions);
      item.append(row);
      list.append(item);
    }
    if (!state.jobs.length) list.append(element("li", "暂无任务。", "help"));
  }

  async function loadDetail() {
    if (!state.detailId || !state.authenticated) return;
    const id = state.detailId;
    const offset = state.detailOffset;
    const version = state.version;
    const data = await api(`/api/admin/jobs/${encodeURIComponent(id)}${offset ? `?offset=${offset}` : ""}`);
    if (version !== state.version || id !== state.detailId || offset !== state.detailOffset) return;
    const section = $("job-detail");
    const job = data.job || {};
    section.replaceChildren(element("h3", "任务详情"), element("p", jobStatus(job)), progress(job, data.counts || job.counts));
    const coverage = coverageNotice(job);
    if (coverage) section.append(coverage);
    const retry = retryNotice(job);
    if (retry) section.append(retry);
    const items = element("ol");
    for (const item of data.items || []) {
      const row = element("li");
      row.append(element("strong", item.title || "等待获取文章标题"));
      row.append(element("p", labels[item.status] || "等待处理", "help"));
      const isPublished = item.article_status === "published" || item.status === "published" || item.article_url || item.published_url;
      const target = safeLink(item.article_url || item.published_url || (isPublished && item.article_id ? `/articles/${encodeURIComponent(item.article_id)}` : ""), true);
      if (target && isPublished) {
        const link = element("a", "查看网站文章");
        link.href = target;
        row.append(link);
      }
      if (item.error || item.last_error) row.append(element("p", readableError(item.error || item.last_error), "result error"));
      const sourceUrl = safeLink(item.url || "");
      if (!isPublished && sourceUrl && new URL(sourceUrl).hostname === "mp.weixin.qq.com"
          && (job.status === "waiting_auth" || /验证/.test(String(item.error || item.last_error || "")))) {
        row.append(actionButton("处理文章验证", () => startWechatLogin({ url: sourceUrl })));
      }
      items.append(row);
    }
    if (!items.childElementCount) section.append(element("p", "发现的文章会显示在这里。", "help"));
    else section.append(items);
    const next = Number.isSafeInteger(data.next_offset) && data.next_offset > offset ? data.next_offset : null;
    if (offset || next !== null) {
      const navigation = element("div", undefined, "admin-actions");
      const turnPage = async (target) => { state.detailOffset = target; await loadDetail(); };
      if (offset) navigation.append(actionButton("上一页文章", () => turnPage(Math.max(0, offset - 100)), false, false));
      navigation.append(element("span", `第 ${Math.floor(offset / 100) + 1} 页`, "help"));
      if (next !== null) navigation.append(actionButton("下一页文章", () => turnPage(next), false, false));
      section.append(navigation);
    }
    section.hidden = false;
  }

  function renderSession(session) {
    if (!session) return;
    if (session.authenticated === true) session = { ...session, status: "authenticated" };
    if (sessionId(session) && sessionId(session) === sessionId(state.session)
        && !sessionReady(state.session) && sessionReady(session)) state.sessionVersion += 1;
    state.session = session;
    $("wechat-session").hidden = false;
    const good = sessionReady(session);
    const article = session.purpose === "article";
    const expired = ["expired", "stale", "failed"].includes(session.status);
    let statusText;
    if (good) statusText = article ? "文章验证已完成，任务将继续获取。" : "微信已登录，可以继续获取文章。";
    else if (expired) statusText = "本次验证入口已失效，请重新打开。";
    else statusText = article ? "请打开验证页面，完成微信要求的验证后检查结果。" : "请打开登录页面或扫描下方二维码，并在微信中确认。";
    $("wechat-message").textContent = statusText;
    $("wechat-finish-button").textContent = article ? "我已完成验证，检查结果" : "我已完成扫码，检查登录";
    $("wechat-help").textContent = article ? "完成验证后点击检查结果。任务会继续处理原来的文章。" : "扫码后需要在微信中确认。登录结果以检查结果为准。";
    $("wechat-finish-button").hidden = good || expired;
    const live = safeLink(session.live_view_url || "");
    $("wechat-live-view").hidden = !live || good || expired;
    if (live) $("wechat-live-view").href = live;
    const screenshot = session.screenshot_url && safeLink(session.screenshot_url, true);
    const img = $("wechat-screenshot");
    img.alt = article ? "微信文章验证页面" : "微信登录页面，请使用微信扫码";
    img.hidden = !screenshot || good || expired;
    if (screenshot && !good && !expired) img.src = `${screenshot}${screenshot.includes("?") ? "&" : "?"}t=${Date.now()}`;
    else img.removeAttribute("src");
    if (!good && !expired && !live && !screenshot) $("wechat-message").textContent = "登录页面正在准备，稍后会显示。";
  }

  async function loadSession() {
    const id = sessionId(state.session);
    if (!id) return;
    const scope = sessionScope(id);
    try {
      const data = await api(`/api/admin/wechat/login/${encodeURIComponent(id)}`);
      const session = data.session || data;
      if (!currentSession(scope) || sessionId(session) && sessionId(session) !== id) return;
      renderSession({ ...state.session, ...session });
    } catch (error) { throw scopedError(error, scope); }
  }

  async function startWechatLogin(options = {}) {
    state.sessionVersion += 1;
    const scope = sessionScope();
    try {
      const data = await post("/api/admin/wechat/login", options);
      if (!currentSession(scope)) return;
      const session = data.session || data;
      if (!sessionId(session)) throw new Error("验证入口尚未准备好，请稍后重新打开。");
      renderSession(session);
      $("wechat-session").scrollIntoView?.({ behavior: "smooth", block: "center" });
    } catch (error) { throw scopedError(error, scope); }
  }

  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    const version = state.version;
    try {
      const data = await api("/api/admin/status");
      if (version !== state.version) return;
      state.authenticated = true;
      setConfigured(data.configured !== false);
      $("login-panel").hidden = true;
      $("admin-content").hidden = false;
      $("logout-button").hidden = false;
      state.sources = Array.isArray(data.sources) ? data.sources : [];
      state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      const activeSource = automaticSource();
      const loginText = isRss(activeSource) ? "公开订阅源无需微信扫码；更新可能延迟 0—24 小时。"
        : data.login?.status === "saved" ? "已保存登录状态，采集时验证。" : ["ready", "authenticated", "logged_in"].includes(data.login?.status) ? "微信登录正常。" : "获取公众号后台文章前，请先完成微信登录。";
      let serviceText;
      if (data.configured === false) serviceText = "自动获取暂未准备完成，请完成服务设置后再开始任务。";
      else if (data.cloud_enabled === false) serviceText = `网站更新尚未启用，手动获取可用于验证。${loginText}`;
      else if (data.enabled === false) serviceText = `每日自动获取尚未开启；登录和手动获取仍可使用。${loginText}`;
      else serviceText = loginText;
      $("service-status").textContent = serviceText;
      renderScheduler(data.scheduler);
      renderReader(data.reader);
      const today = todayInBeijing();
      $("start-date").max = today;
      $("end-date").max = today;
      renderSources();
      renderJobs();
      if (!state.session && (data.login?.session_id || data.login?.id)) renderSession(data.login);
      const results = await Promise.allSettled([loadDetail(), loadSession()]);
      const failure = results.find((result) => result.status === "rejected" && relevantError(result.reason));
      if (failure && version === state.version) message("page-message", failure.reason.message, false);
    } catch (error) {
      if (version === state.version) message(state.authenticated ? "page-message" : "login-message", error.message, false);
    } finally { state.refreshing = false; }
  }

  function schedulePoll() {
    clearTimeout(state.timer);
    if (document.hidden || !state.authenticated) return;
    state.timer = setTimeout(async () => { if (!document.hidden) await refresh(); schedulePoll(); }, 5000);
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter || event.currentTarget.querySelector("button");
    await busy(button, async () => {
      const password = $("password").value;
      if (!password) { message("login-message", "请输入管理密码。", false); return; }
      try {
        await post("/api/admin/login", { password });
        $("password").value = "";
        message("login-message", "");
        await refresh();
        schedulePoll();
      } catch (error) { message("login-message", error.message, false); }
    });
  });

  $("logout-button").addEventListener("click", async (event) => {
    try { await busy(event.currentTarget, () => post("/api/admin/logout")); showLogin(); }
    catch (error) { message("page-message", error.message, false); }
  });

  $("source-search-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = $("source-query").value.trim();
    if (!query) { message("source-message", "请输入要搜索的公众号名称。", false); return; }
    const button = event.submitter || event.currentTarget.querySelector("button");
    await busy(button, async () => {
      message("source-message", "正在搜索公众号…");
      $("source-results").replaceChildren();
      try {
        const data = await api(`/api/admin/sources/search?q=${encodeURIComponent(query)}`);
        const sources = Array.isArray(data.sources) ? data.sources : [];
        message("source-message", sources.length ? "请核对公众号名称后添加。" : "没有找到匹配的公众号，请检查名称或登录状态。");
        for (const source of sources) {
          const row = element("li", undefined, "admin-row");
          row.append(element("strong", source.name || "未命名公众号"));
          row.append(actionButton("添加公众号", async () => {
            const result = await post("/api/admin/sources", { name: source.name, fakeid: source.fakeid, ...(source.account_biz ? { account_biz: source.account_biz } : {}) });
            message("source-message", result.notice || "公众号已添加。");
            $("source-results").replaceChildren();
            await refresh();
          }));
          $("source-results").append(row);
        }
      } catch (error) { message("source-message", error.message, false); }
    });
  });

  $("history-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const source_id = $("history-source").value;
    const start_date = $("start-date").value;
    const end_date = $("end-date").value;
    let error = "";
    if (!source_id) error = "请选择来源。";
    else if (!validDate(start_date)) error = "请选择有效的开始日期。";
    else if (!validDate(end_date)) error = "请选择有效的结束日期。";
    else if (end_date < start_date) error = "结束日期不能早于开始日期。";
    else if (start_date > todayInBeijing() || end_date > todayInBeijing()) error = "不能选择北京时间今天之后的日期。";
    if (error) { message("history-message", error, false); return; }
    const button = event.submitter || event.currentTarget.querySelector("button");
    await busy(button, async () => {
      try {
        const payload = { kind: "history", source_id, start_date, end_date };
        const data = await post("/api/admin/jobs", payload, { "Idempotency-Key": submissionKey("history", payload) });
        delete state.submissions.history;
        state.detailId = data.job?.id || data.job_id || null;
        state.detailOffset = 0;
        const source = state.sources.find(item => String(item.id) === source_id);
        message("history-message", isRss(source) ? "历史获取任务已开始，仅保存公开源可获取的文章；未收录的文章无法补齐。关闭此页面后任务仍会继续。" : "历史获取任务已开始。关闭此页面后任务仍会继续。");
        await refresh();
      } catch (failure) { message("history-message", failure.message, false); }
    });
  });

  for (const id of ["history-source", "start-date", "end-date"]) $(id).addEventListener("change", renderHistoryCoverage);

  $("links-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const links = [...new Set($("links").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
    if (!links.length) { message("links-message", "请至少输入一个文章链接。", false); return; }
    if (links.length > 50) { message("links-message", "每次最多提交 50 个不同链接，请分批提交。", false); return; }
    const invalid = links.find((value) => { try { const url = new URL(value); return !/^https?:$/.test(url.protocol) || Boolean(url.username || url.password); } catch { return true; } });
    if (invalid) { message("links-message", `请检查这个链接：${invalid}`, false); return; }
    const button = event.submitter || event.currentTarget.querySelector("button");
    await busy(button, async () => {
      try {
        const payload = { links };
        const data = await post("/api/submit", payload, { "Idempotency-Key": submissionKey("links", payload) });
        delete state.submissions.links;
        state.detailId = data.job?.id || data.job_id || null;
        state.detailOffset = 0;
        $("links").value = "";
        message("links-message", "文章链接已提交，可在任务进度中查看结果。");
        await refresh();
      } catch (error) { message("links-message", error.message, false); }
    });
  });

  $("reader-probe-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    let url;
    try { url = publicReaderUrl($("reader-article-url").value.trim()); }
    catch (error) { message("reader-message", error.message, false); return; }
    const button = event.submitter || event.currentTarget.querySelector("button");
    const version = state.version;
    await busy(button, async () => {
      try { await queueReaderProbe(url); }
      catch (error) { if (version === state.version) message("reader-message", readerErrors[error.code] || "本次验证未能启动，请稍后重试。", false); }
    });
  });

  $("reader-session-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    let readingUrl = $("reader-session-url").value.trim();
    $("reader-session-url").value = "";
    const button = event.submitter || event.currentTarget.querySelector("button");
    const version = state.version;
    await busy(button, async () => {
      try {
        let parsed;
        try { parsed = new URL(readingUrl); } catch { throw new Error("请提供含微信阅读状态的官方链接。"); }
        if (parsed.origin !== "https://mp.weixin.qq.com" || parsed.username || parsed.password || parsed.port) throw new Error("阅读授权仅支持微信官方 HTTPS 链接。");
        if (["uin", "key", "pass_ticket"].some(key => parsed.searchParams.getAll(key).length !== 1 || !parsed.searchParams.get(key))) {
          throw new Error("这是普通分享链接或不完整的授权链接，未包含可用的微信阅读状态。");
        }
        try { await post("/api/admin/reader/session", { url: readingUrl }); }
        catch (error) {
          if (version === state.version) message("reader-session-message", readerErrors[error.code] || "阅读授权未能保存，请检查链接是否含有效阅读状态。", false);
          return;
        } finally { readingUrl = ""; }
        if (version !== state.version) return;
        message("reader-session-message", "阅读授权已保存，正在验证实际可用状态。");
        // Authentication URLs are never forwarded to the public probe endpoint.
        try { await queueReaderProbe(); }
        catch (error) { if (version === state.version) message("reader-message", readerErrors[error.code] || "授权已保存，验证暂未启动，请点击“验证阅读与留言”。", false); }
      } catch (error) { if (version === state.version) message("reader-session-message", error.message, false); }
      finally { readingUrl = ""; }
    });
  });

  $("wechat-login-button").addEventListener("click", async (event) => {
    try { await busy(event.currentTarget, () => startWechatLogin()); }
    catch (error) { if (relevantError(error)) message("page-message", error.message, false); }
  });

  $("scheduler-start-button").addEventListener("click", async (event) => {
    try {
      await busy(event.currentTarget, async () => {
        await post("/api/admin/scheduler/start");
        message("page-message", "定时检查已安排，执行后会更新运行记录。");
        await refresh();
      });
    } catch (error) { message("page-message", error.message, false); }
  });

  $("wechat-finish-button").addEventListener("click", async (event) => {
    const id = sessionId(state.session);
    if (!id) return;
    const scope = sessionScope(id);
    try {
      await busy(event.currentTarget, async () => {
        const data = await post(`/api/admin/wechat/login/${encodeURIComponent(id)}/finish`);
        const session = data.session || data;
        if (!currentSession(scope) || sessionId(session) && sessionId(session) !== id) return;
        renderSession({ ...state.session, ...session });
        await refresh();
      });
    } catch (error) { if (currentSession(scope)) message("page-message", error.message, false); }
  });

  $("refresh-button").addEventListener("click", () => refresh());
  document.addEventListener("visibilitychange", async () => {
    clearTimeout(state.timer);
    if (!document.hidden && state.authenticated) { await refresh(); schedulePoll(); }
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(state.timer);
    $("reader-session-url").value = "";
  });
  window.addEventListener("pageshow", async (event) => {
    if (event.persisted && !document.hidden && state.authenticated) { await refresh(); schedulePoll(); }
  });
  const loginButton = $("login-form").querySelector("button");
  loginButton.disabled = true;
  refresh().then(schedulePoll).finally(() => { loginButton.disabled = false; });
})();
