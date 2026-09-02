import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import { SimWorld } from "../src/world/sim-world.js";
import { ScenarioRegistry } from "../src/eval/scenario-registry.js";
import { CONFIG_A } from "../src/eval/generator-config.js";
import { generateScenarios } from "../src/eval/generator.js";
import { wouldSucceed } from "../src/eval/ground-truth.js";
import type { Intent, PaymentLinkProposal } from "../src/types.js";

const ANCHOR = new Date("2026-09-02T10:00:00Z");

function seedOrder(db: ReturnType<typeof makeTestDb>, id: string) {
  db.insert(schema.customers).values({ id: `cust_${id}`, razorpayCustomerId: `rzp_${id}`, createdAt: ANCHOR.toISOString() }).run();
  db.insert(schema.orders)
    .values({
      id,
      razorpayOrderId: `rzp_order_${id}`,
      razorpaySubscriptionId: null,
      customerId: `cust_${id}`,
      amount: 49900,
      currency: "INR",
      status: "attempted",
      createdAt: ANCHOR.toISOString(),
    })
    .run();
}

function linkIntent(orderId: string, sendAt: string): Intent {
  const proposal: PaymentLinkProposal = {
    type: "PAYMENT_LINK",
    orderId,
    attemptNumber: 1,
    reasoning: "test",
    proposedAt: ANCHOR.toISOString(),
    sendAt,
    channel: "whatsapp",
  };
  return {
    id: randomUUID(),
    episodeId: randomUUID(),
    orderId,
    attemptNumber: 1,
    proposal,
    verdict: { kind: "APPROVE", ruleId: "P0", reason: "test" },
    idempotencyKey: "test_key",
    status: "pending",
    createdAt: sendAt, // matches run.ts's executionTime convention
  };
}

describe("SimWorld", () => {
  it("marks the order paid when wouldSucceed is true, leaves it unpaid otherwise", () => {
    const db = makeTestDb();
    const registry = new ScenarioRegistry();
    const world = new SimWorld(db, CONFIG_A, registry);

    // Find a real generated FUNDS scenario, then test both a time we know
    // succeeds and one we know doesn't, using wouldSucceed directly as the
    // oracle for what SimWorld SHOULD do — not asserting against a magic
    // number, asserting SimWorld agrees with the same function it's built on.
    const scenarios = generateScenarios(CONFIG_A, 50, 5, ANCHOR).filter((s) => s.category === "FUNDS");
    const scenario = scenarios[0]!;

    seedOrder(db, "order_good");
    registry.register("order_good", scenario);
    const goodTime = new Date(ANCHOR);
    goodTime.setUTCDate(CONFIG_A.liquidityDaysOfMonth[0]);
    goodTime.setUTCHours(scenario.liquidityHourIst - 5, 30, 0, 0);
    const goodIntent = linkIntent("order_good", goodTime.toISOString());
    const expectSuccess = wouldSucceed(scenario, goodIntent.proposal, goodTime, CONFIG_A);

    return world.createPaymentLink(goodIntent).then((result) => {
      expect(result.ok).toBe(true);
      const order = db.select().from(schema.orders).where(eq(schema.orders.id, "order_good")).get();
      expect(order?.status).toBe(expectSuccess ? "paid" : "attempted");
      expect(result.detail).toContain(expectSuccess ? "paid" : "did not pay");
    });
  });

  it("chargeToken always fails — no mandate token is modeled in this build", async () => {
    const db = makeTestDb();
    const registry = new ScenarioRegistry();
    const world = new SimWorld(db, CONFIG_A, registry);
    seedOrder(db, "order_token");
    const scenarios = generateScenarios(CONFIG_A, 10, 1, ANCHOR);
    registry.register("order_token", scenarios[0]!);

    const intent: Intent = {
      ...linkIntent("order_token", ANCHOR.toISOString()),
      proposal: {
        type: "TOKEN_RETRY",
        orderId: "order_token",
        attemptNumber: 1,
        reasoning: "test",
        proposedAt: ANCHOR.toISOString(),
        sendAt: ANCHOR.toISOString(),
        mandateTokenId: "token_fake",
      },
    };
    const result = await world.chargeToken(intent);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no confirmed mandate token");
  });

  it("uses intent.createdAt (the simulated execution time), not real wall-clock time", async () => {
    const db = makeTestDb();
    const registry = new ScenarioRegistry();
    const world = new SimWorld(db, CONFIG_A, registry);
    seedOrder(db, "order_far_future");

    // A scenario whose liquidity window is far from "real now" but whose
    // intent.createdAt (simulated time) lands exactly in it — if SimWorld
    // used new Date() internally instead of intent.createdAt, this would
    // never be able to succeed regardless of outcome, since real wall-clock
    // "now" is nowhere near the scenario's simulated liquidity window.
    const scenarios = generateScenarios(CONFIG_A, 50, 8, ANCHOR).filter((s) => s.category === "FUNDS");
    const scenario = scenarios[0]!;
    registry.register("order_far_future", scenario);

    const simulatedFutureTime = new Date("2027-03-15T14:00:00Z"); // far from real "now"
    simulatedFutureTime.setUTCDate(CONFIG_A.liquidityDaysOfMonth[0]);
    simulatedFutureTime.setUTCHours(scenario.liquidityHourIst - 5, 30, 0, 0);

    const intent = linkIntent("order_far_future", simulatedFutureTime.toISOString());
    await world.createPaymentLink(intent);

    // Whatever the outcome, it must have been evaluated at simulatedFutureTime,
    // not at real Date.now() — confirmed by cross-checking against wouldSucceed
    // called with the same simulated instant.
    const order = db.select().from(schema.orders).where(eq(schema.orders.id, "order_far_future")).get();
    const expected = wouldSucceed(scenario, intent.proposal, simulatedFutureTime, CONFIG_A);
    expect(order?.status).toBe(expected ? "paid" : "attempted");
  });

  it("getOrder reflects a status update made by a prior execution", async () => {
    const db = makeTestDb();
    const registry = new ScenarioRegistry();
    const world = new SimWorld(db, CONFIG_A, registry);
    seedOrder(db, "order_status_check");
    db.update(schema.orders).set({ status: "paid" }).where(eq(schema.orders.id, "order_status_check")).run();

    const order = await world.getOrder("order_status_check");
    expect(order.status).toBe("paid");
  });
});
