// Spec §6 block 4: wires CLASSIFY (block 1) through to a scheduled decision
// (blocks 2, 3, 4). Not baked directly into server.ts's webhook route —
// passed in as an optional hook (see buildServer in src/server.ts) so
// existing tests that only care about classification behavior are
// unaffected, and production wiring stays a one-time, explicit construction
// at startup rather than a hidden default.
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { Strategy } from "../ports/strategy.js";
import type { PolicyEngine } from "../ports/policy-engine.js";
import type { World } from "../ports/world.js";
import type { Scheduler } from "../ports/scheduler.js";
import { assembleEpisodeContext } from "../context/assemble.js";
import { decide, executeApproved, type EpisodeLogger } from "../run.js";
import { rehydrateForExecution } from "../persistence/rehydrate.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Call once after a payment.failed webhook has been classified (an order
 * and failure row now exist). Runs PROPOSE -> GATE -> LOG immediately, then
 * schedules EXECUTE for the proposal's sendAt — never executes early.
 */
export async function runDecisionPipeline(
  db: Db,
  orderId: string,
  strategy: Strategy,
  policyEngine: PolicyEngine,
  scheduler: Scheduler,
  log: EpisodeLogger,
): Promise<void> {
  const ctx = assembleEpisodeContext(db, orderId, scheduler.now());
  const decision = await decide(strategy, policyEngine, ctx, log);

  if (!decision.intentId) return; // rejected, terminal, or escalated — nothing to schedule

  const sendAt = "sendAt" in decision.proposal ? new Date(decision.proposal.sendAt) : scheduler.now();
  await scheduler.scheduleAt(sendAt, decision.intentId);
}

/**
 * Registers the scheduler's single onFire dispatcher. Rehydrates everything
 * executeApproved() needs from the DB by intentId (spec §3.4: replayable),
 * rather than closing over per-call state — so the dispatcher itself does
 * not depend on which webhook or process invocation originally proposed it.
 */
export function registerExecutionDispatcher(db: Db, scheduler: Scheduler, world: World, log: EpisodeLogger): void {
  scheduler.onFire(async (intentId) => {
    const rehydrated = rehydrateForExecution(db, intentId);
    if (!rehydrated) {
      console.error(`registerExecutionDispatcher: no episode found for intentId ${intentId}`);
      return;
    }
    await executeApproved(world, intentId, rehydrated.proposal, log, rehydrated.verdict, rehydrated.contextHash);
  });
}
