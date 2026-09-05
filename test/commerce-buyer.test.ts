// v3 agentic-commerce surface (salvage-v3-agentic-commerce-spec.md §7).
// Mirrors test/backfill-ingest.test.ts's style: real pipeline (real
// createPurchaseOrder, real decidePurchase -> real RulesPolicyEngine, real
// executePurchase), fake Razorpay client (no live network in the suite),
// scripted FakeLlmClient (no live model in the suite). Asserts on real
// verdicts, never on a mock's return value.
import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import { FakeLlmClient } from "./helpers/fake-llm-client.js";
import * as schema from "../src/db/schema.js";
import { createPurchaseOrder } from "../src/commerce/create-purchase-order.js";
import { decidePurchase } from "../src/commerce/decide-purchase.js";
import { executePurchase } from "../src/commerce/execute-purchase.js";
import { BuyerAgent } from "../src/commerce/buyer-agent.js";
import { RulesPolicyEngine, policyConfigFromEnv } from "../src/policy/engine.js";
import { DEFAULT_POLICY_CONFIG } from "../src/policy/rules.js";
import { makeEpisodeLogger } from "../src/persistence/episode-logger.js";
import type { BuyerContext, BuyerMandate } from "../src/types.js";
import type Razorpay from "razorpay";

const NOW = new Date("2026-09-05T10:00:00Z"); // 15:30 IST, safe daytime — matches the rest of the suite's convention

const MANDATE: BuyerMandate = {
  buyerId: "buyer_test",
  maxPerOrderPaise: 500_000, // ₹5,000 — same as DEFAULT_POLICY_CONFIG.valueCeilingPaise
  maxTotalPaise: 2_000_000,
  allowedCategories: ["subscription", "addon"],
};

/** Enough of Razorpay's surface for createPurchaseOrder/executePurchase — no live network. */
function fakeRzp(): Razorpay {
  let n = 0;
  const orders = new Map<string, { id: string; status: string }>();
  return {
    orders: {
      create: async (params: { amount: number }) => {
        const id = `order_test_${++n}`;
        orders.set(id, { id, status: "created" });
        return { id, entity: "order", amount: params.amount, amount_paid: 0, amount_due: params.amount, currency: "INR", status: "created" };
      },
      fetch: async (orderId: string) => {
        const o = orders.get(orderId);
        if (!o) throw new Error(`fakeRzp: no order ${orderId}`);
        return { id: o.id, entity: "order", amount: 0, amount_paid: 0, amount_due: 0, currency: "INR", status: o.status };
      },
    },
    paymentLink: {
      create: async () => ({ id: `plink_test_${++n}`, short_url: "https://rzp.io/fake" }),
    },
  } as unknown as Razorpay;
}

function setup(db: ReturnType<typeof makeTestDb>, config = { ...DEFAULT_POLICY_CONFIG, valueCeilingPaise: MANDATE.maxPerOrderPaise }) {
  const rzp = fakeRzp();
  const policy = new RulesPolicyEngine(db, config);
  const log = makeEpisodeLogger(db, "buyer-agent", null);
  return { rzp, policy, log };
}

async function buyOnce(
  db: ReturnType<typeof makeTestDb>,
  rzp: Razorpay,
  policy: RulesPolicyEngine,
  log: ReturnType<typeof makeEpisodeLogger>,
  agent: BuyerAgent,
  sku: string,
  intent: string,
) {
  const order = await createPurchaseOrder(db, rzp, MANDATE.buyerId, sku, 1);
  const ctx: BuyerContext = { order, mandate: MANDATE, spentSoFarPaise: 0, now: NOW, intent };
  return decidePurchase(agent, policy, ctx, log);
}

describe("buyer mandate breach -> P9 -> ESCALATE (the headline case)", () => {
  it("rewrites an over-mandate PURCHASE into an ESCALATE, same rule recovery's value ceiling uses", async () => {
    const db = makeTestDb();
    const { rzp, policy, log } = setup(db);
    const agent = new BuyerAgent(
      new FakeLlmClient([{ id: "1", name: "proposePurchase", input: { sku: "PLAN-ENT", quantity: 1, reasoning: "buyer wants enterprise" } }]),
    );

    const decision = await buyOnce(db, rzp, policy, log, agent, "PLAN-ENT", "buy enterprise");

    expect(decision.verdict.kind).toBe("MODIFY");
    expect(decision.verdict.ruleId).toBe("P9");
    expect(decision.proposal.type).toBe("ESCALATE");
    expect(decision.intentId).toBeNull(); // ESCALATE never executes
  });
});

