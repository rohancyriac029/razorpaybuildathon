// Proves the gap found during block 4 is actually closed: execution must
// wait for the proposal's sendAt, driven by the Scheduler port, not happen
// immediately at decision time. This is what makes VirtualScheduler.advance()
// (block 3) load-bearing for the eval (blocks 7/8) rather than dead code.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { decide, executeApproved } from "../src/run.js";
import { RulesPolicyEngine } from "../src/policy/engine.js";
import { DEFAULT_POLICY_CONFIG } from "../src/policy/rules.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { VirtualScheduler } from "../src/scheduler/virtual.js";
import { makeTestDb } from "./helpers/test-db.js";
import { FakeWorld } from "./helpers/fake-world.js";
import * as schema from "../src/db/schema.js";
import { makeEpisodeLogger } from "../src/persistence/episode-logger.js";
import type { EpisodeContext, Order } from "../src/types.js";

const NOW = new Date("2026-09-02T10:00:00Z"); // 15:30 IST, safe daytime

function seedOrderAndFailure(db: ReturnType<typeof makeTestDb>) {
  db.insert(schema.customers).values({ id: "cust_1", razorpayCustomerId: "rzp_cust_1", createdAt: NOW.toISOString() }).run();
  db.insert(schema.orders)
    .values({
      id: "order_1",
      razorpayOrderId: "rzp_order_1",
      razorpaySubscriptionId: null,
      customerId: "cust_1",
      amount: 49900,
      currency: "INR",
      status: "attempted",
      createdAt: NOW.toISOString(),
    })
    .run();
  db.insert(schema.webhookEvents).values({ eventId: "evt_1", type: "payment.failed", payload: {}, receivedAt: NOW.toISOString() }).run();
  db.insert(schema.failures)
    .values({
      id: "fail_1",
      orderId: "order_1",
      eventId: "evt_1",
      razorpayPaymentId: "pay_1",
      errorCode: "GATEWAY_ERROR",
      errorSource: "customer",
      errorReason: "insufficient_funds", // FUNDS -> RulesStrategy proposes a +24h or +48h wait
      errorStep: null,
      category: "FUNDS",
      attemptNumber: 1,
      occurredAt: NOW.toISOString(),
    })
    .run();
}

function ctx(order: Order): EpisodeContext {
  return {
    failureContext: {
      order,
      failure: {
        id: "fail_1",
        orderId: "order_1",
        eventId: "evt_1",
        razorpayPaymentId: "pay_1",
        errorCode: "GATEWAY_ERROR",
        errorSource: "customer",
        errorStep: null,
        errorReason: "insufficient_funds",
        category: "FUNDS",
        attemptNumber: 1,
        occurredAt: NOW.toISOString(),
      },
      attemptNumber: 1,
      priorAttempts: [],
      economics: { attemptsRemaining: 3, contactsRemaining: 2, attemptCostPaise: 200, amountAtStakePaise: 49900 },
    },
    history: { customerId: "cust_1", isFirstTime: true, lastPayments: [], workingInstrument: null },
    now: NOW,
  };
}

describe("decide() / executeApproved(): timing is respected, not collapsed", () => {
  it("does not execute at decision time; only executes once the scheduler reaches sendAt", async () => {
    const db = makeTestDb();
    seedOrderAndFailure(db);
    const order: Order = {
      id: "order_1",
      razorpayOrderId: "rzp_order_1",
      razorpaySubscriptionId: null,
      customerId: "cust_1",
      amount: 49900,
      currency: "INR",
      status: "attempted",
      createdAt: NOW.toISOString(),
    };

    const strategy = new RulesStrategy(); // FUNDS, day 2 -> +48h wait (outside salary-cycle window)
    const policy = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);
    const world = new FakeWorld(db);
    const logger = makeEpisodeLogger(db, strategy.name, null);

    const decision = await decide(strategy, policy, ctx(order), logger);
    expect(decision.verdict.kind).toBe("APPROVE");
    expect(decision.intentId).not.toBeNull();
    expect(decision.proposal.type).toBe("PAYMENT_LINK");
    const sendAt = new Date((decision.proposal as { sendAt: string }).sendAt);
    expect(sendAt.getTime()).toBeGreaterThan(NOW.getTime()); // genuinely in the future

    // The load-bearing assertion: nothing executed yet.
    expect(world.calls).toHaveLength(0);

    const episodeAfterDecide = db.select().from(schema.episodes).where(eq(schema.episodes.orderId, "order_1")).all();
    expect(episodeAfterDecide).toHaveLength(1);
    expect(episodeAfterDecide[0]!.execResult).toBeNull();
    expect(episodeAfterDecide[0]!.outcome).toBe("pending");

    // Drive a VirtualScheduler to just short of sendAt: still nothing executes.
    const scheduler = new VirtualScheduler(NOW);
    scheduler.onFire(async (intentId) => {
      if (intentId === decision.intentId) {
        await executeApproved(world, decision.intentId!, decision.proposal, logger, decision.verdict, decision.contextHash);
      }
    });
    await scheduler.scheduleAt(sendAt, decision.intentId!);

    await scheduler.advance(new Date(sendAt.getTime() - 60_000)); // one minute short
    expect(world.calls).toHaveLength(0);

    // Advance past sendAt: NOW it executes.
    await scheduler.advance(sendAt);
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]!.method).toBe("createPaymentLink");

    // The SAME episode row was updated, not duplicated.
    const episodesAfterExecute = db.select().from(schema.episodes).where(eq(schema.episodes.orderId, "order_1")).all();
    expect(episodesAfterExecute).toHaveLength(1);
    expect(episodesAfterExecute[0]!.id).toBe(episodeAfterDecide[0]!.id);
    expect(episodesAfterExecute[0]!.execResult).not.toBeNull();

    const intents = db.select().from(schema.intents).where(eq(schema.intents.orderId, "order_1")).all();
    expect(intents).toHaveLength(1); // upserted, not duplicated
    expect(intents[0]!.status).toBe("executed");
  });

  it("run() still executes immediately (unchanged behavior for the demo/production convenience path)", async () => {
    const db = makeTestDb();
    seedOrderAndFailure(db);
    const order: Order = {
      id: "order_1",
      razorpayOrderId: "rzp_order_1",
      razorpaySubscriptionId: null,
      customerId: "cust_1",
      amount: 49900,
      currency: "INR",
      status: "attempted",
      createdAt: NOW.toISOString(),
    };

    const { run } = await import("../src/run.js");
    const strategy = new RulesStrategy();
    const policy = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);
    const world = new FakeWorld(db);
    const logger = makeEpisodeLogger(db, strategy.name, null);
    const scheduler = new VirtualScheduler(NOW);

    const entry = await run(strategy, scheduler, world, policy, ctx(order), logger);
    expect(entry.execResult).not.toBeNull();
    expect(world.calls).toHaveLength(1); // executed synchronously, as before
  });
});
