import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import { buildServer } from "../src/server.js";
import { runFullEval } from "../src/eval/orchestrator.js";
import { CONFIG_A } from "../src/eval/generator-config.js";

describe("read-only API routes (spec §6 block 9)", () => {
  it("GET /api/orders returns [] with no production episodes", async () => {
    const db = makeTestDb();
    const app = buildServer(db);
    const res = await app.inject({ method: "GET", url: "/api/orders" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("GET /api/orders and /api/orders/:id round-trip a real decision chain", async () => {
    const db = makeTestDb();
    db.insert(schema.customers).values({ id: "cust_1", razorpayCustomerId: "rzp_1", createdAt: "2026-09-02T10:00:00Z" }).run();
    db.insert(schema.orders)
      .values({ id: "order_1", razorpayOrderId: "rzp_order_1", razorpaySubscriptionId: null, customerId: "cust_1", amount: 49900, currency: "INR", status: "attempted", createdAt: "2026-09-02T10:00:00Z" })
      .run();
    db.insert(schema.episodes)
      .values({
        id: "ep_1", orderId: "order_1", attemptNumber: 1, strategyName: "salvage-agent",
        contextHash: "hash", reasoning: "bet on transient, link at +2h",
        proposal: { type: "PAYMENT_LINK" }, verdictKind: "APPROVE", verdictRuleId: "P0", verdictReason: "no rule objected",
        execResult: null, outcome: "failed_again", runId: null, createdAt: "2026-09-02T10:00:00Z",
      })
      .run();

    const app = buildServer(db);

    const listRes = await app.inject({ method: "GET", url: "/api/orders" });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].orderId).toBe("order_1");

    const detailRes = await app.inject({ method: "GET", url: "/api/orders/order_1" });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json();
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0].reasoning).toContain("bet on transient");
  });

  it("GET /api/orders/:id returns 404 for an unknown order", async () => {
    const db = makeTestDb();
    const app = buildServer(db);
    const res = await app.inject({ method: "GET", url: "/api/orders/does_not_exist" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/eval/latest returns an empty report before any eval has run", async () => {
    const db = makeTestDb();
    const app = buildServer(db);
    const res = await app.inject({ method: "GET", url: "/api/eval/latest" });
    expect(res.statusCode).toBe(200);
    expect(res.json().runId).toBeNull();
  });

  it("GET /api/eval/latest reflects a real eval run", async () => {
    const db = makeTestDb();
    await runFullEval({ db, config: CONFIG_A, scenarioCount: 10, seeds: [1], llmClient: null });
    const app = buildServer(db);
    const res = await app.inject({ method: "GET", url: "/api/eval/latest" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runId).not.toBeNull();
    expect(body.rows.length).toBeGreaterThan(0);
  });
});
