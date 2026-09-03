// Spec §4.2, §6 block 10: "P10 and P11 exist because of the backfill
// script... Either it exists or the rationale for two of your four new
// rules is fiction." The core ingestion logic, separated from scripts/
// backfill.ts's CLI/Razorpay-fetching shell so it's testable without a
// live API call or process invocation — this is the part that actually
// proves P10/P11 catch a runaway backfill, not the argument parsing.
import { dedupeAndStore, processPaymentFailed } from "../webhooks/handler.js";
import { assembleEpisodeContext } from "../context/assemble.js";
import { decide, executeApproved } from "../run.js";
import type { Strategy } from "../ports/strategy.js";
import type { PolicyEngine } from "../ports/policy-engine.js";
import type { World } from "../ports/world.js";
import type { EpisodeLogger } from "../run.js";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { PaymentFailedPayload } from "../webhooks/events.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface BackfillPaymentRecord {
  id: string;
  orderId: string;
  amountPaise: number;
  currency: string;
  errorReason: string | null;
  customerId: string | null;
  /** Unix seconds — when the payment actually failed, per Razorpay (or simulated). */
  createdAtUnix: number;
}

export interface BackfillStats {
  totalRecords: number;
  ingested: number; // new (not deduped)
  approved: number; // decide() APPROVE/MODIFY, including non-execution-bound (markTerminal/escalate)
  executed: number; // actually reached executeApproved() — this is what P10 counts against
  rejected: number;
  rejectedByRuleId: Record<string, number>;
}

/**
 * Ingests each record exactly as processPaymentFailed does for a real
 * webhook (spec §1: "P10 and P11... every one of those orders is on
 * attempt 1 — max attempts per order does nothing to stop this"), runs it
 * through the real decide() pipeline, and — for anything approved and
 * execution-bound — calls executeApproved() immediately (a backfill is a
 * "catch up now" operation, not a "schedule for later" one, so it doesn't
 * wait for the proposal's own sendAt the way production does). `now` is
 * the REAL current time passed by the caller (not the backdated record
 * time) — that gap is what makes P11's staleness check meaningful, and
 * `world` needs to actually report ok:true executions or P10's rate check
 * has nothing to count (see the module's test file for how this was found).
 */
export async function ingestBackfill(
  db: Db,
  records: BackfillPaymentRecord[],
  strategy: Strategy,
  policy: PolicyEngine,
  world: World,
  log: EpisodeLogger,
  now: Date = new Date(),
): Promise<BackfillStats> {
  const stats: BackfillStats = { totalRecords: records.length, ingested: 0, approved: 0, executed: 0, rejected: 0, rejectedByRuleId: {} };

  for (const record of records) {
    const eventId = `backfill_${record.id}`;
    const receivedAt = now.toISOString();

    const payload: PaymentFailedPayload = {
      event: "payment.failed",
      created_at: record.createdAtUnix,
      payload: {
        payment: {
          entity: {
            id: record.id,
            order_id: record.orderId,
            amount: record.amountPaise,
            currency: record.currency,
            error_code: null,
            error_description: null,
            error_source: null,
            error_step: null,
            error_reason: record.errorReason,
            customer_id: record.customerId,
          },
        },
      },
    };

    const { isNew } = dedupeAndStore(db, eventId, "payment.failed", payload, receivedAt);
    if (!isNew) continue; // running the backfill twice: the SAME event id dedupes at the webhook layer
    stats.ingested++;

    const processed = processPaymentFailed(db, eventId, payload, receivedAt);
    const ctx = assembleEpisodeContext(db, processed.orderId, now);
    const decision = await decide(strategy, policy, ctx, log);

    if (decision.verdict.kind === "REJECT") {
      stats.rejected++;
      stats.rejectedByRuleId[decision.verdict.ruleId] = (stats.rejectedByRuleId[decision.verdict.ruleId] ?? 0) + 1;
      continue;
    }

    stats.approved++;
    if (decision.intentId) {
      await executeApproved(world, decision.intentId, decision.proposal, log, decision.verdict, decision.contextHash);
      stats.executed++;
    }
  }

  return stats;
}
