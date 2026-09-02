// Spec §6 block 7: the eval's World — resolves ground truth instead of
// calling live Razorpay. Registered scenarios are keyed by internal
// orderId; createPaymentLink/sendNudge/chargeToken all funnel through the
// same wouldSucceed() check (spec §5.1/§5.6), differing only in which
// lever they represent.
//
// Resolution happens SYNCHRONOUSLY at execution time (spec §3.1's virtual
// clock means "does this succeed" can be answered immediately — there is
// no real customer to wait on). That's a real simplification versus
// production, where order.paid arrives asynchronously via webhook, stated
// here rather than left implicit.
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { World } from "../ports/world.js";
import type { ExecResult, Intent, Order } from "../types.js";
import type { GeneratorConfig } from "../eval/generator-config.js";
import type { ScenarioRegistry } from "../eval/scenario-registry.js";
import { wouldSucceed } from "../eval/ground-truth.js";

type Db = BetterSQLite3Database<typeof schema>;

export class SimWorld implements World {
  constructor(
    private readonly db: Db,
    private readonly config: GeneratorConfig,
    private readonly registry: ScenarioRegistry,
  ) {}

  async getOrder(id: string): Promise<Order> {
    const row = this.db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
    if (!row) throw new Error(`SimWorld.getOrder: no order ${id}`);
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
    return this.resolve(intent, "plink_sim");
  }
  async sendNudge(intent: Intent): Promise<ExecResult> {
    return this.resolve(intent, null); // a nudge references an existing link, not a new Razorpay object
  }

  /**
   * Always fails: this build never models a confirmed mandate token (see
   * scenario.ts's doc) because RazorpayWorld.chargeToken (block 4) is
   * itself untested against a live mandate — Subscriptions entitlement is
   * unconfirmed. Modeling a lever this build can't verify live would let
   * the eval report a number nothing backs.
   */
  async chargeToken(intent: Intent): Promise<ExecResult> {
    return {
      intentId: intent.id,
      ok: false,
      razorpayRefId: null,
      detail: "SimWorld: no confirmed mandate token modeled in this build (see PROGRESS.md block 7)",
      executedAt: intent.createdAt,
    };
  }

  private async resolve(intent: Intent, refPrefix: string | null): Promise<ExecResult> {
    const scenario = this.registry.get(intent.orderId);
    const at = new Date(intent.createdAt); // the proposal's own sendAt — see run.ts's executionTime fix
    const succeeded = wouldSucceed(scenario, intent.proposal, at, this.config);

    if (succeeded) {
      this.db.update(schema.orders).set({ status: "paid" }).where(eq(schema.orders.id, intent.orderId)).run();
    }

    return {
      intentId: intent.id,
      ok: true, // the send itself always "succeeds" — whether the customer pays is `succeeded`, reflected via order.status
      razorpayRefId: refPrefix ? `${refPrefix}_${intent.id.slice(0, 8)}` : null,
      detail: succeeded ? "simulated: customer paid" : "simulated: customer did not pay (yet)",
      executedAt: intent.createdAt,
    };
  }
}
