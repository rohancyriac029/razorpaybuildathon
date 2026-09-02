// Spec §3.1: the eval replays 200 (now 120, §5.8) scenarios across simulated
// days — you cannot wait real hours per scenario. VirtualScheduler is the
// in-memory priority queue standing in for RealScheduler/BullMQ, satisfying
// the exact same Scheduler port so eval and production share one decision
// path.
import type { Scheduler } from "../ports/scheduler.js";

interface QueueEntry {
  at: number; // epoch ms, for cheap comparison
  intentId: string;
}

export class VirtualScheduler implements Scheduler {
  private clock: Date;
  private queue: QueueEntry[] = [];
  private callback: ((intentId: string, at: Date) => Promise<void>) | null = null;

  constructor(startAt: Date) {
    this.clock = startAt;
  }

  now(): Date {
    return this.clock;
  }

  async scheduleAt(t: Date, intentId: string): Promise<void> {
    this.queue.push({ at: t.getTime(), intentId });
    this.queue.sort((a, b) => a.at - b.at);
  }

  onFire(cb: (intentId: string, at: Date) => Promise<void>): void {
    this.callback = cb;
  }

  /** Advances the clock to `to`, firing every due callback in timestamp order. */
  async advance(to: Date): Promise<void> {
    while (this.queue.length > 0 && this.queue[0]!.at <= to.getTime()) {
      const entry = this.queue.shift()!;
      this.clock = new Date(entry.at);
      if (this.callback) await this.callback(entry.intentId, this.clock);
    }
    if (to.getTime() > this.clock.getTime()) this.clock = to;
  }

  /** Test/debug only: how many fires are still pending. */
  pendingCount(): number {
    return this.queue.length;
  }
}
