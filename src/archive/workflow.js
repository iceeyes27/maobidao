import { WorkflowEntrypoint } from "cloudflare:workers";
import { ArchiveStore } from "./store.js";

export class ArchiveWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const store = new ArchiveStore(this.env.ARCHIVE_DB);
    // Operator-only Workflow invocation prepares the same protected login entry
    // used by the admin page, without exposing browser URLs in Workflow outputs.
    if (event.payload.action === "prepare-login") {
      return step.do("prepare-login", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, async () => {
        const lease = await store.acquireLease("wechat-account", `prepare-login:${crypto.randomUUID()}`, 90_000);
        if (!lease) return { state: "busy", prepared: false, code: "BUSY" };
        try {
          const response = await this.env.ARCHIVE_EXECUTOR.getByName("wechat-account").collectorOperation("createLoginSession", []);
          return response.ok ? { state: "waiting_auth", prepared: true } : {
            state: "failed", code: response.error.code,
            phase: response.error.phase || null, diagnostic: response.error.diagnostic || null,
          };
        } finally { await store.releaseLease(lease); }
      });
    }
    const jobId = event.payload.job_id;
    for (let batch = 0; batch < 20; batch++) {
      let result;
      try {
        result = await step.do(`batch-${batch}`, {
          retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes",
        }, async () => {
          const job = await store.getJob(jobId);
          if (!job) return { state: "cancelled", job_id: jobId };
          if (job.kind === "auto" && this.env.ARCHIVE_AUTO_ENABLED !== "true") {
            const article = job.article_key ? await store.getArticleByKey(job.article_key) : null;
            if (!article?.captured_at) return { state: "paused", job_id: jobId };
          }
          const dispatchWindow = job.progress?.dispatch_window;
          const output = await this.env.ARCHIVE_EXECUTOR.getByName(`job:${jobId}`).runBatch(jobId, dispatchWindow);
          return { ...output, dispatch_tick: dispatchWindow?.tick ?? null };
        });
      } catch (error) {
        await step.do(`record-error-${batch}`, async () => {
          const job = await store.getJob(jobId);
          if (!job || ["cancelled", "completed", "partial_failed"].includes(job.status)) return;
          await store.updateJob(jobId, {
            status: "retrying", last_error: "来源请求暂时失败，已保留当前进度。", next_retry_at: Date.now() + 300_000,
          });
          await store.requestDispatch(jobId, "retry");
        });
        console.warn(JSON.stringify({ event: "archive_batch_failed", job_id: jobId, code: error?.code || "UPSTREAM_ERROR" }));
        return { state: "retrying", job_id: jobId };
      }

      if (["completed", "cancelled"].includes(result.state)) return result;
      if (result.state === "waiting_quota") {
        if (Date.now() < result.retry_at) await step.sleepUntil(`quota-reset-${batch}`, result.retry_at);
        continue;
      }
      if (["idle", "awaiting_window"].includes(result.state)) {
        const changed = await step.do(`check-window-${batch}`, async () => {
          const job = await store.getJob(jobId);
          if (!job || ["cancelled", "paused", "completed", "partial_failed", "failed"].includes(job.status)) return false;
          const currentWindow = job.progress?.dispatch_window;
          const consumedTick = Number.isSafeInteger(result.dispatch_tick) ? result.dispatch_tick : -Infinity;
          if (Number.isSafeInteger(currentWindow?.tick) && currentWindow.tick > consumedTick) return true;
          if (result.state === "idle" && currentWindow?.final && currentWindow.tick === result.dispatch_tick && !job.article_key) {
            await store.updateJob(job.id, { status: "completed", last_error: null });
            await store.db.prepare("UPDATE archive_daily_runs SET status='no_update',updated_at=? WHERE source_id=? AND monitor_date=? AND selected_article_key IS NULL")
              .bind(Date.now(), job.source_id, job.monitor_date).run();
          }
          return false;
        });
        if (changed) continue;
        return result;
      }
      if (["waiting_auth", "paused"].includes(result.state)) {
        let resumed = false;
        for (let signal = 0; signal < 20 && !resumed; signal++) {
          const saved = await step.do(`control-state-${batch}-${signal}`, async () => {
            const job = await store.getJob(jobId);
            const session = await store.db.prepare("SELECT version FROM archive_session WHERE singleton=1").first();
            return { status: job?.status, auth_required: job?.progress?.auth_required, login_version: job?.progress?.login_version, current_version: session?.version };
          });
          if (saved.status === "cancelled") return { state: "cancelled", job_id: jobId };
          if (result.state === "paused" && saved.status !== "paused") { resumed = true; break; }
          if (result.state === "waiting_auth" && saved.status === "queued" && saved.auth_required !== true && Number.isSafeInteger(saved.login_version) && saved.login_version === saved.current_version) { resumed = true; break; }
          let control;
          try { control = await step.waitForEvent(`wait-control-${batch}-${signal}`, { type: "control", timeout: "24 hours" }); }
          catch { return { state: result.state, job_id: jobId }; }
          if (control.payload?.job_id !== jobId) continue;
          if (result.state === "waiting_auth") {
            const current = await step.do(`verify-control-${batch}-${signal}`, async () => {
              const session = await store.db.prepare("SELECT version FROM archive_session WHERE singleton=1").first();
              const job = await store.getJob(jobId);
              return { version: session?.version, auth_required: job?.progress?.auth_required };
            });
            if (current.auth_required === true || control.payload.login_version !== current?.version) continue;
          }
          resumed = true;
        }
        if (!resumed) return { state: result.state, job_id: jobId };
      } else {
        await step.sleep(`yield-${batch}`, result.state === "busy" ? "15 seconds" : "1 second");
      }
    }
    await step.do("continue-next-batch", async () => {
      const job = await store.getJob(jobId);
      if (job && !["cancelled", "completed", "partial_failed", "failed", "paused", "waiting_auth"].includes(job.status)) {
        await store.updateJob(jobId, { status: "queued" });
        await store.requestDispatch(jobId, "continue");
      }
    });
    return { state: "continue", job_id: jobId };
  }
}
