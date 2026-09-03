// Spec §6 block 8: runs ONE scenario through ONE strategy, for one seed,
// across up to 3 attempts — exercising the real "episode = the order"
// multi-step design (spec §3), not a single isolated decision. Reuses
// assembleEpisodeContext (block 3) for real, so the eval drives the exact
// context-construction code production does, not a parallel path.
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { decide, executeApproved } from "../run.js";
import { assembleEpisodeContext } from "../context/assemble.js";
import { RulesPolicyEngine } from "../policy/engine.js";
import { DEFAULT_POLICY_CONFIG } from "../policy/rules.js";
import { VirtualScheduler } from "../scheduler/virtual.js";
import { SimWorld } from "../world/sim-world.js";
import { ScenarioRegistry } from "./scenario-registry.js";
import { makeEpisodeLogger } from "../persistence/episode-logger.js";
import { ATTEMPT_COST_PAISE, CONTACT_GOODWILL_COST_PAISE } from "../economics/constants.js";
import { tokenCostPaise } from "./llm-pricing.js";
import { AgentStrategy } from "../agent/agent-strategy.js";
import type { Strategy } from "../ports/strategy.js";
import type { GeneratorConfig } from "./generator-config.js";
import type { Scenario } from "./scenario.js";

type Db = BetterSQLite3Database<typeof schema>;

const MAX_ATTEMPTS = 3; // matches P1's lifetime cap
const ATTEMPT_GAP_MS = 24 * 3_600_000; // spacing between simulated repeat failures on the same order — comfortably clears P2's 6h minimum

export interface EpisodeRunResult {
  scenarioId: string;
  strategyName: string;
  seed: number;
  recovered: boolean;
  netRecoveredPaise: number;
  wastedAttempts: number;
  contactsUsed: number;
  terminalRetryProposed: number;
  terminalRetryExecuted: number;
  offersProposed: number;
  offersSent: number;
  timeToRecoveryMs: number | null;
  llmCostPaise: number;
}

/**
 * `registry` is caller-provided rather than created internally: OracleStrategy
 * is constructed with a ScenarioRegistry reference BEFORE runEpisode computes
 * this episode's orderId, so the only way for the oracle to see ground truth
 * for the right order is for both to share the same registry object —
 * runEpisode registers the scenario into it under whatever id it decides,
 * and OracleStrategy looks it up by ctx.failureContext.order.id at propose()
 * time, after that registration has already happened. A caller not running
 * Oracle can pass a fresh throwaway registry each call; it costs nothing.
 */
