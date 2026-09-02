// Spec §3.1. One shared decision path for eval and production.
// RealScheduler wraps BullMQ (production). VirtualScheduler is an in-memory
// priority queue (eval). Both satisfy this same interface, so the code that
// decides *when* something happens cannot diverge between the two.

export interface Scheduler {
  now(): Date;
  scheduleAt(t: Date, intentId: string): Promise<void>;
  /** VirtualScheduler only — advances simulated time and fires due callbacks. */
  advance?(to: Date): Promise<void>;
  onFire(cb: (intentId: string, at: Date) => Promise<void>): void;
}
