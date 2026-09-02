// Builds the EpisodeContext every Strategy (stub, Rules, Agent, Oracle)
// receives on each run() invocation. Deliberately minimal for block 3's
// spine: enough for any strategy to make *a* decision, not yet the rich
// signal-extraction (predictive liquidity windows, etc.) the agent's
// getCustomerHistory tool will need — that sophistication belongs to block 6
// (the agent's tools) and block 7 (SimWorld's generator), not to this
// shared assembler. Customer history here intentionally matches the
// cut-list's pre-approved degradation (spec §10 item 6: "last-3-payments").
//
// Known simplification: "method" per historical payment isn't tracked in
// this schema (orders/failures don't record instrument type), so
// workingInstrument and CustomerHistoryEntry.method are placeholders. Real
// instrument tracking would need either richer webhook payload capture or a
// dedicated query against Razorpay's payment object — out of scope for the
// spine.

import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { ATTEMPT_COST_PAISE } from "../economics/constants.js";
import { istHourOfDay } from "../util/ist.js";
import type {
  CustomerHistory,
  EpisodeContext,
  FailureEvent,
  Order,
  PriorAttempt,
  Proposal,
} from "../types.js";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Assembles the context for the MOST RECENT failure on this order. Callers
 * (the webhook handler, block 4's live path, the eval runner) already know
 * which order just failed — this function turns "an order and a point in
 * time" into everything a Strategy needs to propose.
 */
export function assembleEpisodeContext(db: Db, orderId: string, now: Date): EpisodeContext {
  const order = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!order) throw new Error(`assembleEpisodeContext: no order ${orderId}`);

  const latestFailure = db
    .select()
    .from(schema.failures)
    .where(eq(schema.failures.orderId, orderId))
    .orderBy(desc(schema.failures.attemptNumber))
    .limit(1)
    .get();
  if (!latestFailure) throw new Error(`assembleEpisodeContext: no failure recorded for order ${orderId}`);

  const failure: FailureEvent = {
    id: latestFailure.id,
    orderId: latestFailure.orderId,
    eventId: latestFailure.eventId,
    razorpayPaymentId: latestFailure.razorpayPaymentId,
    errorCode: latestFailure.errorCode,
    errorSource: latestFailure.errorSource,
    errorStep: latestFailure.errorStep,
    errorReason: latestFailure.errorReason,
    category: latestFailure.category,
    attemptNumber: latestFailure.attemptNumber,
    occurredAt: latestFailure.occurredAt,
  };

  const priorEpisodes = db
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.orderId, orderId))
    .orderBy(schema.episodes.attemptNumber)
    .all();

  const priorAttempts: PriorAttempt[] = priorEpisodes.map((ep) => ({
    attemptNumber: ep.attemptNumber,
    reasoning: ep.reasoning,
    proposal: ep.proposal as unknown as Proposal,
    verdict: { kind: ep.verdictKind, ruleId: ep.verdictRuleId, reason: ep.verdictReason },
    outcome: ep.outcome,
  }));

  const executedAttempts = priorEpisodes.filter(
    (ep) => (ep.execResult as { ok?: boolean } | null)?.ok === true,
  ).length;
  const executedContacts = priorEpisodes.filter((ep) => {
    const p = ep.proposal as unknown as Proposal;
    const executed = (ep.execResult as { ok?: boolean } | null)?.ok === true;
    return executed && (p.type === "PAYMENT_LINK" || p.type === "NUDGE");
  }).length;

  const orderTyped: Order = {
    id: order.id,
    razorpayOrderId: order.razorpayOrderId,
    razorpaySubscriptionId: order.razorpaySubscriptionId,
    customerId: order.customerId,
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    createdAt: order.createdAt,
  };

  const history = buildCustomerHistory(db, order.customerId, orderId);

  return {
    failureContext: {
      order: orderTyped,
      failure,
      attemptNumber: latestFailure.attemptNumber,
      priorAttempts,
      economics: {
        attemptsRemaining: Math.max(0, 3 - executedAttempts),
        contactsRemaining: Math.max(0, 2 - executedContacts),
        attemptCostPaise: ATTEMPT_COST_PAISE,
        amountAtStakePaise: order.amount,
      },
    },
    history,
    now,
  };
}

function buildCustomerHistory(db: Db, customerId: string, excludeOrderId: string): CustomerHistory {
  const paidOrders = db
    .select()
    .from(schema.orders)
    .where(and(eq(schema.orders.customerId, customerId), eq(schema.orders.status, "paid")))
    .orderBy(desc(schema.orders.createdAt))
    .limit(5)
    .all()
    .filter((o) => o.id !== excludeOrderId);

  return {
    customerId,
    isFirstTime: paidOrders.length === 0,
    lastPayments: paidOrders.map((o) => ({
      paidAt: o.createdAt,
      amount: o.amount,
      method: "unknown", // not tracked in this schema — see module doc
      hourOfDayIst: istHourOfDay(new Date(o.createdAt)),
    })),
    workingInstrument: null, // not tracked in this schema — see module doc
  };
}
