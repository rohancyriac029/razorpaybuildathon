import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import { gatherSnapshot } from "../src/policy/gather-snapshot.js";
import { RulesPolicyEngine } from "../src/policy/engine.js";
import { DEFAULT_POLICY_CONFIG } from "../src/policy/rules.js";
import { idempotencyKey } from "../src/util/idempotency.js";
import type { ExecResult, FailureEvent, Order, PaymentLinkProposal, Proposal } from "../src/types.js";

const NOW = new Date("2026-09-02T10:00:00Z"); // 15:30 IST, safe daytime

function seedOrder(db: ReturnType<typeof makeTestDb>, id: string, status: Order["status"] = "attempted") {
  db.insert(schema.customers)
    .values({ id: `cust_${id}`, razorpayCustomerId: `rzp_cust_${id}`, createdAt: NOW.toISOString() })
    .run();
  db.insert(schema.orders)
    .values({
      id,
      razorpayOrderId: `rzp_${id}`,
      razorpaySubscriptionId: null,
      customerId: `cust_${id}`,
      amount: 49900,
      currency: "INR",
      status,
      createdAt: NOW.toISOString(),
    })
    .run();
}

function linkProposal(orderId: string, attemptNumber = 1): PaymentLinkProposal {
  return {
    type: "PAYMENT_LINK",
    orderId,
    attemptNumber,
    reasoning: "test",
    proposedAt: NOW.toISOString(),
    sendAt: NOW.toISOString(),
    channel: "whatsapp",
  };
}

function seedEpisode(
  db: ReturnType<typeof makeTestDb>,
  args: {
    orderId: string;
    proposal: Proposal;
    execResult: ExecResult | null;
    createdAt: string;
  },
) {
  db.insert(schema.episodes)
    .values({
      id: randomUUID(),
      orderId: args.orderId,
      attemptNumber: args.proposal.attemptNumber,
      strategyName: "test",
      contextHash: "hash",
      reasoning: "test",
      proposal: args.proposal as unknown as object,
      verdictKind: "APPROVE",
      verdictRuleId: "P0",
      verdictReason: "test",
      execResult: args.execResult as unknown as object | null,
      outcome: args.execResult?.ok ? "pending" : null,
      createdAt: args.createdAt,
    })
    .run();
}

function execResult(ok: boolean, refId: string | null = "ref_1"): ExecResult {
  return { intentId: "intent_1", ok, razorpayRefId: ok ? refId : null, detail: "", executedAt: NOW.toISOString() };
}

