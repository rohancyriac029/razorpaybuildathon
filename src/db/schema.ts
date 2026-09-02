// SQLite + Drizzle. Zero setup, reviewer can run it (spec §3.2).
// This schema is what makes "every decision auditable ... replayable from
// the DB" (spec §6 non-negotiables) a real property and not a slogan.

import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  razorpayCustomerId: text("razorpay_customer_id").notNull(),
  name: text("name"),
  createdAt: text("created_at").notNull(),
});

// Separate from `orders`: a subscription is a longer-lived Razorpay entity
// that creates many charge attempts (orders) over its life. subscription.pending
// and subscription.halted webhooks carry a subscription id, not an order id
// (confirmed against razorpay.com/docs/webhooks/subscriptions/, 2026-09-02),
// so lifecycle state lives here, separate from the taxonomy-classified
// `failures` table. See src/webhooks/handler.ts for why these are decoupled.
export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  razorpaySubscriptionId: text("razorpay_subscription_id").notNull().unique(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id),
  status: text("status", {
    enum: ["active", "pending", "halted", "cancelled"],
  })
    .notNull()
    .default("active"),
  authAttempts: integer("auth_attempts").notNull().default(0),
  planAmount: integer("plan_amount").notNull(), // paise
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  razorpayOrderId: text("razorpay_order_id").notNull().unique(),
  razorpaySubscriptionId: text("razorpay_subscription_id"),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id),
  amount: integer("amount").notNull(), // paise
  currency: text("currency").notNull().default("INR"),
  status: text("status", {
    enum: ["created", "attempted", "paid", "cancelled"],
  })
    .notNull()
    .default("created"),
  createdAt: text("created_at").notNull(),
});

// Dedupe table for inbound webhooks. Primary key on event_id makes a
// second delivery of the same event a no-op insert, not a re-process.
export const webhookEvents = sqliteTable("webhook_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
});

export const failures = sqliteTable("failures", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id),
  eventId: text("event_id")
    .notNull()
    .references(() => webhookEvents.eventId),
  razorpayPaymentId: text("razorpay_payment_id"),
  errorCode: text("error_code"),
  errorSource: text("error_source"),
  errorStep: text("error_step"),
  errorReason: text("error_reason"),
  category: text("category", {
    enum: ["TRANSIENT", "FUNDS", "AUTH_ABANDONED", "INSTRUMENT", "TERMINAL"],
  }).notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  occurredAt: text("occurred_at").notNull(),
});

// Episode = the order, not the failure (spec §3). One row per strategy
// invocation on an order. context_hash + reasoning + proposal + verdict +
// exec_result + outcome is the full audit chain the static page renders.
export const episodes = sqliteTable("episodes", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id),
  attemptNumber: integer("attempt_number").notNull(),
  strategyName: text("strategy_name").notNull(),
  contextHash: text("context_hash").notNull(),
  reasoning: text("reasoning").notNull(),
  proposal: text("proposal", { mode: "json" }).notNull(),
  verdictKind: text("verdict_kind", {
    enum: ["APPROVE", "REJECT", "MODIFY"],
  }).notNull(),
  verdictRuleId: text("verdict_rule_id").notNull(),
  verdictReason: text("verdict_reason").notNull(),
  execResult: text("exec_result", { mode: "json" }),
  outcome: text("outcome", {
    enum: [
      "recovered",
      "failed_again",
      "no_response",
      "pending",
      "escalated",
      "rejected",
    ],
  }),
  runId: text("run_id"), // ties an episode to one eval run, null in production
  createdAt: text("created_at").notNull(),
});

export const intents = sqliteTable("intents", {
  id: text("id").primaryKey(),
  episodeId: text("episode_id")
    .notNull()
    .references(() => episodes.id),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id),
  attemptNumber: integer("attempt_number").notNull(),
  proposalType: text("proposal_type").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(), // P7
  status: text("status", {
    enum: ["pending", "executed", "rejected", "escalated"],
  }).notNull(),
  razorpayRefId: text("razorpay_ref_id"),
  createdAt: text("created_at").notNull(),
});

// Eval-only: one row per scenario x strategy x seed run, keyed for the
// paired bootstrap comparison (spec §5.8).
export const evalRuns = sqliteTable("eval_runs", {
  id: text("id").primaryKey(),
  configName: text("config_name").notNull(), // "A" | "B"
  strategyName: text("strategy_name").notNull(),
  scenarioId: text("scenario_id").notNull(),
  seed: integer("seed").notNull(),
  recovered: integer("recovered", { mode: "boolean" }).notNull(),
  netRecoveredPaise: real("net_recovered_paise").notNull(),
  wastedAttempts: integer("wasted_attempts").notNull(),
  contactsUsed: integer("contacts_used").notNull(),
  terminalRetriesProposed: integer("terminal_retries_proposed").notNull(),
  terminalRetriesExecuted: integer("terminal_retries_executed").notNull(),
  offersProposed: integer("offers_proposed").notNull(), // §5.5.1
  offersSent: integer("offers_sent").notNull(),
  timeToRecoveryMs: integer("time_to_recovery_ms"),
  oracleHeadroomPaise: real("oracle_headroom_paise"),
  llmCostPaiseUsd: real("llm_cost_paise_usd"), // cost in USD cents, converted at report time
  createdAt: text("created_at").notNull(),
});

// LLM response cache, committed to the repo (spec §5.8).
export const llmCache = sqliteTable("llm_cache", {
  cacheKey: text("cache_key").primaryKey(), // hash(systemPrompt, toolResults, seed)
  response: text("response", { mode: "json" }).notNull(),
  createdAt: text("created_at").notNull(),
});
