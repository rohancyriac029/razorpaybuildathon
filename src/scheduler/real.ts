// Spec §3.2: "RealScheduler wraps BullMQ." This is a lighter substitute for
// the hackathon build: in-process setTimeout-based firing, satisfying the
// exact same Scheduler port as VirtualScheduler (block 3) and a real
// BullMQ-backed implementation would.
//
// Known limitation, stated plainly: schedules do NOT survive a process
// restart. A real production deployment needs BullMQ/Redis (or an
// equivalent durable queue) for that; this is the documented, deliberate
// simplification spec's own stack table calls out as acceptable ("Redis
// becomes optional infrastructure rather than a day of setup"). For a
// hackathon demo running continuously, this is a non-issue.
import type { Scheduler } from "../ports/scheduler.js";

export class RealScheduler implements Scheduler {
  private callback: ((intentId: string, at: Date) => Promise<void>) | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  now(): Date {
    return new Date();
  }

  async scheduleAt(t: Date, intentId: string): Promise<void> {
    const delayMs = Math.max(0, t.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(intentId);
      void this.callback?.(intentId, new Date());
    }, delayMs);
    this.timers.set(intentId, timer);
  }

  onFire(cb: (intentId: string, at: Date) => Promise<void>): void {
    this.callback = cb;
  }

  /** Test/shutdown only: cancels every pending timer. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
