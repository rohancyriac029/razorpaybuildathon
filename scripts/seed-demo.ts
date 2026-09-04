#!/usr/bin/env -S npx tsx
// Spec §6 block 11 / §8: the demo needs something on screen. This seeds the
// dev database with the exact decision chains §8's beat table calls for —
// but produces them by running the REAL pipeline (real taxonomy
// classification, real RulesPolicyEngine, real decide()/executeApproved(),
// real episode logger), never by inserting hand-written rows. Everything the
// HTML page shows after this is something the system actually decided.
//
//   npx tsx scripts/seed-demo.ts        # then: npm run dev, open http://localhost:3000
//
// Beats seeded, in the order §8 presents them:
//   1. 1:30-3:00 — "the whole demo": a TERMINAL failure dressed as
//      recoverable, a strategy proposing a retry anyway, and P3 rejecting it.
//      The audit chain shows BOTH the proposal and the rule id that stopped it.
//   2. 0:30-1:30 — a normal recovery: TRANSIENT failure -> payment link
//      approved and executed.
//   3. Graceful failure #1 (§8's "most convincing") — the P8 race: the order
//      is paid between decision time and execution time, and the
//      pre-execution recheck catches it. The model could not have reasoned
//      about this at all; only the recheck can.
import { existsSync } from "node:fs";
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch {
  // no .env — fine, this script needs no credentials
}

import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { dedupeAndStore, processPaymentFailed } from "../src/webhooks/handler.js";
import { assembleEpisodeContext } from "../src/context/assemble.js";
import { decide, executeApproved } from "../src/run.js";
import { RulesPolicyEngine, policyConfigFromEnv } from "../src/policy/engine.js";
import { makeEpisodeLogger } from "../src/persistence/episode-logger.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { FixedIntervalStrategy } from "../src/strategies/fixed-interval.js";
import type { World } from "../src/ports/world.js";
import type { ExecResult, Intent, Order } from "../src/types.js";
import type { PaymentFailedPayload } from "../src/webhooks/events.js";

/** Reports ok:true without touching the network — the demo is about the
 * decision layer, and RazorpayWorld is already proven live in block 4. */
class DemoWorld implements World {
  async getOrder(id: string): Promise<Order> {
    const row = db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
    if (!row) throw new Error(`DemoWorld: no local order ${id}`);
    return row;
  }
  private ok(intent: Intent, prefix: string): ExecResult {
    return {
      intentId: intent.id,
      ok: true,
      razorpayRefId: `${prefix}_demo_${intent.id.slice(0, 8)}`,
      detail: "seeded by scripts/seed-demo.ts (not sent for real)",
      executedAt: new Date().toISOString(),
    };
  }
  async createPaymentLink(i: Intent) { return this.ok(i, "plink"); }
  async sendNudge(i: Intent) { return this.ok(i, "nudge"); }
  async chargeToken(i: Intent) { return this.ok(i, "pay"); }
}

function failurePayload(args: {
  paymentId: string;
  orderId: string;
  errorReason: string;
  customerId: string;
  atUnix: number;
}): PaymentFailedPayload {
  return {
    event: "payment.failed",
    created_at: args.atUnix,
    payload: {
      payment: {
        entity: {
          id: args.paymentId,
          order_id: args.orderId,
          amount: 49900,
          currency: "INR",
          error_code: "BAD_REQUEST_ERROR",
          error_description: null,
          error_source: "customer",
          error_step: "payment_authorization",
          error_reason: args.errorReason,
          customer_id: args.customerId,
        },
      },
    },
  };
}

// 15:30 IST — deliberately inside P4's allowed window so the demo's rejections
// are the ones being demonstrated (P3, P8), not an incidental blackout reject.
const NOW = new Date();
NOW.setUTCHours(10, 0, 0, 0);

const world = new DemoWorld();
const policy = new RulesPolicyEngine(db, policyConfigFromEnv());

async function beat(args: {
  label: string;
  strategyName: string;
  strategy: RulesStrategy | FixedIntervalStrategy;
  errorReason: string;
  tag: string;
  /** Simulates the customer paying between decision and execution (P8 race). */
  markPaidBeforeExecution?: boolean;
}) {
  const log = makeEpisodeLogger(db, args.strategyName, null);
  const eventId = `demo_${args.tag}`;
  const payload = failurePayload({
    paymentId: `pay_demo_${args.tag}`,
    orderId: `order_demo_${args.tag}`,
    errorReason: args.errorReason,
    customerId: `cust_demo_${args.tag}`,
    atUnix: Math.floor(NOW.getTime() / 1000),
  });

  const { isNew } = dedupeAndStore(db, eventId, "payment.failed", payload, NOW.toISOString());
  if (!isNew) {
    console.log(`  ${args.label}: already seeded (deduped) — skipping`);
    return;
  }

  const processed = processPaymentFailed(db, eventId, payload, NOW.toISOString());
  const ctx = assembleEpisodeContext(db, processed.orderId, NOW);
  const decision = await decide(args.strategy, policy, ctx, log);

  const verdict = decision.verdict;
  console.log(
    `  ${args.label}\n    classified: ${processed.category}\n    proposed:   ${decision.proposal.type}\n    verdict:    ${verdict.kind}${verdict.kind !== "APPROVE" ? ` (${verdict.ruleId}: ${verdict.reason})` : ` (${verdict.ruleId})`}`,
  );

  if (verdict.kind === "REJECT" || !decision.intentId) return;

  if (args.markPaidBeforeExecution) {
    db.update(schema.orders).set({ status: "paid" }).where(eq(schema.orders.id, processed.orderId)).run();
    console.log("    [customer pays here, between decision and execution]");
  }

  const result = await executeApproved(world, decision.intentId, decision.proposal, log, verdict, decision.contextHash);
  console.log(`    executed:   ok=${result.ok}${result.ok ? "" : ` — ${result.detail}`}`);
}

console.log("\n[seed-demo] Seeding §8's demo beats through the real pipeline...\n");

console.log("BEAT 1:30-3:00 — the adversarial TERMINAL (this is the whole demo)");
await beat({
  label: "TERMINAL failure, category-blind strategy proposes a retry anyway",
  strategyName: "fixed-24h",
  strategy: new FixedIntervalStrategy(),
  // TERMINAL, and deliberately the most "dressed as recoverable" one in the
  // taxonomy (§8): a blocked card reads like an ordinary card problem a naive
  // strategy would happily retry. It isn't.
  errorReason: "debit_instrument_blocked",
  tag: "terminal_trap",
});

console.log("\nBEAT 0:30-1:30 — a normal recovery");
await beat({
  label: "TRANSIENT failure -> payment link, approved and executed",
  strategyName: "rules-engine",
  strategy: new RulesStrategy(),
  errorReason: "gateway_technical_error",
  tag: "normal_recovery",
});

console.log("\nGRACEFUL FAILURE #1 — the P8 race (§8: 'the most convincing of the three')");
await beat({
  label: "Order paid between proposal and execution; pre-execution recheck catches it",
  strategyName: "rules-engine",
  strategy: new RulesStrategy(),
  errorReason: "gateway_technical_error",
  tag: "p8_race",
  markPaidBeforeExecution: true,
});

console.log("\n[seed-demo] done. Run `npm run dev` and open http://localhost:3000\n");
