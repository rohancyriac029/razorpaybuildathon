// Proves buildServer's onPaymentFailed hook wires a real webhook all the
// way through decide() -> scheduled executeApproved(), the same shape
// production uses (src/server.ts's entrypoint), but with test doubles
// (FakeWorld, VirtualScheduler) instead of live Razorpay — the production
// wiring itself is exercised for real in test/world-razorpay-live.test.ts
// and manually via the live demo recipe (PROGRESS.md block 4).
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./helpers/test-db.js";
import { FakeWorld } from "./helpers/fake-world.js";
import * as schema from "../src/db/schema.js";
import { buildServer } from "../src/server.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { RulesPolicyEngine } from "../src/policy/engine.js";
import { DEFAULT_POLICY_CONFIG } from "../src/policy/rules.js";
import { VirtualScheduler } from "../src/scheduler/virtual.js";
import { makeEpisodeLogger } from "../src/persistence/episode-logger.js";
import { runDecisionPipeline, registerExecutionDispatcher } from "../src/orchestration/decision-pipeline.js";

const WEBHOOK_SECRET = "wiring_test_secret";
function sign(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

describe("full production-shaped wiring: webhook -> decide -> scheduled execute", () => {
  it("a real payment.failed webhook ends in a scheduled, then executed, payment link — nothing executes before sendAt", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const db = makeTestDb();
    const now = new Date("2026-09-05T10:00:00Z"); // 15:30 IST, day-of-month 5 -> RulesStrategy FUNDS +24h

    const scheduler = new VirtualScheduler(now);
    const strategy = new RulesStrategy();
    const policy = new RulesPolicyEngine(db, DEFAULT_POLICY_CONFIG);
    const log = makeEpisodeLogger(db, strategy.name, null);

    const world = new FakeWorld(db);
    registerExecutionDispatcher(db, scheduler, world, log);

    // server.ts sends 200 and continues processing after (spec §3: "return
    // 200 fast, process async" — correct production behavior). Fastify's
    // .inject() resolves once the response is sent, NOT once that
    // background work finishes, so the test needs its own way to know when
    // the hook has actually completed rather than assuming it has by the
    // time .inject() returns.
    let hookDone: Promise<void> = Promise.resolve();
    const app = buildServer(db, (db, orderId) => {
      hookDone = runDecisionPipeline(db, orderId, strategy, policy, scheduler, log);
      return hookDone;
    });

    const payload = {
      event: "payment.failed",
      created_at: Math.floor(now.getTime() / 1000),
      payload: {
        payment: {
          entity: {
            id: "pay_wiring1",
            order_id: "order_wiring1",
            amount: 49900,
            currency: "INR",
            error_code: "BAD_REQUEST_ERROR",
            error_description: "insufficient funds",
            error_source: "customer",
            error_step: "payment_authorization",
            error_reason: "insufficient_funds", // -> FUNDS
            customer_id: "cust_wiring1",
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
        "x-razorpay-event-id": "evt_wiring1",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    await hookDone; // wait for the "async" part of "200 fast, process async" to actually finish

    // Decision happened: an episode row exists, verdict APPROVE, not yet executed.
    const orderRow = db.select().from(schema.orders).where(eq(schema.orders.razorpayOrderId, "order_wiring1")).get();
    expect(orderRow).toBeDefined();
    const episodesBefore = db.select().from(schema.episodes).where(eq(schema.episodes.orderId, orderRow!.id)).all();
    expect(episodesBefore).toHaveLength(1);
    expect(episodesBefore[0]!.verdictKind).toBe("APPROVE");
    expect(episodesBefore[0]!.execResult).toBeNull();
    expect(world.calls).toHaveLength(0); // NOT executed yet — sendAt is +24h out

    // Advance the scheduler to just short of sendAt: still nothing.
    await scheduler.advance(new Date(now.getTime() + 23 * 3_600_000));
    expect(world.calls).toHaveLength(0);

    // Advance past +24h: now it executes.
    await scheduler.advance(new Date(now.getTime() + 25 * 3_600_000));
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]!.method).toBe("createPaymentLink");

    const episodesAfter = db.select().from(schema.episodes).where(eq(schema.episodes.orderId, orderRow!.id)).all();
    expect(episodesAfter).toHaveLength(1); // same row, updated
    expect(episodesAfter[0]!.execResult).not.toBeNull();

    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });
});
