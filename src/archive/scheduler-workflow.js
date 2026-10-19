import { WorkflowEntrypoint } from "cloudflare:workers";
import { runScheduler } from "./scheduler.js";

export class ArchiveScheduler extends WorkflowEntrypoint {
  async run(event, step) {
    return runScheduler(this.env, step, event.payload.day,
      (controller) => this.env.ARCHIVE_EXECUTOR.getByName("schedule").runSchedule(controller.scheduledTime), Date.now,
      () => this.env.ARCHIVE_EXECUTOR.getByName("schedule").runPending());
  }
}
