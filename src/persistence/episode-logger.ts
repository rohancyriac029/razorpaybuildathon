// The concrete EpisodeLogger (src/run.ts's `log` callback) for production
// and for the spine test. Writes to BOTH `episodes` (the full audit
// narrative — every attempt, every verdict, rejected or not) and `intents`
// (the narrower post-policy record used for the P7 idempotency check).
//
// [Block 4] decide()/executeApproved() (src/run.ts) log the SAME episode
// twice for an approved, execution-bound proposal: once at decision time
// (execResult=null, outcome='pending') and once at execution time
// (execResult populated). This logger UPSERTs on `entry.intentId` — the
// second call updates the row the first call created, rather than
// inserting a duplicate.
//
// IMPORTANT for block 7/8 (the eval): each of the 5 strategies replays the
// SAME 120 scenarios. If the eval runner reuses a scenario-derived orderId
// verbatim across strategies, idempotencyKey(orderId, attemptNumber) will
// collide on intents' UNIQUE constraint the second strategy touches the
// "same" scenario. The eval runner must mint a strategy-scoped internal
// orderId per (scenarioId, strategyName, seed) — same abstract scenario,
// distinct orderId — so this collision never happens. Not needed yet
// (block 3/4 only ever create one order at a time); flagged here so block
// 7/8 doesn't rediscover it the hard way.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { EpisodeLogEntry, EpisodeLogger } from "../run.js";
import { idempotencyKey } from "../util/idempotency.js";

type Db = BetterSQLite3Database<typeof schema>;

function intentStatus(entry: EpisodeLogEntry): "pending" | "executed" | "rejected" | "escalated" {
  if (entry.verdict.kind === "REJECT") return "rejected";
  if (entry.proposal.type === "ESCALATE") return "escalated";
  if (entry.proposal.type === "MARK_TERMINAL") return "executed"; // the marking itself is the whole action
  return entry.execResult?.ok ? "executed" : "pending"; // pending: not yet executed, P8-skipped, or a genuine Razorpay-side failure
}

export function makeEpisodeLogger(
  db: Db,
  strategyName: string,
  runId: string | null = null,
): EpisodeLogger {
  return async (entry: EpisodeLogEntry): Promise<void> => {
    // NOT real wall-clock new Date(): this must track whatever "now" the
    // caller is actually operating on — decision time (entry.proposal.
    // proposedAt, itself derived from ctx.now by the strategy) on the first
    // call, execution time (entry.execResult.executedAt, which run.ts sets
    // from the proposal's own sendAt) on the second. Using real wall-clock
    // time here silently broke P10's global-rate check for anything running
    // against simulated or backdated time — the eval (VirtualScheduler) and
    // the backfill script (block 10) both operate on time that isn't "now."
    // Caught by block 10's own test: a backfill dated months in the past
    // logged episodes stamped with today's real date, so P10's "last hour"
    // window never matched any of them.
    const rowTimestamp = entry.execResult?.executedAt ?? entry.proposal.proposedAt;

    const existingIntent = entry.intentId
      ? db.select({ episodeId: schema.intents.episodeId }).from(schema.intents).where(eq(schema.intents.id, entry.intentId)).get()
      : undefined;

    if (existingIntent) {
      // Second call for this intentId (execute-time update): patch both rows,
      // including createdAt — the row's meaningful timestamp for P10 purposes
      // is now the actual execution time, not the earlier decision time.
      db.update(schema.episodes)
        .set({ execResult: entry.execResult as unknown as object | null, outcome: entry.outcome, createdAt: rowTimestamp })
        .where(eq(schema.episodes.id, existingIntent.episodeId))
        .run();
      db.update(schema.intents)
        .set({ status: intentStatus(entry), razorpayRefId: entry.execResult?.razorpayRefId ?? null, createdAt: rowTimestamp })
        .where(eq(schema.intents.id, entry.intentId!))
        .run();
      return;
    }

    const episodeId = randomUUID();
    db.insert(schema.episodes)
      .values({
        id: episodeId,
        orderId: entry.proposal.orderId,
        attemptNumber: entry.proposal.attemptNumber,
        strategyName,
        contextHash: entry.contextHash,
        reasoning: entry.reasoning,
        proposal: entry.proposal as unknown as object,
        verdictKind: entry.verdict.kind,
        verdictRuleId: entry.verdict.ruleId,
        verdictReason: entry.verdict.reason,
        execResult: entry.execResult as unknown as object | null,
        outcome: entry.outcome,
        runId,
        createdAt: rowTimestamp,
      })
      .run();

    // onConflictDoNothing, targeted at the idempotencyKey column: a P7
    // REJECT for a duplicate (orderId, attemptNumber) reaches here with
    // entry.intentId === null (decide()/decidePurchase() never mint one for
    // a REJECT), so `existingIntent` above is never found and this always
    // falls into the INSERT branch — but the idempotencyKey it computes is,
    // by definition, the SAME key an earlier EXECUTED intent already has.
    // Without the conflict guard this throws a raw SqliteError instead of
    // recording the rejection, turning a correctly-computed P7 verdict into
    // a crash. The EPISODE row above is still inserted unconditionally, so
    // the rejected duplicate is fully visible in the audit trail — only the
    // second, colliding INTENTS row is the one that's skipped, since the
    // original executed intent remains the canonical record for that key.
    // Found via test/commerce-buyer.test.ts's idempotency case — the first
    // test anywhere in this build to actually call decide-shaped logic
    // twice for the same (orderId, attemptNumber) through the real logger;
    // test/policy-rules.test.ts's P7 tests only exercise evaluateProposal()
    // directly against a hand-built snapshot, never this write path.
    db.insert(schema.intents)
      .values({
        id: entry.intentId ?? randomUUID(),
        episodeId,
        orderId: entry.proposal.orderId,
        attemptNumber: entry.proposal.attemptNumber,
        proposalType: entry.proposal.type,
        idempotencyKey: idempotencyKey(entry.proposal.orderId, entry.proposal.attemptNumber),
        status: intentStatus(entry),
        razorpayRefId: entry.execResult?.razorpayRefId ?? null,
        createdAt: rowTimestamp,
      })
      .onConflictDoNothing({ target: schema.intents.idempotencyKey })
      .run();
  };
}
