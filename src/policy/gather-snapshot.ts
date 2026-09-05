// DB-backed snapshot gatherer for the pure rule evaluator in rules.ts. Kept
// in its own file so rules.ts never imports Drizzle — the rule logic is
// testable with a hand-built PolicySnapshot and nothing else.
//
// Everything here derives from the `episodes` table, the same table
// run()'s logger writes after every attempt (src/run.ts). One source of
// truth for "what happened" — no separate counter that could drift from
// the audit log a reviewer would replay (spec §3.4).
//
// "Executed" for budget-counting purposes (P1/P2/P5) means execResult.ok
// === true: a P8 recheck that skipped execution because the order was
// already paid, or a genuine Razorpay API failure, does not burn a
// lifetime attempt or contact — nothing reached the customer or the card
// either way.

import { and, eq, gte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { ExecResult, Proposal } from "../types.js";
import { idempotencyKey } from "../util/idempotency.js";
import { istMidnightUtc } from "../util/ist.js";
import type { PolicySnapshot } from "./snapshot.js";

type Db = BetterSQLite3Database<typeof schema>;

// Kept in sync with rules.ts's own EXECUTION_BOUND (duplicated rather than
// imported so this file's only import stays Drizzle-free reasoning intact —
// see the module doc). v3 agentic-commerce: PURCHASE added here too, or
// P1/P10's counters would silently undercount purchases (a fresh buyer
// would never hit its own attempt/rate caps).
const EXECUTION_BOUND = new Set<Proposal["type"]>(["TOKEN_RETRY", "PAYMENT_LINK", "NUDGE", "PURCHASE"]);
const CUSTOMER_FACING = new Set<Proposal["type"]>(["PAYMENT_LINK", "NUDGE"]);

function wasReallyExecuted(execResult: unknown): boolean {
  if (!execResult || typeof execResult !== "object") return false;
  return (execResult as ExecResult).ok === true;
}

export function gatherSnapshot(
  db: Db,
  orderId: string,
  proposal: Proposal,
  now: Date,
): PolicySnapshot {
  const orderEpisodes = db
    .select({
      proposal: schema.episodes.proposal,
      execResult: schema.episodes.execResult,
      createdAt: schema.episodes.createdAt,
    })
    .from(schema.episodes)
    .where(eq(schema.episodes.orderId, orderId))
    .all();

  let priorExecutedAttempts = 0;
  let priorContacts = 0;
  let liveUnpaidLinkExecuted = false;
  let lastExecutionAt: Date | null = null;

  for (const row of orderEpisodes) {
    const p = row.proposal as Proposal;
    if (!wasReallyExecuted(row.execResult)) continue;
    const at = new Date(row.createdAt);
    if (EXECUTION_BOUND.has(p.type)) {
      priorExecutedAttempts++;
      if (!lastExecutionAt || at > lastExecutionAt) lastExecutionAt = at;
    }
    if (CUSTOMER_FACING.has(p.type)) priorContacts++;
    if (p.type === "PAYMENT_LINK") liveUnpaidLinkExecuted = true;
  }

  const order = db
    .select({ status: schema.orders.status })
    .from(schema.orders)
    .where(eq(schema.orders.id, orderId))
    .get();
  const liveUnpaidLinkExists = liveUnpaidLinkExecuted && order?.status !== "paid";

  const oneHourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  const globalRecentEpisodes = db
    .select({ proposal: schema.episodes.proposal, execResult: schema.episodes.execResult })
    .from(schema.episodes)
    .where(gte(schema.episodes.createdAt, oneHourAgo))
    .all();
  const globalExecutionsLastHour = globalRecentEpisodes.filter((r) => wasReallyExecuted(r.execResult)).length;

  const todayStart = istMidnightUtc(now).toISOString();
  const globalTodayEpisodes = db
    .select({ proposal: schema.episodes.proposal, execResult: schema.episodes.execResult })
    .from(schema.episodes)
    .where(gte(schema.episodes.createdAt, todayStart))
    .all();
  const globalContactsToday = globalTodayEpisodes.filter((r) => {
    const p = r.proposal as Proposal;
    return wasReallyExecuted(r.execResult) && CUSTOMER_FACING.has(p.type);
  }).length;

  const key = idempotencyKey(proposal.orderId, proposal.attemptNumber);
  const dupe = db
    .select({ id: schema.intents.id })
    .from(schema.intents)
    .where(and(eq(schema.intents.idempotencyKey, key), eq(schema.intents.status, "executed")))
    .get();

  return {
    priorExecutedAttempts,
    lastExecutionAt,
    priorContacts,
    liveUnpaidLinkExists,
    globalExecutionsLastHour,
    globalContactsToday,
    idempotencyKeyAlreadyExecuted: Boolean(dupe),
  };
}
