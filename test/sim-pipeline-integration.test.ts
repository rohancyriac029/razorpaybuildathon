// Spec §3.1: "the eval is run(*, VirtualScheduler, SimWorld, policy) for
// each of the five strategies." This proves that claim holds for real —
// not per-piece (already covered by sim-world.test.ts, strategies-*.test.ts)
// but the whole chain: decide() -> VirtualScheduler.scheduleAt() ->
// advance() -> executeApproved() -> SimWorld resolving against ground
// truth -> the right strategies recovering more than the wrong ones.
//
// Block 8 (the eval runner) will do this at scale (120 scenarios x 5
// strategies x 3 seeds) with metrics and a markdown table; this is the
// narrower claim that the pipeline itself coheres before that aggregation
// layer is built on top of it.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import { decide, executeApproved } from "../src/run.js";
import { RulesPolicyEngine } from "../src/policy/engine.js";
import { DEFAULT_POLICY_CONFIG } from "../src/policy/rules.js";
import { VirtualScheduler } from "../src/scheduler/virtual.js";
import { SimWorld } from "../src/world/sim-world.js";
import { ScenarioRegistry } from "../src/eval/scenario-registry.js";
import { CONFIG_A } from "../src/eval/generator-config.js";
import { generateScenarios } from "../src/eval/generator.js";
import { NoRetryStrategy } from "../src/strategies/no-retry.js";
import { FixedIntervalStrategy } from "../src/strategies/fixed-interval.js";
import { OracleStrategy } from "../src/strategies/oracle.js";
import { makeEpisodeLogger } from "../src/persistence/episode-logger.js";
import type { Strategy } from "../src/ports/strategy.js";
import type { EpisodeContext } from "../src/types.js";
import type { Scenario } from "../src/eval/scenario.js";

const ANCHOR = new Date("2026-09-02T10:00:00Z");

/** Runs one scenario through one strategy to completion (decide -> scheduled execute), returns whether the order ended up paid. */
async function runOneScenario(
  db: ReturnType<typeof makeTestDb>,
  scenario: Scenario,
  strategy: Strategy,
  registry: ScenarioRegistry,
): Promise<boolean> {
  const orderId = `order_${scenario.id}_${strategy.name}`;
  db.insert(schema.customers).values({ id: `cust_${orderId}`, razorpayCustomerId: `rzp_${orderId}`, createdAt: ANCHOR.toISOString() }).run();
  db.insert(schema.orders)
    .values({
      id: orderId,
      razorpayOrderId: `rzp_${orderId}`,
      razorpaySubscriptionId: null,
      customerId: `cust_${orderId}`,
      amount: scenario.amountPaise,
      currency: "INR",
      status: "attempted",
      createdAt: ANCHOR.toISOString(),
    })
    .run();
  registry.register(orderId, scenario);

  const ctx: EpisodeContext = {
    failureContext: {
      order: {
        id: orderId,
        razorpayOrderId: `rzp_${orderId}`,
        razorpaySubscriptionId: null,
        customerId: `cust_${orderId}`,
        amount: scenario.amountPaise,
        currency: "INR",
        status: "attempted",
        createdAt: ANCHOR.toISOString(),
      },
      failure: {
        id: `fail_${orderId}`,
        orderId,
        eventId: `evt_${orderId}`,
        razorpayPaymentId: null,
        errorCode: null,
        errorSource: null,
        errorStep: null,
        errorReason: scenario.errorReason,
        category: scenario.category,
        attemptNumber: 1,
        occurredAt: scenario.occurredAt.toISOString(),
      },
      attemptNumber: 1,
      priorAttempts: [],
      economics: { attemptsRemaining: 3, contactsRemaining: 2, attemptCostPaise: 200, amountAtStakePaise: scenario.amountPaise },
    },
    history: {
      customerId: `cust_${orderId}`,
      isFirstTime: scenario.isFirstTime,
      lastPayments: scenario.history.map((h) => ({ paidAt: h.paidAt, amount: h.amount, method: "unknown", hourOfDayIst: h.hourOfDayIst })),
      workingInstrument: null,
    },
    now: ANCHOR,
  };

  const scheduler = new VirtualScheduler(ANCHOR);
  const world = new SimWorld(db, CONFIG_A, registry);
  const policy = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);
  const log = makeEpisodeLogger(db, strategy.name, `run_${randomUUID()}`);

  scheduler.onFire(async (intentId, at) => {
    // Rehydrate like production does (spec §3.4) rather than closing over state.
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
    void at;
  });

  const decision = await decide(strategy, policy, ctx, log);
  if (decision.intentId) {
    const sendAt = "sendAt" in decision.proposal ? new Date(decision.proposal.sendAt) : ANCHOR;
    await scheduler.scheduleAt(sendAt, decision.intentId);
    await scheduler.advance(new Date(sendAt.getTime() + 60_000));
  }

  const finalOrder = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  return finalOrder?.status === "paid";
}

