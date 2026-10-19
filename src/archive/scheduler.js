import { automaticWindow } from "./core.js";

const INTERVAL = 300_000;
const DAY = 86_400_000;
const ACTIVE = new Set(["queued", "running", "waiting", "paused"]);

export function schedulerDay(now = Date.now()) {
  return Math.floor(now / DAY) * DAY;
}

export function schedulerId(day) {
  if (!Number.isSafeInteger(day) || schedulerDay(day) !== day) throw new Error("Invalid scheduler day");
  return `archive-schedule-${new Date(day).toISOString().slice(0, 10)}`;
}

function missing(error) {
  return /not found|does not exist|not exist|instance.*404|instance.*not_found/i.test(String(error?.message || ""));
}

// Deterministic IDs also resolve an ambiguous create response without another timer.
export async function ensureScheduler(env, day = schedulerDay()) {
  if (!env.ARCHIVE_SCHEDULER) return { status: "unconfigured" };
  const id = schedulerId(day);
  let instance;
  try { instance = await env.ARCHIVE_SCHEDULER.get(id); await instance.status(); }
  catch (error) {
    if (!missing(error)) throw error;
    try {
      await env.ARCHIVE_SCHEDULER.create({ id, params: { day } });
      return { id, status: "queued" };
    } catch (createError) {
      try { instance = await env.ARCHIVE_SCHEDULER.get(id); await instance.status(); }
      catch { throw createError; }
    }
  }
  let status = (await instance.status()).status;
  if (status === "paused") { await instance.resume(); status = "running"; }
  else if (["complete", "completed", "errored", "terminated"].includes(status)) { await instance.restart(); status = "queued"; }
  else if (!ACTIVE.has(status)) throw new Error("Scheduler status is unavailable");
  return { id, status };
}

export async function runScheduler(env, step, day, scheduledArchive, now = Date.now, relay) {
  const id = schedulerId(day);
  if (now() < day) await step.sleepUntil("day-start", day);
  let nextEnsured = false;
  for (let tick = day; tick < day + DAY; tick += INTERVAL) {
    if (now() - tick >= INTERVAL) continue;
    if (now() < tick) await step.sleepUntil(`sleep-${tick}`, tick);
    // Persist tomorrow's timer before today's work. If creation fails, still run
    // today's check and retry creation at the next tick.
    if (!nextEnsured) {
      try {
        await step.do(`ensure-next-day-${tick}`, {
          retries: { limit: 1, delay: "15 seconds", backoff: "constant" }, timeout: "1 minute",
        }, () => ensureScheduler(env, day + DAY));
        nextEnsured = true;
      } catch { console.warn(JSON.stringify({ event: "archive_scheduler_next_pending", tick })); }
    }
    try {
      await step.do(`tick-${tick}`, {
        retries: { limit: 1, delay: "15 seconds", backoff: "constant" }, timeout: "4 minutes",
      }, async () => {
        // A late/restarted instance must not replay yesterday's monitoring window.
        if (now() - tick >= INTERVAL || now() < tick) return { skipped: true };
        await scheduledArchive({ scheduledTime: tick }, env);
        await env.ARCHIVE_DB.prepare(`UPDATE archive_scheduler SET instance_id=?,last_tick_at=?,
          last_success_at=?,last_error=?,updated_at=? WHERE singleton=1`)
          .bind(id, tick, now(), nextEnsured ? null : "明日定时任务正在等待重试，当前检查继续执行。", now()).run();
        return { tick };
      });
    } catch (error) {
      try {
        await step.do(`error-${tick}`, async () => {
          await env.ARCHIVE_DB.prepare(`UPDATE archive_scheduler SET instance_id=?,last_tick_at=?,
            last_error=?,updated_at=? WHERE singleton=1`)
            .bind(id, tick, "定时检查暂时失败，下一次检查将继续。", now()).run();
        });
      } catch { console.warn(JSON.stringify({ event: "archive_scheduler_health_pending", tick })); }
      console.warn(JSON.stringify({ event: "archive_scheduler_tick_failed", tick, code: error?.code || "SCHEDULE_FAILED" }));
    }
    // A finishing old batch can race with the final tick's dispatch. Reconcile
    // only its persisted outbox while the original final authorization is valid.
    if (relay && automaticWindow(tick).final) {
      for (const delay of [15_000, 60_000, 180_000, 240_000]) {
        const target = tick + delay;
        if (now() >= tick + INTERVAL) break;
        if (now() < target) await step.sleepUntil(`relay-sleep-${tick}-${delay}`, target);
        try {
          await step.do(`relay-${tick}-${delay}`, { retries: { limit: 1, delay: "5 seconds" }, timeout: "30 seconds" }, relay);
        } catch { console.warn(JSON.stringify({ event: "archive_final_dispatch_pending", tick })); }
      }
    }
  }
  return { day, state: "completed" };
}
