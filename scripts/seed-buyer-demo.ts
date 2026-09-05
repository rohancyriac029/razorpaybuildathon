#!/usr/bin/env -S npx tsx
// v3 agentic-commerce surface. Seeds §9's three buyer beats through the
// REAL pipeline — real BuyerAgent (real LLM calls, real tool use), real
// createPurchaseOrder (real Razorpay test-mode order), real
// RulesPolicyEngine (same 14-rule engine recovery uses), real
// decidePurchase(), real executePurchase(). Nothing here is a fixture row.
//
//   npx tsx scripts/seed-buyer-demo.ts        # then: npm run dev, open http://localhost:3000
//
// Beats seeded, mirroring scripts/seed-demo.ts's shape (normal case, then
// two safety-net catches):
//   1. Buyer wants the Basic plan, mandate covers it -> P0 approve -> real
//      order + real payment link.
//   2. Buyer wants the Enterprise plan, mandate does not cover it -> P9
//      rewrites the proposal to ESCALATE. The money beat: the buyer's own
//      spending ceiling is the SAME rule that governs recovery's value
//      ceiling, not new logic.
//   3. Buyer wants the legacy addon, which is out of stock -> policy
//      approves (it's within mandate) but the pre-execution catalog check
//      in execute-purchase.ts skips it. Labelled explicitly as NOT P8 —
//      P8 checks payment status, this checks a catalog fact.
import { existsSync } from "node:fs";
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch {
  // no .env — fine
}

import { db } from "../src/db/client.js";
import { createPurchaseOrder } from "../src/commerce/create-purchase-order.js";
import { decidePurchase } from "../src/commerce/decide-purchase.js";
import { executePurchase } from "../src/commerce/execute-purchase.js";
import { BuyerAgent } from "../src/commerce/buyer-agent.js";
import { RulesPolicyEngine, policyConfigFromEnv } from "../src/policy/engine.js";
import { makeEpisodeLogger } from "../src/persistence/episode-logger.js";
import { llmClientFromEnv } from "../src/llm/factory.js";
import type { BuyerContext, BuyerMandate } from "../src/types.js";

const rzpClientPromise = (async () => {
  const Razorpay = (await import("razorpay")).default;
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID ?? "", key_secret: process.env.RAZORPAY_KEY_SECRET ?? "" });
})();

// Mandate ceiling matches the DEFAULT_POLICY_CONFIG value ceiling (₹5,000) —
// deliberately, so PLAN-ENT (₹7,500) breaches it the same way an over-ceiling
// recovery proposal would. Enforced by constructing PolicyConfig with
// valueCeilingPaise = mandate.maxPerOrderPaise (spec §4 "Mandate enforcement").
const MANDATE: BuyerMandate = {
  buyerId: "buyer_demo",
  maxPerOrderPaise: 500_000,
  maxTotalPaise: 2_000_000,
  allowedCategories: ["subscription", "addon"],
};

async function beat(args: { label: string; sku: string; qty: number; intent: string; tag: string }) {
  const rzp = await rzpClientPromise;
  const agent = new BuyerAgent(llmClientFromEnv());
  const config = { ...policyConfigFromEnv(), valueCeilingPaise: MANDATE.maxPerOrderPaise };
  const policy = new RulesPolicyEngine(db, config);
  const log = makeEpisodeLogger(db, agent.name, null);

  const order = await createPurchaseOrder(db, rzp, `${MANDATE.buyerId}_${args.tag}`, args.sku, args.qty);

  const ctx: BuyerContext = {
    order,
    mandate: MANDATE,
    spentSoFarPaise: 0,
    now: new Date(),
    intent: args.intent,
  };

  const decision = await decidePurchase(agent, policy, ctx, log);
  const verdict = decision.verdict;

  console.log(
    `  ${args.label}\n    proposed:   ${decision.proposal.type}${decision.proposal.type === "PURCHASE" ? ` (${(decision.proposal as { sku: string }).sku} x${(decision.proposal as { quantity: number }).quantity})` : ""}\n    verdict:    ${verdict.kind}${verdict.kind !== "APPROVE" ? ` (${verdict.ruleId}: ${verdict.reason})` : ` (${verdict.ruleId})`}`,
  );

  if (verdict.kind === "REJECT" || !decision.intentId) return;

  const result = await executePurchase(db, rzp, decision.intentId, decision.proposal as Extract<typeof decision.proposal, { type: "PURCHASE" }>);
  await log({
    contextHash: decision.contextHash,
    reasoning: decision.proposal.reasoning,
    proposal: decision.proposal,
    verdict,
    execResult: result,
    outcome: result.ok ? "pending" : result.detail.startsWith("P8 recheck") ? "recovered" : "rejected",
    intentId: decision.intentId,
  });
  console.log(`    executed:   ok=${result.ok}${result.ok ? "" : ` — ${result.detail}`}`);
}

console.log("\n[seed-buyer-demo] Seeding v3 buyer beats through the real pipeline...\n");

console.log("BEAT 1 — within mandate, approved and executed");
await beat({
  label: "Buyer wants the Basic plan (₹499, mandate ceiling ₹5,000)",
  sku: "PLAN-BASIC",
  qty: 1,
  intent: "The buyer wants to sign up for the Basic plan.",
  tag: "basic",
});

console.log("\nBEAT 2 — mandate breach -> P9 -> ESCALATE (the money beat)");
await beat({
  label: "Buyer wants the Enterprise plan (₹7,500, mandate ceiling ₹5,000)",
  sku: "PLAN-ENT",
  qty: 1,
  intent: "The buyer wants to upgrade to the Enterprise plan.",
  tag: "enterprise",
});

console.log("\nBEAT 3 — out of stock (NOT P8 — a catalog fact, not an order status)");
await beat({
  label: "Buyer wants the legacy addon, which is out of stock",
  sku: "ADDON-OOS",
  qty: 1,
  intent: "The buyer wants to add the legacy addon to their plan.",
  tag: "oos",
});

console.log("\n[seed-buyer-demo] done. Run `npm run dev` and open http://localhost:3000\n");
process.exit(0);