describe("buyer purchase within mandate -> approved and executed", () => {
  it("PLAN-BASIC under a ₹5,000 mandate is approved and a real order+link execute", async () => {
    const db = makeTestDb();
    const { rzp, policy, log } = setup(db);
    const agent = new BuyerAgent(
      new FakeLlmClient([{ id: "1", name: "proposePurchase", input: { sku: "PLAN-BASIC", quantity: 1, reasoning: "buyer wants basic" } }]),
    );

    const decision = await buyOnce(db, rzp, policy, log, agent, "PLAN-BASIC", "buy basic");

    expect(decision.verdict.kind).toBe("APPROVE");
    expect(decision.verdict.ruleId).toBe("P0");
    expect(decision.intentId).not.toBeNull();

    const result = await executePurchase(db, rzp, decision.intentId!, decision.proposal as Extract<typeof decision.proposal, { type: "PURCHASE" }>);
    expect(result.ok).toBe(true);
    expect(result.razorpayRefId).toMatch(/^plink_test_/);

    const orders = db.select().from(schema.orders).all();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.amount).toBe(49_900); // PLAN-BASIC's catalog price, not anything the model said
  });
});

describe("no price authority", () => {
  it("refuses a proposePurchase call carrying a smuggled price field — produces no Proposal", async () => {
    const db = makeTestDb();
    const { rzp, policy, log } = setup(db);
    const agent = new BuyerAgent(
      new FakeLlmClient((_turns, step) =>
        step === 0
          ? { id: "1", name: "proposePurchase", input: { sku: "PLAN-BASIC", quantity: 1, reasoning: "x", discount_pct: 20 } }
          : { id: "2", name: "escalate", input: { reasoning: "corrected", explanation: "no price authority, escalating instead" } },
      ),
    );

    const decision = await buyOnce(db, rzp, policy, log, agent, "PLAN-BASIC", "buy basic with a discount");

    // The smuggled-price call was refused (never became a Proposal); the
    // agent's own next step is what we see here — an escalation, not a
    // purchase at any price.
    expect(decision.proposal.type).toBe("ESCALATE");
    expect(agent.lastOfferAttempted).toBe(true);
  });
});

describe("kill switch", () => {
  it("P13 rejects every purchase outright, regardless of mandate", async () => {
    const db = makeTestDb();
    const { rzp, policy, log } = setup(db, { ...DEFAULT_POLICY_CONFIG, valueCeilingPaise: MANDATE.maxPerOrderPaise, killSwitch: true });
    const agent = new BuyerAgent(
      new FakeLlmClient([{ id: "1", name: "proposePurchase", input: { sku: "PLAN-BASIC", quantity: 1, reasoning: "x" } }]),
    );

    const decision = await buyOnce(db, rzp, policy, log, agent, "PLAN-BASIC", "buy basic");

    expect(decision.verdict.kind).toBe("REJECT");
    expect(decision.verdict.ruleId).toBe("P13");
  });
});

describe("out of stock", () => {
  it("policy approves (within mandate) but execution skips it — labelled as NOT P8", async () => {
    const db = makeTestDb();
    const { rzp, policy, log } = setup(db);
    const agent = new BuyerAgent(
      new FakeLlmClient([{ id: "1", name: "proposePurchase", input: { sku: "ADDON-OOS", quantity: 1, reasoning: "buyer wants legacy addon" } }]),
    );

    const decision = await buyOnce(db, rzp, policy, log, agent, "ADDON-OOS", "buy legacy addon");
    expect(decision.verdict.kind).toBe("APPROVE"); // within mandate — policy has no opinion on stock

    const result = await executePurchase(db, rzp, decision.intentId!, decision.proposal as Extract<typeof decision.proposal, { type: "PURCHASE" }>);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("out of stock");
    expect(result.detail).not.toContain("P8"); // must not be mislabelled as the P8 recheck
  });
});

describe("idempotency", () => {
  it("P7 drops a second decide on the same (orderId, attemptNumber) after the first executed", async () => {
    const db = makeTestDb();
    const { rzp, policy, log } = setup(db);
    const agent = new BuyerAgent(
      new FakeLlmClient(() => ({ id: "1", name: "proposePurchase", input: { sku: "PLAN-BASIC", quantity: 1, reasoning: "x" } })),
    );

    const order = await createPurchaseOrder(db, rzp, MANDATE.buyerId, "PLAN-BASIC", 1);
    const ctx: BuyerContext = { order, mandate: MANDATE, spentSoFarPaise: 0, now: NOW, intent: "buy basic" };

    const first = await decidePurchase(agent, policy, ctx, log);
    await executePurchase(db, rzp, first.intentId!, first.proposal as Extract<typeof first.proposal, { type: "PURCHASE" }>);
    // executePurchase alone doesn't update the intents table (execute-purchase.ts
    // has no logger call baked in, unlike run.ts's executeApproved) — the demo
    // script logs separately; do that here too, matching seed-buyer-demo.ts.
    await log({
      contextHash: first.contextHash,
      reasoning: first.proposal.reasoning,
      proposal: first.proposal,
      verdict: first.verdict,
      execResult: { intentId: first.intentId!, ok: true, razorpayRefId: "plink_x", detail: "ok", executedAt: NOW.toISOString() },
      outcome: "pending",
      intentId: first.intentId,
    });

    const second = await decidePurchase(agent, policy, ctx, log); // same order, same attemptNumber (1)
    expect(second.verdict.kind).toBe("REJECT");
    expect(second.verdict.ruleId).toBe("P7");
  });
});
