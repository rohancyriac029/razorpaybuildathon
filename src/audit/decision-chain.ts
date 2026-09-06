// Spec §6 block 9: "Decision detail with full reasoning chain and policy
// verdict." Reads real production/demo episodes (episodes.runId IS NULL —
// eval episodes carry a runId, block 8) so the audit page shows the live
// demo's decisions, not the eval's 1000+ synthetic orders drowning them
// out. Spec §3's own framing: "gives your audit page a decision chain to
// render" — attempt 1's reasoning next to attempt 2's, with the verdict
// and outcome for each.
import { desc, eq, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface OrderSummary {
  orderId: string;
  razorpayOrderId: string;
  amount: number;
  currency: string;
  status: string;
  attempts: number;
  latestStrategy: string;
  latestOutcome: string | null;
}

export interface DecisionChainStep {
  attemptNumber: number;
  strategyName: string;
  contextHash: string;
  reasoning: string;
  proposal: unknown;
  verdictKind: string;
  verdictRuleId: string;
  verdictReason: string;
  execResult: unknown;
  outcome: string | null;
  createdAt: string;
  /**
   * The classified failure this attempt was responding to, when one is on
   * record. Carried so the audit UI can render the full pipeline — what
   * arrived and how the taxonomy bucketed it — rather than starting the story
   * at the proposal, which is halfway through. Null for attempts with no
   * matching failure row (e.g. the buyer-agent's PURCHASE path, which has no
   * failure by construction).
   */
  failure: { category: string; errorReason: string | null; occurredAt: string } | null;
}

export interface DecisionChain {
  order: OrderSummary;
  steps: DecisionChainStep[];
}

/** Most recent production/demo orders with at least one non-eval episode. */
export function listOrdersWithEpisodes(db: Db, limit = 25): OrderSummary[] {
  const episodeRows = db
    .select()
    .from(schema.episodes)
    .where(isNull(schema.episodes.runId))
    .orderBy(desc(schema.episodes.createdAt))
    .all();

  const byOrder = new Map<string, typeof episodeRows>();
  for (const ep of episodeRows) {
    const arr = byOrder.get(ep.orderId) ?? [];
    arr.push(ep);
    byOrder.set(ep.orderId, arr);
  }

  // byOrder's insertion order already reflects recency: episodeRows was
  // fetched ORDER BY createdAt DESC, so each orderId's first appearance in
  // the loop above is its most recently active episode. Map preserves
  // insertion order, so iterating it here needs no further sorting.
  const summaries: OrderSummary[] = [];
  for (const [orderId, eps] of byOrder) {
    const order = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
    if (!order) continue;
    const latest = eps[0]!; // most recent, per the ordering above
    summaries.push({
      orderId,
      razorpayOrderId: order.razorpayOrderId,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      attempts: eps.length,
      latestStrategy: latest.strategyName,
      latestOutcome: latest.outcome,
    });
  }

  return summaries.slice(0, limit);
}

export function getDecisionChain(db: Db, orderId: string): DecisionChain | null {
  const order = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!order) return null;

  const episodeRows = db
    .select()
    .from(schema.episodes)
    .where(eq(schema.episodes.orderId, orderId))
    .orderBy(schema.episodes.attemptNumber)
    .all();

  // Indexed by attemptNumber: an attempt's proposal answers the failure that
  // carries the same attempt number (both are written by the same pipeline
  // pass), so this is a lookup rather than a join on time.
  const failureRows = db
    .select()
    .from(schema.failures)
    .where(eq(schema.failures.orderId, orderId))
    .all();
  const failureByAttempt = new Map(failureRows.map((f) => [f.attemptNumber, f]));

  const steps: DecisionChainStep[] = episodeRows.map((ep) => {
    const f = failureByAttempt.get(ep.attemptNumber);
    return {
      attemptNumber: ep.attemptNumber,
      strategyName: ep.strategyName,
      contextHash: ep.contextHash,
      reasoning: ep.reasoning,
      proposal: ep.proposal,
      verdictKind: ep.verdictKind,
      verdictRuleId: ep.verdictRuleId,
      verdictReason: ep.verdictReason,
      execResult: ep.execResult,
      outcome: ep.outcome,
      createdAt: ep.createdAt,
      failure: f ? { category: f.category, errorReason: f.errorReason, occurredAt: f.occurredAt } : null,
    };
  });

  return {
    order: {
      orderId,
      razorpayOrderId: order.razorpayOrderId,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      attempts: steps.length,
      latestStrategy: steps[steps.length - 1]?.strategyName ?? "",
      latestOutcome: steps[steps.length - 1]?.outcome ?? null,
    },
    steps,
  };
}
