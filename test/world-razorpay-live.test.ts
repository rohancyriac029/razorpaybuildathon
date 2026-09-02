// Real calls against the live Razorpay test-mode account. Skipped by
// default — `npm test` must stay fast, offline, and runnable by a reviewer
// with no Razorpay credentials at all. Run explicitly with:
//   LIVE_RAZORPAY_TESTS=true npm test -- world-razorpay-live
// Creates real (test-mode, zero-cost) orders and payment links each run.
import { describe, it, expect } from "vitest";
import Razorpay from "razorpay";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import { RazorpayWorld } from "../src/world/razorpay-world.js";
import type { Intent, PaymentLinkProposal } from "../src/types.js";

const RUN_LIVE = process.env.LIVE_RAZORPAY_TESTS === "true";

describe.skipIf(!RUN_LIVE)("RazorpayWorld (LIVE, real API calls)", () => {
  it("creates a real order and a real payment link, and getOrder reflects live status", async () => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) throw new Error("RAZORPAY_KEY_ID/SECRET not set");

    const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
    const db = makeTestDb();
    const world = new RazorpayWorld(rzp, db);

    // Real order, created live.
    const rzpOrder = await rzp.orders.create({ amount: 49900, currency: "INR", receipt: `salvage_live_test_${Date.now()}` });
    expect(rzpOrder.id).toMatch(/^order_/);

    const localOrderId = randomUUID();
    db.insert(schema.customers).values({ id: "cust_live", razorpayCustomerId: "rzp_cust_live", createdAt: new Date().toISOString() }).run();
    db.insert(schema.orders)
      .values({
        id: localOrderId,
        razorpayOrderId: rzpOrder.id,
        razorpaySubscriptionId: null,
        customerId: "cust_live",
        amount: 49900,
        currency: "INR",
        status: "attempted",
        createdAt: new Date().toISOString(),
      })
      .run();

    // getOrder: real live status check (P8's mechanism).
    const fetched = await world.getOrder(localOrderId);
    expect(fetched.status).toBe("created"); // nobody has paid it

    // createPaymentLink: real payment link, real short_url.
    const proposal: PaymentLinkProposal = {
      type: "PAYMENT_LINK",
      orderId: localOrderId,
      attemptNumber: 1,
      reasoning: "live test",
      proposedAt: new Date().toISOString(),
      sendAt: new Date().toISOString(),
      channel: "whatsapp",
    };
    const intent: Intent = {
      id: randomUUID(),
      episodeId: randomUUID(),
      orderId: localOrderId,
      attemptNumber: 1,
      proposal,
      verdict: { kind: "APPROVE", ruleId: "P0", reason: "test" },
      idempotencyKey: "test_key",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    const result = await world.createPaymentLink(intent);
    expect(result.ok).toBe(true);
    expect(result.razorpayRefId).toMatch(/^plink_/);
    expect(result.detail).toContain("rzp.io");
  }, 30_000);
});
