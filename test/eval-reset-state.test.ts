// [Block 11] Regression test for a real bug: re-running the eval against the
// committed (deliberately persistent) database starved every strategy to
// 0.0% recovery, because P10's system-wide execution cap counted the PREVIOUS
// run's executions. See src/eval/reset-state.ts.
//
// The load-bearing assertion here is NOT "the delete statement runs" — it's
// that a second full run against the same database produces the SAME result
// as the first, which is the property that was actually broken.
import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import { resetEvalState } from "../src/eval/reset-state.js";
import { runFullEval } from "../src/eval/orchestrator.js";
import { CONFIG_B } from "../src/eval/generator-config.js";

describe("resetEvalState", () => {
  it("clears policy-relevant state but never the LLM cache", () => {
    const db = makeTestDb();

    db.insert(schema.llmCache)
      .values({ cacheKey: "k1", response: { hello: "world" }, createdAt: "2026-09-01T00:00:00Z" })
      .run();
    db.insert(schema.customers)
      .values({ id: "c1", razorpayCustomerId: "cust_x", createdAt: "2026-09-01T00:00:00Z" })
      .run();
    db.insert(schema.orders)
      .values({
        id: "o1",
        razorpayOrderId: "order_x",
        razorpaySubscriptionId: null,
        customerId: "c1",
        amount: 49900,
        currency: "INR",
        status: "attempted",
        createdAt: "2026-09-01T00:00:00Z",
      })
      .run();

    const stats = resetEvalState(db);

    expect(stats.clearedRows).toBeGreaterThan(0);
    expect(stats.cachedResponsesKept).toBe(1);
    expect(db.select().from(schema.orders).all()).toHaveLength(0);
    expect(db.select().from(schema.customers).all()).toHaveLength(0);
    // The whole point: the expensive-to-regenerate cache survives.
    expect(db.select().from(schema.llmCache).all()).toHaveLength(1);
  });

  it("is safe on a fresh database", () => {
    const db = makeTestDb();
    const stats = resetEvalState(db);
    expect(stats.clearedRows).toBe(0);
    expect(stats.cachedResponsesKept).toBe(0);
  });
});

describe("the starvation bug it exists to prevent", () => {
  it("WITHOUT a reset, a second run against the same DB is starved by P10 into recovering nothing", async () => {
    const db = makeTestDb();
    const opts = { db, config: CONFIG_B, scenarioCount: 15, seeds: [1], llmClient: null };

    const first = await runFullEval(opts);
    const firstOracleRecovered = first.resultsByStrategy.get("oracle")!.filter((r) => r.recovered).length;
    expect(firstOracleRecovered).toBeGreaterThan(0); // sanity: the oracle does recover on a clean DB

    // No reset between runs — this is the bug.
    const second = await runFullEval(opts);
    const secondOracleRecovered = second.resultsByStrategy.get("oracle")!.filter((r) => r.recovered).length;

    expect(secondOracleRecovered).toBe(0); // starved: P10 counted run 1's executions
  });

  it("WITH the reset, the second run reproduces the first exactly", async () => {
    const db = makeTestDb();
    const opts = { db, config: CONFIG_B, scenarioCount: 15, seeds: [1], llmClient: null };

    resetEvalState(db);
    const first = await runFullEval(opts);

    resetEvalState(db);
    const second = await runFullEval(opts);

    // Compare the full recovered-vector per strategy, not just a count — this
    // is the actual reproducibility claim the README makes.
    for (const strategyName of first.resultsByStrategy.keys()) {
      const a = first.resultsByStrategy.get(strategyName)!.map((r) => r.recovered);
      const b = second.resultsByStrategy.get(strategyName)!.map((r) => r.recovered);
      expect(b, `strategy ${strategyName} did not reproduce`).toEqual(a);
    }
  });
});
