import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import {
  dedupeAndStore,
  processPaymentFailed,
  processOrderPaid,
  processSubscriptionLifecycle,
} from "../src/webhooks/handler.js";
import type { PaymentFailedPayload, OrderPaidPayload, SubscriptionLifecyclePayload } from "../src/webhooks/events.js";

function paymentFailedPayload(overrides: Partial<PaymentFailedPayload["payload"]["payment"]["entity"]> = {}): PaymentFailedPayload {
  return {
    event: "payment.failed",
    created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment: {
        entity: {
          id: "pay_test1",
          order_id: "order_test1",
          amount: 49900,
          currency: "INR",
          error_code: "BAD_REQUEST_ERROR",
          error_description: "insufficient funds",
          error_source: "customer",
          error_step: "payment_authorization",
          error_reason: "insufficient_funds",
          customer_id: "cust_test1",
          ...overrides,
        },
      },
    },
  };
}

describe("webhook dedupe", () => {
  it("processes a new event id and skips a repeat delivery", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();

    const first = dedupeAndStore(db, "evt_1", "payment.failed", { hello: "world" }, now);
    expect(first.isNew).toBe(true);

    const second = dedupeAndStore(db, "evt_1", "payment.failed", { hello: "world" }, now);
    expect(second.isNew).toBe(false);

    const rows = db.select().from(schema.webhookEvents).all();
    expect(rows.length).toBe(1);
  });
});

describe("processPaymentFailed", () => {
  it("creates a customer, an order, and a classified failure row", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();

    dedupeAndStore(db, "evt_1", "payment.failed", {}, now);
    const result = processPaymentFailed(db, "evt_1", paymentFailedPayload(), now);

    expect(result.attemptNumber).toBe(1);
    expect(result.category).toBe("FUNDS");

    const order = db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, result.orderId))
      .get();
    expect(order?.razorpayOrderId).toBe("order_test1");
    expect(order?.amount).toBe(49900);

    const failure = db
      .select()
      .from(schema.failures)
      .where(eq(schema.failures.id, result.failureId))
      .get();
    expect(failure?.category).toBe("FUNDS");
    expect(failure?.razorpayPaymentId).toBe("pay_test1");
  });

  it("increments attemptNumber across repeated failures on the same order", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();

    dedupeAndStore(db, "evt_1", "payment.failed", {}, now);
    dedupeAndStore(db, "evt_2", "payment.failed", {}, now);
    const first = processPaymentFailed(db, "evt_1", paymentFailedPayload({ id: "pay_a" }), now);
    const second = processPaymentFailed(
      db,
      "evt_2",
      paymentFailedPayload({ id: "pay_b", error_reason: "gateway_technical_error" }),
      now,
    );

    expect(first.attemptNumber).toBe(1);
    expect(second.attemptNumber).toBe(2);
    expect(first.orderId).toBe(second.orderId); // same order, reused not duplicated
  });

  it("reuses the existing order row rather than creating a duplicate", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();
    dedupeAndStore(db, "evt_1", "payment.failed", {}, now);
    dedupeAndStore(db, "evt_2", "payment.failed", {}, now);
    processPaymentFailed(db, "evt_1", paymentFailedPayload({ id: "pay_a" }), now);
    processPaymentFailed(db, "evt_2", paymentFailedPayload({ id: "pay_b" }), now);

    const orders = db.select().from(schema.orders).all();
    expect(orders.length).toBe(1);
  });

  it("falls back to a synthetic customer key when customer_id is absent, without crashing", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();
    dedupeAndStore(db, "evt_1", "payment.failed", {}, now);
    const result = processPaymentFailed(
      db,
      "evt_1",
      paymentFailedPayload({ customer_id: null }),
      now,
    );
    expect(result.category).toBe("FUNDS");
    const customers = db.select().from(schema.customers).all();
    expect(customers.length).toBe(1);
    expect(customers[0]!.razorpayCustomerId).toBe("unknown_order_test1");
  });

  it("fails closed to TERMINAL on an unmapped error_reason", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();
    dedupeAndStore(db, "evt_1", "payment.failed", {}, now);
    const result = processPaymentFailed(
      db,
      "evt_1",
      paymentFailedPayload({ error_reason: "some_future_razorpay_reason" }),
      now,
    );
    expect(result.category).toBe("TERMINAL");
  });
});

describe("processOrderPaid", () => {
  it("marks a known order as paid", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();
    dedupeAndStore(db, "evt_1", "payment.failed", {}, now);
    const { orderId } = processPaymentFailed(db, "evt_1", paymentFailedPayload(), now);

    const paidPayload: OrderPaidPayload = {
      event: "order.paid",
      created_at: Math.floor(Date.now() / 1000),
      payload: { order: { entity: { id: "order_test1", amount: 49900 } } },
    };
    processOrderPaid(db, paidPayload, now);

    const order = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
    expect(order?.status).toBe("paid");
  });

  it("is a no-op for an order we never saw a failure for (does not crash)", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();
    const paidPayload: OrderPaidPayload = {
      event: "order.paid",
      created_at: Math.floor(Date.now() / 1000),
      payload: { order: { entity: { id: "order_never_seen", amount: 100 } } },
    };
    expect(() => processOrderPaid(db, paidPayload, now)).not.toThrow();
    const orders = db.select().from(schema.orders).all();
    expect(orders.length).toBe(0);
  });
});

describe("processSubscriptionLifecycle", () => {
  function lifecyclePayload(
    event: SubscriptionLifecyclePayload["event"],
    overrides: Partial<SubscriptionLifecyclePayload["payload"]["subscription"]["entity"]> = {},
  ): SubscriptionLifecyclePayload {
    return {
      event,
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        subscription: {
          entity: {
            id: "sub_test1",
            customer_id: "cust_test1",
            status: event === "subscription.pending" ? "pending" : event === "subscription.halted" ? "halted" : "active",
            auth_attempts: 1,
            ...overrides,
          },
        },
      },
    };
  }

  it("creates a subscription row on subscription.pending and does NOT write a failures row", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();

    processSubscriptionLifecycle(db, lifecyclePayload("subscription.pending"), now);

    const subs = db.select().from(schema.subscriptions).all();
    expect(subs.length).toBe(1);
    expect(subs[0]!.status).toBe("pending");
    expect(subs[0]!.authAttempts).toBe(1);

    const failures = db.select().from(schema.failures).all();
    expect(failures.length).toBe(0); // load-bearing: lifecycle events never taxonomy-classify
  });

  it("updates auth_attempts and status across pending -> halted", () => {
    const db = makeTestDb();
    const now = new Date().toISOString();

    processSubscriptionLifecycle(db, lifecyclePayload("subscription.pending", { auth_attempts: 1 }), now);
    processSubscriptionLifecycle(db, lifecyclePayload("subscription.pending", { auth_attempts: 2 }), now);
    processSubscriptionLifecycle(db, lifecyclePayload("subscription.halted", { auth_attempts: 4 }), now);

    const subs = db.select().from(schema.subscriptions).all();
    expect(subs.length).toBe(1); // upsert, not insert-per-event
    expect(subs[0]!.status).toBe("halted");
    expect(subs[0]!.authAttempts).toBe(4);
  });
});
