// Spec §6 block 3: "End-to-end spine with a stub strategy. Fake webhook ->
// decide -> intent -> executor -> row in DB. First demoable artifact."
//
// This is the one test that proves the whole architecture wires together
// for real: a signed HTTP request hits the actual Fastify route (not a
// direct function call), through real signature verification, real
// classification, into a real (in-memory, schema-migrated) database — then
// a real context assembly, a real policy engine, and a real logger, with
// only the Strategy (stub — Rules/Agent don't exist yet) and the World
// (fake — RazorpayWorld/SimWorld don't exist yet) swapped for test doubles.
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./helpers/test-db.js";
import { FakeWorld } from "./helpers/fake-world.js";
import * as schema from "../src/db/schema.js";
import { buildServer } from "../src/server.js";
import { assembleEpisodeContext } from "../src/context/assemble.js";
import { RulesPolicyEngine } from "../src/policy/engine.js";
import { DEFAULT_POLICY_CONFIG } from "../src/policy/rules.js";
import { VirtualScheduler } from "../src/scheduler/virtual.js";
import { StubStrategy } from "../src/strategies/stub.js";
import { makeEpisodeLogger } from "../src/persistence/episode-logger.js";
import { run } from "../src/run.js";
import type { Order } from "../src/types.js";

const WEBHOOK_SECRET = "spine_test_secret";

function sign(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

describe("end-to-end spine: fake webhook -> decide -> intent -> executor -> row in DB", () => {
  it("wires the real webhook route through run() to a persisted, executed episode", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const db = makeTestDb();
    const app = buildServer(db);

    // 1. A real HTTP request hits the real route, with a real HMAC signature.
    const payload = {
      event: "payment.failed",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: "pay_spine1",
            order_id: "order_spine1",
            amount: 49900,
            currency: "INR",
            error_code: "GATEWAY_ERROR",
            error_description: "gateway timeout",
            error_source: "gateway",
            error_step: "payment_authorization",
            error_reason: "gateway_technical_error", // -> TRANSIENT
            customer_id: "cust_spine1",
          },
        },
      },
    };
    const body = JSON.stringify(payload);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/razorpay",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": sign(body),
        "x-razorpay-event-id": "evt_spine1",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);

    // 2. CLASSIFY already happened (block 1) inside that request — confirm it landed.
    const order = db.select().from(schema.orders).where(eq(schema.orders.razorpayOrderId, "order_spine1")).get();
    expect(order).toBeDefined();
    const failure = db.select().from(schema.failures).where(eq(schema.failures.orderId, order!.id)).get();
    expect(failure?.category).toBe("TRANSIENT");

    // 3. Assemble context, run the real pipeline: PROPOSE -> GATE -> EXECUTE -> LOG.
    // Fixed clock, not `new Date()`: StubStrategy proposes sendAt = now+2h,
    // and a real "now" would make P4's blackout-window check flaky
    // depending on what time of day the test happens to run.
    const now = new Date("2026-09-02T10:00:00Z"); // 15:30 IST, safe daytime; +2h = 17:30 IST, also safe
    const ctx = assembleEpisodeContext(db, order!.id, now);
    expect(ctx.failureContext.attemptNumber).toBe(1);
    expect(ctx.history.isFirstTime).toBe(true);

    const strategy = new StubStrategy();
    const scheduler = new VirtualScheduler(now);
    const world = new FakeWorld(db);
    const policy = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);
    const logger = makeEpisodeLogger(db, strategy.name, null);

    const entry = await run(strategy, scheduler, world, policy, ctx, logger);

    // 4. The pipeline actually executed (a clean TRANSIENT failure, no rule objects).
    expect(entry.verdict.kind).toBe("APPROVE");
    expect(entry.execResult?.ok).toBe(true);
    expect(entry.execResult?.razorpayRefId).toBe("plink_fake_1");
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]!.method).toBe("createPaymentLink");

    // 5. LOG really persisted — one row in episodes, one in intents.
    const episodes = db.select().from(schema.episodes).where(eq(schema.episodes.orderId, order!.id)).all();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.verdictKind).toBe("APPROVE");
    expect(episodes[0]!.strategyName).toBe("stub");

    const intents = db.select().from(schema.intents).where(eq(schema.intents.orderId, order!.id)).all();
    expect(intents).toHaveLength(1);
    expect(intents[0]!.status).toBe("executed");
    expect(intents[0]!.razorpayRefId).toBe("plink_fake_1");

    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  it("rejects a webhook with an invalid signature at the real HTTP boundary (401, nothing persisted)", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const db = makeTestDb();
    const app = buildServer(db);

    const body = JSON.stringify({ event: "payment.failed", payload: {} });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/razorpay",
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": "not-the-real-signature",
        "x-razorpay-event-id": "evt_bad_sig",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    const events = db.select().from(schema.webhookEvents).all();
    expect(events).toHaveLength(0);

    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  it("the P3/TERMINAL trap closes end-to-end: a TERMINAL failure, a strategy that (mis)proposes a retry anyway, gets rejected by the real policy engine", async () => {
    // This is the demo's central beat (spec §5.5, §8): show the model
    // proposing a retry on a blocked-card case, and the policy engine
    // catching it. StubStrategy always proposes PAYMENT_LINK regardless of
    // category — that's exactly the adversarial shape this proves against.
    const db = makeTestDb();
    db.insert(schema.customers).values({ id: "cust_t", razorpayCustomerId: "rzp_cust_t", createdAt: new Date().toISOString() }).run();
    db.insert(schema.orders)
      .values({
        id: "order_t",
        razorpayOrderId: "rzp_order_t",
        razorpaySubscriptionId: null,
        customerId: "cust_t",
        amount: 49900,
        currency: "INR",
        status: "attempted",
        createdAt: new Date().toISOString(),
      })
      .run();
    db.insert(schema.webhookEvents)
      .values({ eventId: "evt_t", type: "payment.failed", payload: {}, receivedAt: new Date().toISOString() })
      .run();
    db.insert(schema.failures)
      .values({
        id: "fail_t",
        orderId: "order_t",
        eventId: "evt_t",
        razorpayPaymentId: "pay_t",
        errorCode: "GATEWAY_ERROR",
        errorSource: "gateway",
        errorStep: "payment_authorization",
        errorReason: "debit_instrument_blocked", // -> TERMINAL
        category: "TERMINAL",
        attemptNumber: 1,
        occurredAt: new Date().toISOString(),
      })
      .run();

    const now = new Date("2026-09-02T10:00:00Z"); // fixed clock — see test 1's comment
    const ctx = assembleEpisodeContext(db, "order_t", now);
    expect(ctx.failureContext.failure.category).toBe("TERMINAL");

    const strategy = new StubStrategy(); // proposes PAYMENT_LINK unconditionally — the adversarial case
    const scheduler = new VirtualScheduler(now);
    const world = new FakeWorld(db);
    const policy = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);
    const logger = makeEpisodeLogger(db, strategy.name, null);

    const entry = await run(strategy, scheduler, world, policy, ctx, logger);

    expect(entry.verdict.kind).toBe("REJECT");
    expect(entry.verdict.ruleId).toBe("P3");
    expect(entry.execResult).toBeNull(); // nothing reached the card
    expect(world.calls).toHaveLength(0); // the World was never touched

    const intents = db.select().from(schema.intents).where(eq(schema.intents.orderId, "order_t")).all();
    expect(intents[0]!.status).toBe("rejected");
  });
});