describe("gatherSnapshot", () => {
  it("counts only genuinely executed (ok=true) attempts, not P8-skipped or failed ones", () => {
    const db = makeTestDb();
    seedOrder(db, "order_1");
    seedEpisode(db, { orderId: "order_1", proposal: linkProposal("order_1", 1), execResult: execResult(true), createdAt: NOW.toISOString() });
    seedEpisode(db, {
      orderId: "order_1",
      proposal: linkProposal("order_1", 2),
      execResult: execResult(false), // e.g. P8 caught it already paid, or a real API failure
      createdAt: NOW.toISOString(),
    });

    const snap = gatherSnapshot(db, "order_1", linkProposal("order_1", 3), NOW);
    expect(snap.priorExecutedAttempts).toBe(1);
  });

  it("tracks lastExecutionAt as the most recent executed attempt", () => {
    const db = makeTestDb();
    seedOrder(db, "order_1");
    const earlier = new Date(NOW.getTime() - 10 * 3_600_000).toISOString();
    const later = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    seedEpisode(db, { orderId: "order_1", proposal: linkProposal("order_1", 1), execResult: execResult(true), createdAt: earlier });
    seedEpisode(db, { orderId: "order_1", proposal: linkProposal("order_1", 2), execResult: execResult(true), createdAt: later });

    const snap = gatherSnapshot(db, "order_1", linkProposal("order_1", 3), NOW);
    expect(snap.lastExecutionAt?.toISOString()).toBe(later);
  });

  it("liveUnpaidLinkExists is true after an executed link while the order is unpaid", () => {
    const db = makeTestDb();
    seedOrder(db, "order_1", "attempted");
    seedEpisode(db, { orderId: "order_1", proposal: linkProposal("order_1", 1), execResult: execResult(true), createdAt: NOW.toISOString() });

    const snap = gatherSnapshot(db, "order_1", linkProposal("order_1", 2), NOW);
    expect(snap.liveUnpaidLinkExists).toBe(true);
  });

  it("liveUnpaidLinkExists is false once the order is marked paid", () => {
    const db = makeTestDb();
    seedOrder(db, "order_1", "paid");
    seedEpisode(db, { orderId: "order_1", proposal: linkProposal("order_1", 1), execResult: execResult(true), createdAt: NOW.toISOString() });

    const snap = gatherSnapshot(db, "order_1", linkProposal("order_1", 2), NOW);
    expect(snap.liveUnpaidLinkExists).toBe(false);
  });

  it("counts global executions across different orders within the last hour", () => {
    const db = makeTestDb();
    seedOrder(db, "order_1");
    seedOrder(db, "order_2");
    const withinHour = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    const overHourAgo = new Date(NOW.getTime() - 90 * 60_000).toISOString();
    seedEpisode(db, { orderId: "order_1", proposal: linkProposal("order_1", 1), execResult: execResult(true), createdAt: withinHour });
    seedEpisode(db, { orderId: "order_2", proposal: linkProposal("order_2", 1), execResult: execResult(true), createdAt: overHourAgo });

    const snap = gatherSnapshot(db, "order_1", linkProposal("order_1", 2), NOW);
    expect(snap.globalExecutionsLastHour).toBe(1); // only the within-hour one counts
  });

  it("detects an already-executed idempotency key via the intents table", () => {
    const db = makeTestDb();
    seedOrder(db, "order_1");
    const proposal = linkProposal("order_1", 1);
    seedEpisode(db, { orderId: "order_1", proposal, execResult: execResult(true), createdAt: NOW.toISOString() });
    const episodeId = db.select({ id: schema.episodes.id }).from(schema.episodes).limit(1).get()!.id;
    db.insert(schema.intents)
      .values({
        id: randomUUID(),
        episodeId,
        orderId: "order_1",
        attemptNumber: 1,
        proposalType: "PAYMENT_LINK",
        idempotencyKey: idempotencyKey("order_1", 1),
        status: "executed",
        createdAt: NOW.toISOString(),
      })
      .run();

    const snap = gatherSnapshot(db, "order_1", proposal, NOW);
    expect(snap.idempotencyKeyAlreadyExecuted).toBe(true);
  });
});

describe("RulesPolicyEngine (end-to-end through the port)", () => {
  it("approves a clean proposal against a freshly seeded order", async () => {
    const db = makeTestDb();
    seedOrder(db, "order_1");
    const engine = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);

    const failure: FailureEvent = {
      id: "f1",
      orderId: "order_1",
      eventId: "e1",
      razorpayPaymentId: "p1",
      errorCode: null,
      errorSource: null,
      errorStep: null,
      errorReason: "gateway_technical_error",
      category: "TRANSIENT",
      attemptNumber: 1,
      occurredAt: NOW.toISOString(),
    };
    const order = db.select().from(schema.orders).limit(1).get()!;

    const verdict = await engine.decide(linkProposal("order_1", 1), {
      order: order as unknown as Order,
      failure,
      now: NOW,
    });
    expect(verdict.kind).toBe("APPROVE");
  });

  it("rejects P1 after 3 real executed attempts recorded in the DB", async () => {
    const db = makeTestDb();
    seedOrder(db, "order_1");
    for (let i = 1; i <= 3; i++) {
      seedEpisode(db, {
        orderId: "order_1",
        proposal: linkProposal("order_1", i),
        execResult: execResult(true),
        createdAt: new Date(NOW.getTime() - (10 - i) * 3_600_000).toISOString(),
      });
    }
    const engine = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);
    const failure: FailureEvent = {
      id: "f1",
      orderId: "order_1",
      eventId: "e1",
      razorpayPaymentId: "p1",
      errorCode: null,
      errorSource: null,
      errorStep: null,
      errorReason: "gateway_technical_error",
      category: "TRANSIENT",
      attemptNumber: 4,
      occurredAt: NOW.toISOString(),
    };
    const order = db.select().from(schema.orders).limit(1).get()!;

    const verdict = await engine.decide(linkProposal("order_1", 4), {
      order: order as unknown as Order,
      failure,
      now: NOW,
    });
    expect(verdict.kind).toBe("REJECT");
    expect(verdict.ruleId).toBe("P1");
  });
});
