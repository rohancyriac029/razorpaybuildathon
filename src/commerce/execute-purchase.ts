// v3 agentic-commerce surface (spec §4, Change 3). Owns execution for an
// approved PurchaseProposal, via the real Razorpay test-mode API — mirrors
// RazorpayWorld.createPaymentLink()'s shape closely but is NOT part of
// RazorpayWorld: that class's methods are type-gated to their one proposal
// type (`if (intent.proposal.type !== "PAYMENT_LINK") throw`), and it is
// frozen (spec §2 "Out"). Reusing it for PURCHASE would mean either
// widening a frozen recovery file or faking a PAYMENT_LINK proposal — both
// worse than this ~40-line parallel.
//
// Because executeApproved() in src/run.ts has no PURCHASE branch and is
// also frozen, THIS function must perform the P8-equivalent pre-execution
// recheck itself, or "every money action gated" has a hole. It does two
// checks, and labels them honestly as different things:
//   1. P8 equivalent — order already paid (live Razorpay status, not the
//      possibly-stale local row) -> skip, exactly like run.ts's real P8.
//   2. NOT P8 — the item is out of stock. This is new logic; the audit
//      trail and the demo must not call it a P-rule.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Razorpay from "razorpay";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { ExecResult, PurchaseProposal } from "../types.js";
import { getItem } from "./catalog.js";

type Db = BetterSQLite3Database<typeof schema>;

export async function executePurchase(
  db: Db,
  rzp: Razorpay,
  intentId: string,
  proposal: PurchaseProposal,
): Promise<ExecResult> {
  const executedAt = new Date().toISOString();
  const order = db.select().from(schema.orders).where(eq(schema.orders.id, proposal.orderId)).get();
  if (!order) throw new Error(`executePurchase: no local order ${proposal.orderId}`);

  // 1. P8 equivalent: live status, not the local row, exactly like run.ts's
  // real P8 asks "is this already paid, right now" rather than trusting a
  // possibly-stale local copy.
  const live = await rzp.orders.fetch(order.razorpayOrderId);
  if (live.status === "paid") {
    return {
      intentId,
      ok: false,
      razorpayRefId: null,
      detail: "P8 recheck: order already paid, execution skipped",
      executedAt,
    };
  }

  // 2. NOT P8 — a catalog fact, not an order status. Checked here because
  // it's the same "immediately before spending money" moment P8 occupies,
  // but it is new logic and must be labelled as such (spec §4).
  const item = getItem(proposal.sku);
  if (!item || !item.inStock) {
    return {
      intentId,
      ok: false,
      razorpayRefId: null,
      detail: `pre-execution catalog check: "${proposal.sku}" is out of stock`,
      executedAt,
    };
  }

  try {
    // Amount comes from the order (itself priced from the catalog at
    // createPurchaseOrder time), never from the proposal — proposal has no
    // amount field to read. Same P6/P14 discipline as recovery.
    const link = await rzp.paymentLink.create({
      amount: order.amount,
      currency: order.currency,
      description: `Purchase: ${item.name} x${proposal.quantity} (order ${order.razorpayOrderId})`,
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { salvage_order_id: order.id, salvage_intent_id: intentId, salvage_sku: proposal.sku },
    } as unknown as Parameters<typeof rzp.paymentLink.create>[0]);

    return {
      intentId,
      ok: true,
      razorpayRefId: link.id,
      detail: `payment link created: ${link.short_url}`,
      executedAt,
    };
  } catch (err) {
    return {
      intentId,
      ok: false,
      razorpayRefId: null,
      detail: `payment link creation failed: ${err instanceof Error ? err.message : String(err)}`,
      executedAt,
    };
  }
}

/** Stub path for demo/simulate modes that never touch a live Razorpay account — mirrors scripts/backfill.ts's SimulatedWorld pattern. */
export async function executePurchaseSimulated(proposal: PurchaseProposal, intentId: string): Promise<ExecResult> {
  const item = getItem(proposal.sku);
  const executedAt = new Date().toISOString();
  if (!item || !item.inStock) {
    return {
      intentId,
      ok: false,
      razorpayRefId: null,
      detail: `pre-execution catalog check: "${proposal.sku}" is out of stock`,
      executedAt,
    };
  }
  return {
    intentId,
    ok: true,
    razorpayRefId: `plink_sim_${randomUUID().slice(0, 8)}`,
    detail: "payment link created (simulated, not sent for real)",
    executedAt,
  };
}
