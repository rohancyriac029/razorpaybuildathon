// Spec §6 block 4: the real Razorpay test-mode World. Verified live against
// the account 2026-09-02: orders.create/fetch and paymentLink.create both
// confirmed working with real HTTP 200s; the S2S direct-card-payment
// endpoint (POST /v1/payments/create/json) returned 404 on this account —
// same shape of gap as the Subscriptions entitlement (spec §0.1), a
// product/feature not enabled on a fresh account, not a code bug. See
// PROGRESS.md block 4 for the full trail and the live-demo recipe that
// works around it (the hosted checkout page — which is what spec's own
// description of test mode assumes: "a mock bank page with Success/Failure
// buttons").
import type Razorpay from "razorpay";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { World } from "../ports/world.js";
import type { ExecResult, Intent, Order } from "../types.js";

type Db = BetterSQLite3Database<typeof schema>;

function mapRazorpayOrderStatus(status: string): Order["status"] {
  switch (status) {
    case "paid":
      return "paid";
    case "attempted":
      return "attempted";
    case "created":
      return "created";
    default:
      return "attempted"; // unknown live status: fail toward "not yet paid", never toward "paid"
  }
}

export class RazorpayWorld implements World {
  constructor(
    private readonly rzp: Razorpay,
    private readonly db: Db,
  ) {}

  async getOrder(id: string): Promise<Order> {
    const local = this.db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
    if (!local) throw new Error(`RazorpayWorld.getOrder: no local order ${id}`);

    // P8's entire reason to exist: ask Razorpay directly, right now, not our
    // own possibly-stale local row.
    const live = await this.rzp.orders.fetch(local.razorpayOrderId);

    return {
      id: local.id,
      razorpayOrderId: local.razorpayOrderId,
      razorpaySubscriptionId: local.razorpaySubscriptionId,
      customerId: local.customerId,
      amount: local.amount,
      currency: local.currency,
      status: mapRazorpayOrderStatus(live.status),
      createdAt: local.createdAt,
    };
  }

  async createPaymentLink(intent: Intent): Promise<ExecResult> {
    if (intent.proposal.type !== "PAYMENT_LINK") {
      throw new Error(`RazorpayWorld.createPaymentLink: wrong proposal type ${intent.proposal.type}`);
    }
    const order = this.db.select().from(schema.orders).where(eq(schema.orders.id, intent.orderId)).get();
    if (!order) throw new Error(`RazorpayWorld.createPaymentLink: no local order ${intent.orderId}`);

    try {
      // Amount comes from the order, never from the proposal — the proposal
      // has no amount field to read (P6/P14, spec §4.1.1). notify is off:
      // this system owns delivery (or stubs it, spec §11), not Razorpay's
      // auto-notification.
      //
      // The SDK's TypeScript types mark `customer` as required, but the
      // live API accepted this exact call shape without one (verified
      // 2026-09-02) — the SDK is stricter than the real API here. Casting
      // rather than fabricating a customer identity we don't actually have.
      const link = await this.rzp.paymentLink.create({
        amount: order.amount,
        currency: order.currency,
        description: `Payment recovery for order ${order.razorpayOrderId}`,
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { salvage_order_id: order.id, salvage_intent_id: intent.id },
      } as unknown as Parameters<typeof this.rzp.paymentLink.create>[0]);
      return {
        intentId: intent.id,
        ok: true,
        razorpayRefId: link.id,
        detail: `payment link created: ${link.short_url}`,
        executedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        intentId: intent.id,
        ok: false,
        razorpayRefId: null,
        detail: `payment link creation failed: ${err instanceof Error ? err.message : String(err)}`,
        executedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Spec §11 "Do not build": real WhatsApp/SMS/email delivery. Stubbed —
   * logs the payload so the audit trail still shows what *would* have
   * been sent, matching the cut-list's pre-approved degradation (§10
   * item 9: "Real message delivery — stub, log the payload").
   */
  async sendNudge(intent: Intent): Promise<ExecResult> {
    if (intent.proposal.type !== "NUDGE") {
      throw new Error(`RazorpayWorld.sendNudge: wrong proposal type ${intent.proposal.type}`);
    }
    console.log("[stub sendNudge]", JSON.stringify({
      orderId: intent.orderId,
      templateId: intent.proposal.templateId,
      vars: intent.proposal.vars,
      channel: intent.proposal.channel,
    }));
    return {
      intentId: intent.id,
      ok: true,
      razorpayRefId: null,
      detail: "nudge stubbed, not actually delivered (spec §11)",
      executedAt: new Date().toISOString(),
    };
  }

  /**
   * Charges a confirmed mandate token. UNTESTED against live Razorpay:
   * this account does not have Subscriptions/recurring-payments entitled
   * (spec §0.1), so there is no `confirmed` token to charge yet. The
   * request shape below is built from the razorpay-node SDK's own type
   * definitions (payments.createRecurringPayment), not guessed — but it
   * has never been exercised against a real mandate. Do not claim this
   * path works live until entitlement lands and it's actually run once.
   */
  async chargeToken(intent: Intent): Promise<ExecResult> {
    if (intent.proposal.type !== "TOKEN_RETRY") {
      throw new Error(`RazorpayWorld.chargeToken: wrong proposal type ${intent.proposal.type}`);
    }
    const order = this.db.select().from(schema.orders).where(eq(schema.orders.id, intent.orderId)).get();
    if (!order) throw new Error(`RazorpayWorld.chargeToken: no local order ${intent.orderId}`);

    try {
      const result = await this.rzp.payments.createRecurringPayment({
        email: "unused@salvage.local", // required by the SDK type; the token, not this, identifies the customer
        contact: "9000090000",
        amount: order.amount,
        currency: order.currency,
        order_id: order.razorpayOrderId,
        customer_id: order.customerId,
        token: intent.proposal.mandateTokenId,
        recurring: true,
        notes: {},
      });
      return {
        intentId: intent.id,
        ok: Boolean(result.razorpay_payment_id),
        razorpayRefId: result.razorpay_payment_id ?? null,
        detail: result.razorpay_payment_id ? "token charged" : "token charge did not return a payment id",
        executedAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        intentId: intent.id,
        ok: false,
        razorpayRefId: null,
        detail: `token charge failed: ${err instanceof Error ? err.message : String(err)}`,
        executedAt: new Date().toISOString(),
      };
    }
  }
}
