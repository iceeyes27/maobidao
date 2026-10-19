import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { schedulerDay, schedulerId } from "../src/archive/scheduler.js";

const executable = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const day = schedulerDay();
const id = schedulerId(day);
function command(args) {
  const result = spawnSync(process.execPath, [executable, "workflows", ...args, "--json"], {
    encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  let data;
  try { data = JSON.parse(result.stdout); } catch { /* CLI failures are handled without printing environment data. */ }
  return { success: result.status === 0, data };
}

let current = command(["instances", "describe", "maobidao-scheduler", id]);
if (!current.success) current = command(["trigger", "maobidao-scheduler", JSON.stringify({ day }), "--id", id]);
else if (["complete", "completed", "errored", "terminated"].includes(current.data?.status)) {
  current = command(["instances", "restart", "maobidao-scheduler", id]);
} else if (current.data?.status === "paused") current = command(["instances", "resume", "maobidao-scheduler", id]);
else if (!["queued", "running", "waiting", "waitingForPause"].includes(current.data?.status)) current.success = false;
if (!current.success) {
  console.error("未能确认云端定时任务，请在管理页启动或恢复定时检查。");
  process.exitCode = 1;
} else console.log(`云端定时任务已确认：${id}`);
