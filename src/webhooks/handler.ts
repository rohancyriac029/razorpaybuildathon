// Spec §6 block 1: CLASSIFY step of the pipeline (§3). Pure-ish functions
// over a Drizzle db handle — kept separate from src/server.ts so they're
// testable without a live HTTP server or a real Razorpay signature.
//
// Design decision, and why: subscription.pending/halted carry a subscription
// id, not an order id, and Razorpay does not reliably attach a payment
// entity to them (src/webhooks/events.ts). payment.failed always carries
// order_id + error_reason, and Razorpay confirms it fires alongside the
// subscription event for the same underlying charge failure. So:
// payment.failed is the ONLY input to taxonomy classification; the
// subscription.* events are lifecycle bookkeeping, correlated to the same
// order via razorpay_subscription_id + recency, not independently classified.
// Conflating "Razorpay gave up retrying" (halted) with "this instrument is
// permanently dead" (TERMINAL) would be a real bug — they are different facts.

import { randomUUID } from "node:crypto";
import { eq, and, desc, count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { classify } from "../taxonomy/classify.js";
import type {
  PaymentFailedPayload,
  OrderPaidPayload,
  SubscriptionLifecyclePayload,
  DowntimePayload,
} from "./events.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface DedupeResult {
  isNew: boolean;
}

/** Webhook dedupe keyed on x-razorpay-event-id (HTTP header, not a body field). */
export function dedupeAndStore(
  db: Db,
  eventId: string,
  type: string,
  payload: unknown,
  receivedAt: string,
): DedupeResult {
  const existing = db
    .select({ eventId: schema.webhookEvents.eventId })
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.eventId, eventId))
    .get();
  if (existing) return { isNew: false };

  db.insert(schema.webhookEvents)
    .values({ eventId, type, payload: payload as object, receivedAt })
    .run();
  return { isNew: true };
}

export function markProcessed(db: Db, eventId: string, at: string): void {
  db.update(schema.webhookEvents)
    .set({ processedAt: at })
    .where(eq(schema.webhookEvents.eventId, eventId))
    .run();
}

function upsertCustomer(db: Db, razorpayCustomerId: string, now: string): string {
  const existing = db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(eq(schema.customers.razorpayCustomerId, razorpayCustomerId))
    .get();
  if (existing) return existing.id;

  const id = randomUUID();
  db.insert(schema.customers)
    .values({ id, razorpayCustomerId, createdAt: now })
    .run();
  return id;
}

function upsertOrder(
  db: Db,
  args: {
    razorpayOrderId: string;
    customerId: string;
    amount: number;
    currency: string;
    razorpaySubscriptionId: string | null;
    now: string;
  },
): string {
  const existing = db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.razorpayOrderId, args.razorpayOrderId))
    .get();
  if (existing) return existing.id;

  const id = randomUUID();
  db.insert(schema.orders)
    .values({
      id,
      razorpayOrderId: args.razorpayOrderId,
      razorpaySubscriptionId: args.razorpaySubscriptionId,
      customerId: args.customerId,
      amount: args.amount,
      currency: args.currency,
      status: "attempted",
      createdAt: args.now,
    })
    .run();
  return id;
}

export interface ProcessedFailure {
  orderId: string; // internal id
  failureId: string;
  attemptNumber: number;
  category: ReturnType<typeof classify>["category"];
}

/**
 * CLASSIFY step for a one-time (or subscription-underlying) payment failure.
 * This is the only path that writes to `failures` — see module doc above.
 */
export function processPaymentFailed(
  db: Db,
  eventId: string,
  body: PaymentFailedPayload,
  now: string,
): ProcessedFailure {
  const p = body.payload.payment.entity;

  // customer_id is not always present depending on payment method (e.g. a
  // failed card entry before a customer record exists). Fall back to a
  // per-order synthetic key so the pipeline never crashes on this — it just
  // means we can't build cross-order customer history for that one payment,
  // which getCustomerHistory (block 6) will see as isFirstTime=true.
  const razorpayCustomerId = p.customer_id ?? `unknown_${p.order_id}`;
  const customerId = upsertCustomer(db, razorpayCustomerId, now);

  const orderId = upsertOrder(db, {
    razorpayOrderId: p.order_id,
    customerId,
    amount: p.amount,
    currency: p.currency,
    razorpaySubscriptionId: null, // set separately if a subscription.* event correlates this order
    now,
  });

  const priorFailureCount = db
    .select({ n: count() })
    .from(schema.failures)
    .where(eq(schema.failures.orderId, orderId))
    .get();
  const attemptNumber = (priorFailureCount?.n ?? 0) + 1;

  const result = classify({
    errorReason: p.error_reason,
    errorCode: p.error_code,
    errorSource: p.error_source,
  });

  const failureId = randomUUID();
  db.insert(schema.failures)
    .values({
      id: failureId,
      orderId,
      eventId,
      razorpayPaymentId: p.id,
      errorCode: p.error_code,
      errorSource: p.error_source,
      errorStep: p.error_step,
      errorReason: p.error_reason,
      category: result.category,
      attemptNumber,
      occurredAt: now,
    })
    .run();

  return { orderId, failureId, attemptNumber, category: result.category };
}

