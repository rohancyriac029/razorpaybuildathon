// v3 agentic-commerce surface (spec §3 precondition, §4 "why this ordering
// is the point"). Creates the order row a purchase gates against, BEFORE
// the buyer agent ever runs. This is what makes the amount reaching the
// policy engine a catalog fact, never a model output — the same discipline
// P6/P14 already enforce for recovery, just enforced earlier in the
// pipeline here because a purchase (unlike a recovery) doesn't inherit an
// order from an inbound webhook.
//
// orders.customerId is NOT NULL (FK to customers.id) and razorpayOrderId is
// NOT NULL UNIQUE (src/db/schema.ts) — both must exist before decidePurchase()
// can even construct a PolicyContext, since P9 reads ctx.order.amount.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type Razorpay from "razorpay";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import type { Order } from "../types.js";
import { priceOf } from "./catalog.js";

type Db = BetterSQLite3Database<typeof schema>;

function upsertBuyerCustomer(db: Db, buyerId: string, now: string): string {
  const razorpayCustomerId = `buyer_${buyerId}`;
  const existing = db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(eq(schema.customers.razorpayCustomerId, razorpayCustomerId))
    .get();
  if (existing) return existing.id;

  const id = randomUUID();
  db.insert(schema.customers).values({ id, razorpayCustomerId, createdAt: now }).run();
  return id;
}

/**
 * Creates a REAL Razorpay order (test mode) for one purchase attempt, priced
 * from the catalog, and persists the local order row decidePurchase() will
 * gate against. quantity >= 1; amount = priceOf(sku) * quantity.
 */
export async function createPurchaseOrder(
  db: Db,
  rzp: Razorpay,
  buyerId: string,
  sku: string,
  quantity: number,
): Promise<Order> {
  const now = new Date().toISOString();
  const customerId = upsertBuyerCustomer(db, buyerId, now);
  const amount = priceOf(sku) * quantity;

  const rzpOrder = await rzp.orders.create({
    amount,
    currency: "INR",
    notes: { salvage_buyer_id: buyerId, salvage_sku: sku, salvage_quantity: String(quantity) },
  });

  const id = randomUUID();
  db.insert(schema.orders)
    .values({
      id,
      razorpayOrderId: rzpOrder.id,
      razorpaySubscriptionId: null,
      customerId,
      amount,
      currency: "INR",
      status: "created",
      createdAt: now,
    })
    .run();

  return {
    id,
    razorpayOrderId: rzpOrder.id,
    razorpaySubscriptionId: null,
    customerId,
    amount,
    currency: "INR",
    status: "created",
    createdAt: now,
  };
}
