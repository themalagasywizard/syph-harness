// Runs enabled Tasks when their cron schedule comes due. Runs missed while Syph was closed
// catch up once (not once per missed slot) on the next start.
import type { Home } from "./home.ts";
import { lastDue, nextRun } from "./cron.ts";
import { listTasks } from "./store.ts";
import { readJson, writeJson } from "./util.ts";
import type { Task } from "./types.ts";

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();

  constructor(private home: Home, private run: (task: Task) => Promise<void>, private intervalMs = 20_000) {}

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private stateFile() {
    return this.home.path("scheduler.json");
  }

  /** Check every task once. Exposed for tests. */
  async tick(at = new Date()) {
    if (this.home.config().killSwitch) return;
    const state = readJson<{ lastTick?: string }>(this.stateFile(), {});
    const since = state.lastTick ? new Date(state.lastTick) : new Date(at.getTime() - 60_000);
    writeJson(this.stateFile(), { lastTick: at.toISOString() });
    const due: Task[] = [];
    for (const t of listTasks(this.home)) {
      if (!t.enabled || this.running.has(t.id)) continue;
      try {
        const lastRun = t.lastRun ? new Date(t.lastRun) : null;
        const from = lastRun && lastRun > since ? lastRun : since;
        if (lastDue(t.schedule, from, at)) due.push(t);
      } catch {
        /* invalid cron: shown in the UI, skipped here */
      }
    }
    await Promise.all(
      due.map(async (t) => {
        this.running.add(t.id);
        try {
          await this.run(t);
        } finally {
          this.running.delete(t.id);
        }
      }),
    );
  }
}

export function nextRunOf(task: Task): string | null {
  try {
    return nextRun(task.schedule)?.toISOString() ?? null;
  } catch {
    return null;
  }
}