describe("full pipeline against SimWorld, across strategies", () => {
  it("Oracle recovers strictly more scenarios than NoRetry (which recovers none)", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 30, 99, ANCHOR).filter((s) => s.category !== "TERMINAL");

    let noRetryRecovered = 0;
    let oracleRecovered = 0;

    for (const scenario of scenarios) {
      const registryNoRetry = new ScenarioRegistry();
      if (await runOneScenario(db, scenario, new NoRetryStrategy(), registryNoRetry)) noRetryRecovered++;

      const registryOracle = new ScenarioRegistry();
      if (await runOneScenario(db, scenario, new OracleStrategy(registryOracle, CONFIG_A), registryOracle)) oracleRecovered++;
    }

    expect(noRetryRecovered).toBe(0); // NoRetry only ever escalates — never executes, never recovers
    expect(oracleRecovered).toBeGreaterThan(0);
    expect(oracleRecovered).toBeGreaterThan(noRetryRecovered);
  });

  it("FixedInterval's blind TERMINAL retry is actually caught by the real policy engine (P3), not just asserted", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 30, 99, ANCHOR).filter((s) => s.category === "TERMINAL");
    expect(scenarios.length).toBeGreaterThan(0);

    for (const scenario of scenarios) {
      const orderId = `order_${scenario.id}_fixed-24h`;
      db.insert(schema.customers).values({ id: `cust_${orderId}`, razorpayCustomerId: `rzp_${orderId}`, createdAt: ANCHOR.toISOString() }).run();
      db.insert(schema.orders)
        .values({
          id: orderId,
          razorpayOrderId: `rzp_${orderId}`,
          razorpaySubscriptionId: null,
          customerId: `cust_${orderId}`,
          amount: scenario.amountPaise,
          currency: "INR",
          status: "attempted",
          createdAt: ANCHOR.toISOString(),
        })
        .run();

      const ctx: EpisodeContext = {
        failureContext: {
          order: { id: orderId, razorpayOrderId: `rzp_${orderId}`, razorpaySubscriptionId: null, customerId: `cust_${orderId}`, amount: scenario.amountPaise, currency: "INR", status: "attempted", createdAt: ANCHOR.toISOString() },
          failure: { id: `fail_${orderId}`, orderId, eventId: `evt_${orderId}`, razorpayPaymentId: null, errorCode: null, errorSource: null, errorStep: null, errorReason: scenario.errorReason, category: "TERMINAL", attemptNumber: 1, occurredAt: scenario.occurredAt.toISOString() },
          attemptNumber: 1,
          priorAttempts: [],
          economics: { attemptsRemaining: 3, contactsRemaining: 2, attemptCostPaise: 200, amountAtStakePaise: scenario.amountPaise },
        },
        history: { customerId: `cust_${orderId}`, isFirstTime: true, lastPayments: [], workingInstrument: null },
        now: ANCHOR,
      };

      const policy = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);
      const log = makeEpisodeLogger(db, "fixed-24h", null);
      const decision = await decide(new FixedIntervalStrategy(), policy, ctx, log);

      expect(decision.proposal.type).toBe("PAYMENT_LINK"); // it DID propose a blind retry on TERMINAL
      expect(decision.verdict.kind).toBe("REJECT"); // the policy engine caught it
      expect(decision.verdict.ruleId).toBe("P3");
      expect(decision.intentId).toBeNull(); // nothing was scheduled for execution
    }
  });
});
