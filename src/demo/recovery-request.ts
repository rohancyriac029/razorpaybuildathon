import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type Razorpay from "razorpay";
import * as schema from "../db/schema.js";
import { dedupeAndStore, processPaymentFailed } from "../webhooks/handler.js";
import type { PaymentFailedPayload } from "../webhooks/events.js";
import { run } from "../run.js";
import { assembleEpisodeContext } from "../context/assemble.js";
import type { Strategy } from "../ports/strategy.js";
import type { PolicyEngine } from "../ports/policy-engine.js";
import type { World } from "../ports/world.js";
import type { ExecResult, Intent, Order } from "../types.js";
import { makeEpisodeLogger } from "../persistence/episode-logger.js";
import { RazorpayWorld } from "../world/razorpay-world.js";

type Db = BetterSQLite3Database<typeof schema>;

class DemoScheduler {
  constructor(private readonly currentTime: Date) {}
  now(): Date {
    return this.currentTime;
  }
  async scheduleAt(_time: Date, intentId: string): Promise<void> {
    if (this.callback) await this.callback(intentId, this.currentTime);
  }
  onFire(callback: (intentId: string, at: Date) => Promise<void>): void {
    this.callback = callback;
  }
  private callback: ((intentId: string, at: Date) => Promise<void>) | null = null;
}

/** A no-network World for browser demos. It exercises the same execution boundary without creating Razorpay objects or contacting customers. */
class DemoWorld implements World {
  constructor(private readonly db: Db) {}

  async getOrder(id: string): Promise<Order> {
    const row = this.db.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
    if (!row) throw new Error(`DemoWorld: order not found ${id}`);
    return row;
  }

  async createPaymentLink(intent: Intent): Promise<ExecResult> {
    return this.accept(intent, "payment link action accepted (simulated; not sent)");
  }

  async sendNudge(intent: Intent): Promise<ExecResult> {
    return this.accept(intent, "customer nudge accepted (simulated; not sent)");
  }

  async chargeToken(intent: Intent): Promise<ExecResult> {
    return this.accept(intent, "token retry accepted (simulated; not charged)");
  }

  private accept(intent: Intent, detail: string): ExecResult {
    return {
      intentId: intent.id,
      ok: true,
      razorpayRefId: null,
      detail,
      executedAt: new Date().toISOString(),
    };
  }
}

export async function runDemoRecoveryRequest(
  db: Db,
  strategy: Strategy,
  policy: PolicyEngine,
  input: { errorReason: string; amountPaise: number },
): Promise<string> {
  const now = new Date();
  const orderId = `order_demo_request_${randomUUID().slice(0, 8)}`;
  const paymentId = `pay_demo_request_${randomUUID().slice(0, 8)}`;
  const eventId = `evt_demo_request_${randomUUID()}`;
  const payload: PaymentFailedPayload = {
    event: "payment.failed",
    created_at: Math.floor(now.getTime() / 1000),
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: input.amountPaise,
          currency: "INR",
          error_code: input.errorReason,
          error_description: input.errorReason,
          error_source: "gateway",
          error_step: "payment_authentication",
          error_reason: input.errorReason,
          customer_id: `cust_demo_request_${orderId}`,
        },
      },
    },
  };

  dedupeAndStore(db, eventId, "payment.failed", payload, now.toISOString());
  const processed = processPaymentFailed(db, eventId, payload, now.toISOString());
  const scheduler = new DemoScheduler(now);
  const world = new DemoWorld(db);
  const log = makeEpisodeLogger(db, strategy.name, null);
  scheduler.onFire(async () => undefined);

  const context = assembleEpisodeContext(db, processed.orderId, now);
  await run(strategy, scheduler, world, policy, context, log);

  return processed.orderId;
}

export async function runLiveDemoRecoveryRequest(
  db: Db,
  rzp: Razorpay,
  strategy: Strategy,
  policy: PolicyEngine,
  input: { errorReason: string; amountPaise: number },
): Promise<string> {
  const rzpOrder = await rzp.orders.create({ amount: input.amountPaise, currency: "INR", notes: { salvage_demo: "recovery" } });
  const now = new Date();
  const eventId = `evt_demo_live_${randomUUID()}`;
  const paymentId = `pay_demo_live_${randomUUID().slice(0, 8)}`;
  const payload: PaymentFailedPayload = {
    event: "payment.failed",
    created_at: Math.floor(now.getTime() / 1000),
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: rzpOrder.id,
          amount: input.amountPaise,
          currency: "INR",
          error_code: input.errorReason,
          error_description: input.errorReason,
          error_source: "gateway",
          error_step: "payment_authentication",
          error_reason: input.errorReason,
          customer_id: `cust_demo_live_${rzpOrder.id}`,
        },
      },
    },
  };

  dedupeAndStore(db, eventId, "payment.failed", payload, now.toISOString());
  const processed = processPaymentFailed(db, eventId, payload, now.toISOString());
  const context = assembleEpisodeContext(db, processed.orderId, now);
  const log = makeEpisodeLogger(db, strategy.name, null);
  const world = new RazorpayWorld(rzp, db);
  await run(strategy, { now: () => now }, world, policy, context, log);
  return processed.orderId;
}
