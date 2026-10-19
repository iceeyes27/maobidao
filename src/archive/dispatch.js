import { ArchiveStore } from "./store.js";
import { automaticWindow } from "./core.js";

const TERMINAL = new Set(["completed", "cancelled", "partial_failed", "failed"]);

function missingInstance(error) {
  return /not found|does not exist|not exist|instance.*404|instance.*not_found/i.test(String(error?.message || ""));
}

export async function dispatchJob(env, job, { signal = false, loginVersion } = {}) {
  if (!env.ARCHIVE_WORKFLOW || !env.ARCHIVE_DB || TERMINAL.has(job.status)) return false;
  const store = new ArchiveStore(env.ARCHIVE_DB);
  const lease = await store.acquireLease(`dispatch:${job.id}`, crypto.randomUUID(), 30_000);
  if (!lease) return false;
  try {
    job = await store.getJob(job.id);
    if (!job || TERMINAL.has(job.status)) return false;
    const dispatch = await store.getDispatch(job.id);
    if (!dispatch) return false;
    const generation = dispatch.generation;
    const reason = dispatch.reason;
    let instance;
    let status;
    try {
      instance = await env.ARCHIVE_WORKFLOW.get(job.workflow_id);
      status = (await instance.status()).status;
    }
    catch (error) {
      if (!missingInstance(error)) throw error;
      await env.ARCHIVE_WORKFLOW.create({ id: job.workflow_id, params: { job_id: job.id } });
      await store.markDispatched(job.id, job.workflow_id, generation);
      return true;
    }
    if (["complete", "completed", "errored", "terminated"].includes(status)) await instance.restart();
    else if (status === "paused" && ["resume", "auth"].includes(reason)) {
      await instance.resume();
    } else if (["running", "waiting", "queued"].includes(status)) {
      if (["continue", "scheduled", "retry"].includes(reason)) return false;
      if (!["auth", "resume"].includes(reason) && !signal) {
        await store.markDispatched(job.id, job.workflow_id, generation);
        return true;
      }
      const version = loginVersion ?? job.progress?.login_version;
      await instance.sendEvent({ type: "control", payload: { job_id: job.id, action: "resume", ...(version == null ? {} : { login_version: version }) } });
    } else return false;
    await store.markDispatched(job.id, job.workflow_id, generation);
    return true;
  } finally { await store.releaseLease(lease); }
}

export async function dispatchPending(env) {
  if (!env.ARCHIVE_DB || !env.ARCHIVE_WORKFLOW) return 0;
  const store = new ArchiveStore(env.ARCHIVE_DB);
  let count = 0;
  for (const job of await store.listPendingDispatch()) {
    if (job.next_retry_at && job.next_retry_at > Date.now()) continue;
    if (job.kind === "auto") {
      const article = job.article_key ? await store.getArticleByKey(job.article_key) : null;
      if (!article?.captured_at && env.ARCHIVE_AUTO_ENABLED !== "true") continue;
      const window = job.progress?.dispatch_window;
      const time = Date.now();
      const finalGrant = window?.final && window.tick === window.end && time >= window.end
        && time < window.end + 300_000 && !job.progress?.final_capture_used;
      if (!article?.captured_at && !automaticWindow(time).active && !finalGrant) continue;
    }
    try { if (await dispatchJob(env, job)) count++; }
    catch { console.warn(JSON.stringify({ event: "archive_dispatch_pending", job_id: job.id })); }
  }
  return count;
}

export async function signalWaitingJobs(env, version) {
  const store = new ArchiveStore(env.ARCHIVE_DB);
  const session = await store.db.prepare("SELECT version FROM archive_session WHERE singleton=1").first();
  if (!Number.isSafeInteger(version) || session?.version !== version) return;
  const rows = await store.all(`SELECT * FROM archive_jobs WHERE (status='waiting_auth' OR json_extract(progress_json,'$.auth_required')=1)
    AND status NOT IN ('cancelled','completed','partial_failed','failed') ORDER BY created_at LIMIT 100`);
  for (const job of rows) {
    if (version <= Number(job.progress?.auth_failed_version ?? -1)) continue;
    const updated = await store.patchJobProgress(job.id, { auth_required: false, login_version: version },
      { status: job.status === "paused" ? "paused" : "queued", last_error: null });
    if (!updated || updated.status !== "queued") continue;
    await store.requestDispatch(job.id, "auth");
    try { await dispatchJob(env, updated, { signal: true, loginVersion: version }); }
    catch { console.warn(JSON.stringify({ event: "archive_resume_pending", job_id: job.id })); }
  }
}