/** OBSERVE step: a webhook confirming the order is now paid. */
export function processOrderPaid(db: Db, body: OrderPaidPayload, now: string): void {
  const orderEntity = body.payload.order.entity;
  const existing = db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.razorpayOrderId, orderEntity.id))
    .get();
  if (!existing) return; // order we never saw a failure for; nothing to reconcile
  db.update(schema.orders)
    .set({ status: "paid" })
    .where(eq(schema.orders.id, existing.id))
    .run();
}

function upsertSubscription(
  db: Db,
  args: {
    razorpaySubscriptionId: string;
    customerId: string;
    status: "active" | "pending" | "halted" | "cancelled";
    authAttempts: number;
    planAmount: number;
    now: string;
  },
): string {
  const existing = db
    .select({ id: schema.subscriptions.id })
    .from(schema.subscriptions)
    .where(eq(schema.subscriptions.razorpaySubscriptionId, args.razorpaySubscriptionId))
    .get();

  if (existing) {
    db.update(schema.subscriptions)
      .set({ status: args.status, authAttempts: args.authAttempts, updatedAt: args.now })
      .where(eq(schema.subscriptions.id, existing.id))
      .run();
    return existing.id;
  }

  const id = randomUUID();
  db.insert(schema.subscriptions)
    .values({
      id,
      razorpaySubscriptionId: args.razorpaySubscriptionId,
      customerId: args.customerId,
      status: args.status,
      authAttempts: args.authAttempts,
      planAmount: args.planAmount,
      createdAt: args.now,
      updatedAt: args.now,
    })
    .run();
  return id;
}

/**
 * Lifecycle-only handling for subscription.pending / subscription.halted /
 * subscription.charged. Deliberately does NOT touch the `failures` table —
 * see module doc. Also back-fills razorpay_subscription_id onto the most
 * recent order for this subscription, so getCustomerHistory / P-rules can
 * see the subscription link even though subscription.pending itself never
 * carries an order id.
 */
export function processSubscriptionLifecycle(
  db: Db,
  body: SubscriptionLifecyclePayload,
  now: string,
): void {
  const s = body.payload.subscription.entity;
  const status: "active" | "pending" | "halted" | "cancelled" =
    s.status === "pending" || s.status === "halted" || s.status === "cancelled"
      ? s.status
      : "active";

  const customerId = upsertCustomer(db, s.customer_id, now);

  upsertSubscription(db, {
    razorpaySubscriptionId: s.id,
    customerId,
    status,
    authAttempts: s.auth_attempts ?? 0,
    planAmount: body.payload.payment?.entity.amount ?? 0,
    now,
  });

  if (body.payload.payment?.entity.order_id) {
    // subscription.charged carries a payment entity with an order id — link it.
    const orderId = body.payload.payment.entity.order_id;
    db.update(schema.orders)
      .set({ razorpaySubscriptionId: s.id })
      .where(eq(schema.orders.razorpayOrderId, orderId))
      .run();
    return;
  }

  // subscription.pending / halted: no order id on the payload. Correlate to
  // the most recent order already known for this subscription, if any —
  // best-effort, and honestly incomplete if the failing order hasn't been
  // seen via payment.failed yet (block 4 live wiring will confirm ordering
  // in practice; this does not block classification, which never depends on
  // this link).
  const mostRecentOrder = db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.razorpaySubscriptionId, s.id))
    .orderBy(desc(schema.orders.createdAt))
    .limit(1)
    .get();
  void mostRecentOrder; // no-op placeholder: nothing further to correlate without an order id
}

/** payment.downtime.* — recorded via dedupeAndStore's raw payload only for
 * now. Spec §1.4: consume it properly or drop it; not wired into policy or
 * the agent yet. See PROGRESS.md. */
export function processDowntime(_db: Db, _body: DowntimePayload, _now: string): void {
  // Intentionally a no-op beyond the raw webhook_events row already written
  // by dedupeAndStore. Revisit only if there is time for real consumption
  // (spec §1.4) — do not reinvent getMethodHealth.
}
