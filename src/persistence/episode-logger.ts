// The concrete EpisodeLogger (src/run.ts's `log` callback) for production
// and for the spine test. Writes to BOTH `episodes` (the full audit
// narrative — every attempt, every verdict, rejected or not) and `intents`
// (the narrower post-policy record used for the P7 idempotency check).
//
// IMPORTANT for block 7/8 (the eval): each of the 5 strategies replays the
// SAME 120 scenarios. If the eval runner reuses a scenario-derived orderId
// verbatim across strategies, idempotencyKey(orderId, attemptNumber) will
// collide on intents' UNIQUE constraint the second strategy touches the
// "same" scenario. The eval runner must mint a strategy-scoped internal
// orderId per (scenarioId, strategyName, seed) — same abstract scenario,
// distinct orderId — so this collision never happens. Not needed yet
// (block 3 only ever creates one order at a time); flagged here so block
// 7/8 doesn't rediscover it the hard way.

import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { EpisodeLogEntry, EpisodeLogger } from "../run.js";
import { idempotencyKey } from "../util/idempotency.js";

type Db = BetterSQLite3Database<typeof schema>;

function intentStatus(entry: EpisodeLogEntry): "pending" | "executed" | "rejected" | "escalated" {
  if (entry.verdict.kind === "REJECT") return "rejected";
  if (entry.proposal.type === "ESCALATE") return "escalated";
  if (entry.proposal.type === "MARK_TERMINAL") return "executed"; // the marking itself is the whole action
  return entry.execResult?.ok ? "executed" : "pending"; // pending: P8-skipped or a genuine Razorpay-side failure
}

export function makeEpisodeLogger(
  db: Db,
  strategyName: string,
  runId: string | null = null,
): EpisodeLogger {
  return async (entry: EpisodeLogEntry): Promise<void> => {
    const episodeId = randomUUID();
    const now = new Date().toISOString();

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
        createdAt: now,
      })
      .run();

    db.insert(schema.intents)
      .values({
        id: entry.execResult?.intentId ?? randomUUID(),
        episodeId,
        orderId: entry.proposal.orderId,
        attemptNumber: entry.proposal.attemptNumber,
        proposalType: entry.proposal.type,
        idempotencyKey: idempotencyKey(entry.proposal.orderId, entry.proposal.attemptNumber),
        status: intentStatus(entry),
        razorpayRefId: entry.execResult?.razorpayRefId ?? null,
        createdAt: now,
      })
      .run();
  };
}
