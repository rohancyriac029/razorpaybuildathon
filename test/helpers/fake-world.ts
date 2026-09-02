// Test double for the World port. Not RazorpayWorld (block 4, real API) or
// SimWorld (block 7, the generator + counterfactual); exists purely to
// prove run()/decide()/executeApproved() drive the World port correctly
// without needing either of those.
//
// getOrder() reads from the same in-memory test db every other test
// helper uses (mirrors RazorpayWorld's shape, minus the live Razorpay
// round-trip) rather than holding one fixed Order at construction time —
// a caller often doesn't know the internal orderId yet when it needs to
// register this World with a scheduler dispatcher (the real orderId is
// generated inside webhook processing, which hasn't run yet).
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../src/db/schema.js";
import type { World } from "../../src/ports/world.js";
import type { ExecResult, Intent, Order } from "../../src/types.js";

type Db = BetterSQLite3Database<typeof schema>;

export class FakeWorld implements World {
  calls: { method: string; intent: Intent }[] = [];

  constructor(private readonly db: Db) {}

  async getOrder(id: string): Promise<Order> {
    const row = this.db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
    if (!row) throw new Error(`FakeWorld.getOrder: no order ${id}`);
    return {
      id: row.id,
      razorpayOrderId: row.razorpayOrderId,
      razorpaySubscriptionId: row.razorpaySubscriptionId,
      customerId: row.customerId,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      createdAt: row.createdAt,
    };
  }

  async createPaymentLink(intent: Intent): Promise<ExecResult> {
    this.calls.push({ method: "createPaymentLink", intent });
    return {
      intentId: intent.id,
      ok: true,
      razorpayRefId: "plink_fake_1",
      detail: "fake payment link created",
      executedAt: new Date().toISOString(),
    };
  }

  async sendNudge(intent: Intent): Promise<ExecResult> {
    this.calls.push({ method: "sendNudge", intent });
    return {
      intentId: intent.id,
      ok: true,
      razorpayRefId: null,
      detail: "fake nudge sent",
      executedAt: new Date().toISOString(),
    };
  }

  async chargeToken(intent: Intent): Promise<ExecResult> {
    this.calls.push({ method: "chargeToken", intent });
    return {
      intentId: intent.id,
      ok: true,
      razorpayRefId: "pay_fake_1",
      detail: "fake token charge",
      executedAt: new Date().toISOString(),
    };
  }
}