export async function scheduledArchive(controller, env) {
  if (!env.ARCHIVE_DB || !env.ARCHIVE_WORKFLOW) return;
  const store = new ArchiveStore(env.ARCHIVE_DB);
  // A different job may have finished a shared article while its automatic task was dormant.
  const shared = await store.all(`SELECT job.* FROM archive_jobs job JOIN archive_articles article
    ON article.source_key=job.article_key OR article.id=(SELECT article_id FROM archive_article_aliases WHERE alias_key=job.article_key)
    WHERE job.kind='auto' AND job.status NOT IN ('completed','cancelled','paused') AND article.status='published' LIMIT 100`);
  for (const job of shared) {
    const article = await store.getArticleByKey(job.article_key);
    if (!article) continue;
    await store.updateJobItem(job.id, article.id, { status: "completed", last_error: null });
    await store.updateJob(job.id, { status: "completed", completed_count: 1, failed_count: 0, last_error: null });
    const dates = await store.all("SELECT monitor_date FROM archive_daily_runs WHERE job_id=?", [job.id]);
    for (const row of dates) await store.completeDaily(job.source_id, row.monitor_date);
  }
  const tick = Number(controller.scheduledTime || Date.now());
  const window = { ...automaticWindow(tick), tick };
  if (env.ARCHIVE_AUTO_ENABLED === "true" && window.active) {
    const sourceLease = await store.acquireLease("source-config", `schedule:${tick}`, 30_000);
    let sources = [];
    if (sourceLease) {
      try { sources = (await store.listSources()).filter((source) => source.enabled && source.baseline_completed_at); }
      finally { await store.releaseLease(sourceLease); }
    }
    // One enabled source is the current product contract; refuse an inconsistent configuration.
    if (sources.length > 1) throw new Error("More than one automatic source is enabled");
    for (const source of sources) {
      const scheduleLease = await store.acquireLease(`schedule:${source.id}`, `tick:${tick}`, 60_000);
      if (!scheduleLease) continue;
      try {
        let daily = await store.ensureDaily(source.id, window.date);
        if (["completed", "captured", "no_update"].includes(daily.status)) continue;
        let job = daily.job_id ? await store.getJob(daily.job_id) : null;
        if (!job) {
          const carryover = (await store.listCarryoverAutoJobs(source.id)).find((item) => item.monitor_date < window.date && item.status !== "cancelled");
          if (carryover) {
            job = carryover;
            daily = await store.selectDailyArticle(source.id, window.date, job.article_key, job.id);
            if (!daily) continue;
          } else {
            job = await store.createJob({ kind: "auto", source_id: source.id, monitor_date: window.date, range_start: window.start, range_end: window.end }, `auto:${source.id}:${window.date}`);
          }
        }
        if (job.status === "cancelled" || job.status === "paused") continue;
        const now = Date.now();
        const progress = job.progress || {};
        if (Math.max(job.next_retry_at || 0, progress.quota_wait_until || 0) > now) {
          const currentTick = progress.dispatch_window?.tick;
          // A short browser wait must not discard the independently scheduled
          // final check. Preserve the wait and let the existing Workflow or
          // final dispatch relay consume this authorization after it expires.
          if (window.final && window.tick === window.end
              && progress.browser_wait_until > now
              && !(progress.quota_wait_until > now)
              && (!Number.isSafeInteger(currentTick) || currentTick <= window.tick)
              && !progress.final_capture_used
              && !(progress.final_poll_used && progress.final_poll_tick === window.tick)) {
            await store.patchJobProgress(job.id, { dispatch_window: window });
            await store.requestDispatch(job.id, "scheduled");
          }
          continue;
        }
        const article = job.article_key ? await store.getArticleByKey(job.article_key) : null;
        if (article?.captured_at) {
          await store.completeDaily(source.id, window.date, { capture_completed_at: article.captured_at, status: "captured" });
          continue;
        }
        // Waiting authentication must be resumed by a verified login event, never by each cron tick.
        if (job.status === "waiting_auth") continue;
        const updated = await store.scheduleJob(job.id, window);
        if (!updated) continue;
        await store.requestDispatch(job.id, "scheduled");
        await dispatchJob(env, updated);
      } finally { await store.releaseLease(scheduleLease); }
    }
  }
  await dispatchPending(env);
  await env.ARCHIVE_DB.prepare("DELETE FROM archive_admin_attempts WHERE reset_at<?").bind(Date.now() - 86_400_000).run();
}
