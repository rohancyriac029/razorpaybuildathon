import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import { listOrdersWithEpisodes, getDecisionChain } from "../src/audit/decision-chain.js";
import { runFullEval } from "../src/eval/orchestrator.js";
import { CONFIG_A } from "../src/eval/generator-config.js";

function seedProductionOrder(db: ReturnType<typeof makeTestDb>, orderId: string, createdAt: string) {
  db.insert(schema.customers).values({ id: `cust_${orderId}`, razorpayCustomerId: `rzp_${orderId}`, createdAt }).run();
  db.insert(schema.orders)
    .values({ id: orderId, razorpayOrderId: `rzp_${orderId}`, razorpaySubscriptionId: null, customerId: `cust_${orderId}`, amount: 49900, currency: "INR", status: "attempted", createdAt })
    .run();
}

type Outcome = "recovered" | "failed_again" | "no_response" | "pending" | "escalated" | "rejected" | null;

function seedEpisode(
  db: ReturnType<typeof makeTestDb>,
  args: { id: string; orderId: string; attemptNumber: number; strategyName: string; reasoning: string; outcome: Outcome; createdAt: string; runId?: string | null },
) {
  db.insert(schema.episodes)
    .values({
      id: args.id,
      orderId: args.orderId,
      attemptNumber: args.attemptNumber,
      strategyName: args.strategyName,
      contextHash: "hash",
      reasoning: args.reasoning,
      proposal: { type: "PAYMENT_LINK" },
      verdictKind: "APPROVE",
      verdictRuleId: "P0",
      verdictReason: "no rule objected",
      execResult: null,
      outcome: args.outcome,
      runId: args.runId ?? null,
      createdAt: args.createdAt,
    })
    .run();
}

describe("listOrdersWithEpisodes", () => {
  it("only includes production episodes (runId IS NULL), excluding eval episodes", async () => {
    const db = makeTestDb();
    seedProductionOrder(db, "order_prod1", "2026-09-02T10:00:00Z");
    seedEpisode(db, { id: "ep1", orderId: "order_prod1", attemptNumber: 1, strategyName: "salvage-agent", reasoning: "bet on transient", outcome: "pending", createdAt: "2026-09-02T10:00:00Z" });

    // Eval episodes carry a runId — must not appear in this list.
    await runFullEval({ db, config: CONFIG_A, scenarioCount: 5, seeds: [1], llmClient: null });

    const orders = listOrdersWithEpisodes(db);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.orderId).toBe("order_prod1");
  });

  it("orders by most recently active episode first", () => {
    const db = makeTestDb();
    seedProductionOrder(db, "order_old", "2026-09-01T00:00:00Z");
    seedProductionOrder(db, "order_new", "2026-09-02T00:00:00Z");
    seedEpisode(db, { id: "ep_old", orderId: "order_old", attemptNumber: 1, strategyName: "rules-engine", reasoning: "x", outcome: "pending", createdAt: "2026-09-01T10:00:00Z" });
    seedEpisode(db, { id: "ep_new", orderId: "order_new", attemptNumber: 1, strategyName: "rules-engine", reasoning: "y", outcome: "pending", createdAt: "2026-09-02T10:00:00Z" });

    const orders = listOrdersWithEpisodes(db);
    expect(orders[0]!.orderId).toBe("order_new");
    expect(orders[1]!.orderId).toBe("order_old");
  });

  it("respects the limit parameter", () => {
    const db = makeTestDb();
    for (let i = 0; i < 5; i++) {
      seedProductionOrder(db, `order_${i}`, "2026-09-02T10:00:00Z");
      seedEpisode(db, { id: `ep_${i}`, orderId: `order_${i}`, attemptNumber: 1, strategyName: "rules-engine", reasoning: "x", outcome: "pending", createdAt: `2026-09-02T10:0${i}:00Z` });
    }
    expect(listOrdersWithEpisodes(db, 3)).toHaveLength(3);
  });
});

describe("getDecisionChain", () => {
  it("returns the full multi-attempt reasoning chain in attempt order", () => {
    const db = makeTestDb();
    seedProductionOrder(db, "order_chain", "2026-09-02T10:00:00Z");
    seedEpisode(db, { id: "ep1", orderId: "order_chain", attemptNumber: 1, strategyName: "salvage-agent", reasoning: "bet on transient, link at +2h", outcome: "failed_again", createdAt: "2026-09-02T10:00:00Z" });
    seedEpisode(db, { id: "ep2", orderId: "order_chain", attemptNumber: 2, strategyName: "salvage-agent", reasoning: "I was wrong about transient — switching channel", outcome: "recovered", createdAt: "2026-09-03T10:00:00Z" });

    const chain = getDecisionChain(db, "order_chain");
    expect(chain).not.toBeNull();
    expect(chain!.steps).toHaveLength(2);
    expect(chain!.steps[0]!.attemptNumber).toBe(1);
    expect(chain!.steps[0]!.reasoning).toContain("bet on transient");
    expect(chain!.steps[1]!.attemptNumber).toBe(2);
    expect(chain!.steps[1]!.reasoning).toContain("I was wrong");
    expect(chain!.order.attempts).toBe(2);
    expect(chain!.order.latestOutcome).toBe("recovered");
  });

  it("returns null for an order that doesn't exist", () => {
    const db = makeTestDb();
    expect(getDecisionChain(db, "nonexistent")).toBeNull();
  });
});
