// Test double for the World port — spine test only. Not RazorpayWorld
// (block 4, real API) or SimWorld (block 7, the generator + counterfactual);
// this exists purely to prove run() drives the World port correctly without
// needing either of those built yet.
import type { World } from "../../src/ports/world.js";
import type { ExecResult, Intent, Order } from "../../src/types.js";

export class FakeWorld implements World {
  calls: { method: string; intent: Intent }[] = [];
  orderStatus: Order["status"] = "attempted";

  constructor(private readonly order: Order) {}

  async getOrder(id: string): Promise<Order> {
    if (id !== this.order.id) throw new Error(`FakeWorld: unknown order ${id}`);
    return { ...this.order, status: this.orderStatus };
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