export async function runEpisode(
  db: Db,
  scenario: Scenario,
  strategy: Strategy,
  config: GeneratorConfig,
  seed: number,
  runId: string,
  registry: ScenarioRegistry,
): Promise<EpisodeRunResult> {
  // Scoped to runId, not just config: the eval DB persists across process
  // invocations (by design, for the LLM cache — see eval-db.ts), so a
  // second real run against the same DB file must not collide on primary
  // keys with the first, and must not inherit a stale order.status='paid'
  // from a PRIOR run's recovery, which would corrupt this run's P8
  // recheck before any execution even happens. The LLM cache is keyed
  // independently by request content (llm/cache.ts), not by orderId, so
  // this doesn't touch cache-hit behavior at all.
  const orderId = `order_${runId}_${config.name}_${scenario.id}_${strategy.name}_${seed}`;

  db.insert(schema.customers)
    .values({ id: `cust_${orderId}`, razorpayCustomerId: `rzp_${orderId}`, createdAt: scenario.occurredAt.toISOString() })
    .run();
  db.insert(schema.orders)
    .values({
      id: orderId,
      razorpayOrderId: `rzp_${orderId}`,
      razorpaySubscriptionId: null,
      customerId: `cust_${orderId}`,
      amount: scenario.amountPaise,
      currency: "INR",
      status: "attempted",
      createdAt: scenario.occurredAt.toISOString(),
    })
    .run();

  registry.register(orderId, scenario);
  const world = new SimWorld(db, config, registry);
  const policy = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);
  const log = makeEpisodeLogger(db, strategy.name, runId);
  const scheduler = new VirtualScheduler(scenario.occurredAt);

  scheduler.onFire(async (intentId) => {
    const intentRow = db.select({ episodeId: schema.intents.episodeId }).from(schema.intents).where(eq(schema.intents.id, intentId)).get();
    if (!intentRow) return;
    const episode = db.select().from(schema.episodes).where(eq(schema.episodes.id, intentRow.episodeId)).get();
    if (!episode) return;
    await executeApproved(
      world,
      intentId,
      episode.proposal as never,
      log,
      { kind: episode.verdictKind, ruleId: episode.verdictRuleId, reason: episode.verdictReason },
      episode.contextHash,
    );
  });

  let recovered = false;
  let wastedAttempts = 0;
  let contactsUsed = 0;
  let terminalRetryProposed = 0;
  let terminalRetryExecuted = 0;
  let offersProposed = 0;
  let offersSent = 0; // structurally always 0 — see tools.ts's P14 enforcement (block 6)
  let timeToRecoveryMs: number | null = null;
  let llmInputTokens = 0;
  let llmOutputTokens = 0;
  let executedAttemptCount = 0;

  for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber++) {
    const failureId = `fail_${orderId}_${attemptNumber}`;
    const eventId = `evt_${orderId}_${attemptNumber}`;
    const occurredAt = new Date(scenario.occurredAt.getTime() + (attemptNumber - 1) * ATTEMPT_GAP_MS);

    // failures.eventId references webhook_events.eventId (block 1's dedupe
    // table) — a simulated failure needs a matching row, same as a real
    // webhook always gets one via dedupeAndStore before processPaymentFailed.
    db.insert(schema.webhookEvents)
      .values({ eventId, type: "payment.failed", payload: {}, receivedAt: occurredAt.toISOString() })
      .run();

    db.insert(schema.failures)
      .values({
        id: failureId,
        orderId,
        eventId,
        razorpayPaymentId: null,
        errorCode: null,
        errorSource: null,
        errorStep: null,
        errorReason: scenario.errorReason,
        category: scenario.category,
        attemptNumber,
        occurredAt: occurredAt.toISOString(),
      })
      .run();

    const ctx = assembleEpisodeContext(db, orderId, occurredAt);
    const decision = await decide(strategy, policy, ctx, log);

    if (strategy instanceof AgentStrategy) {
      llmInputTokens += strategy.lastUsage.inputTokens;
      llmOutputTokens += strategy.lastUsage.outputTokens;
      if (strategy.lastOfferAttempted) offersProposed++;
    }

    const isRetryOrContact = decision.proposal.type === "TOKEN_RETRY" || decision.proposal.type === "PAYMENT_LINK" || decision.proposal.type === "NUDGE";
    if (scenario.category === "TERMINAL" && isRetryOrContact) {
      terminalRetryProposed++;
      if (decision.intentId) terminalRetryExecuted++; // should never happen — P3 catches it (see run-episode.test.ts)
    }

    if (decision.proposal.type === "MARK_TERMINAL") break; // correctly gave up, nothing more to do
    if (decision.proposal.type === "ESCALATE" && !decision.intentId) break; // gave up (escalate is never execution-bound)

    if (!decision.intentId) {
      // REJECTed by policy: nothing executed, no cost. In reality the
      // underlying charge can still fail again later (next billing
      // attempt); the loop continues to the next simulated attempt.
      continue;
    }

    const sendAt = "sendAt" in decision.proposal ? new Date(decision.proposal.sendAt) : occurredAt;
    await scheduler.scheduleAt(sendAt, decision.intentId);
    await scheduler.advance(new Date(sendAt.getTime() + 60_000));
    executedAttemptCount++;
    if (isRetryOrContact && (decision.proposal.type === "PAYMENT_LINK" || decision.proposal.type === "NUDGE")) contactsUsed++;

    const order = db.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, orderId)).get();
    if (order?.status === "paid") {
      recovered = true;
      timeToRecoveryMs = sendAt.getTime() - scenario.occurredAt.getTime();
      break;
    }
    wastedAttempts++;
  }

  const llmCostPaise = tokenCostPaise(llmInputTokens, llmOutputTokens);
  const netRecoveredPaise =
    (recovered ? scenario.amountPaise : 0) - executedAttemptCount * ATTEMPT_COST_PAISE - contactsUsed * CONTACT_GOODWILL_COST_PAISE;

  return {
    scenarioId: scenario.id,
    strategyName: strategy.name,
    seed,
    recovered,
    netRecoveredPaise,
    wastedAttempts,
    contactsUsed,
    terminalRetryProposed,
    terminalRetryExecuted,
    offersProposed,
    offersSent,
    timeToRecoveryMs,
    llmCostPaise,
  };
}
