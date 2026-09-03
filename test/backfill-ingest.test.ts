// Spec §4.2: "Run it with the wrong dates, or run it twice, and you ingest
// thousands of stale failures... Only a system-wide cap catches it. This is
// your kill-switch demo scenario." These tests prove P10 and P11 actually
// catch it — not asserted, run.
import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import { ingestBackfill, type BackfillPaymentRecord } from "../src/backfill/ingest.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { RulesPolicyEngine } from "../src/policy/engine.js";
import { DEFAULT_POLICY_CONFIG } from "../src/policy/rules.js";
import { makeEpisodeLogger } from "../src/persistence/episode-logger.js";
import { FakeWorld } from "./helpers/fake-world.js";

const NOW = new Date("2026-09-02T10:00:00Z"); // 15:30 IST, safe daytime

function record(i: number, overrides: Partial<BackfillPaymentRecord> = {}): BackfillPaymentRecord {
  return {
    id: `pay_bf_${i}`,
    orderId: `order_bf_${i}`,
    amountPaise: 49900,
    currency: "INR",
    errorReason: "gateway_technical_error", // -> TRANSIENT, always approvable if nothing else blocks it
    customerId: `cust_bf_${i}`,
    createdAtUnix: Math.floor(NOW.getTime() / 1000),
    ...overrides,
  };
}

function setup(db: ReturnType<typeof makeTestDb>, config = DEFAULT_POLICY_CONFIG) {
  const strategy = new RulesStrategy();
  const policy = new RulesPolicyEngine(db, config);
  const world = new FakeWorld(db); // reports ok:true executions — see fake-world.ts
  const log = makeEpisodeLogger(db, strategy.name, null);
  return { strategy, policy, world, log };
}

describe("ingestBackfill: P11 staleness catches wrong dates", () => {
  it("rejects failures older than the staleness cutoff, all via P11", async () => {
    const db = makeTestDb();
    const { strategy, policy, world, log } = setup(db);

    const eightMonthsAgoUnix = Math.floor((NOW.getTime() - 240 * 86_400_000) / 1000);
    const records = Array.from({ length: 20 }, (_, i) => record(i, { createdAtUnix: eightMonthsAgoUnix }));

    const stats = await ingestBackfill(db, records, strategy, policy, world, log, NOW);

    expect(stats.ingested).toBe(20);
    expect(stats.rejected).toBe(20);
    expect(stats.rejectedByRuleId.P11).toBe(20);
    expect(stats.approved).toBe(0);
  });

  it("recent failures are NOT caught by P11 (the gap is real, not a blanket reject)", async () => {
    const db = makeTestDb();
    const { strategy, policy, world, log } = setup(db);
    const records = Array.from({ length: 5 }, (_, i) => record(i));

    const stats = await ingestBackfill(db, records, strategy, policy, world, log, NOW);
    expect(stats.rejectedByRuleId.P11 ?? 0).toBe(0);
  });
});

describe("ingestBackfill: P10 global cap catches a volume runaway", () => {
  it("approves up to the global hourly cap, then rejects the rest via P10 — even though every order is on attempt 1 (P1 does nothing here)", async () => {
    const db = makeTestDb();
    const config = { ...DEFAULT_POLICY_CONFIG, globalExecPerHour: 5 }; // small cap for a fast, precise test
    const { strategy, policy, world, log } = setup(db, config);

    const records = Array.from({ length: 12 }, (_, i) => record(i)); // all fresh, all distinct orders — P1/P2 never engage
    const stats = await ingestBackfill(db, records, strategy, policy, world, log, NOW);

    expect(stats.ingested).toBe(12);
    expect(stats.approved).toBe(5); // exactly the cap
    expect(stats.executed).toBe(5); // every approved TRANSIENT proposal here is execution-bound
    expect(stats.rejected).toBe(7);
    expect(stats.rejectedByRuleId.P10).toBe(7);
  });

  it("this is the exact spec §4.2 scenario: 'every one of those orders is on attempt 1' — P1 alone would approve all of them", async () => {
    const db = makeTestDb();
    // Effectively unlimited per-order/global caps EXCEPT the one under test,
    // to isolate the claim: P1 (max attempts per order) cannot stop this,
    // because every backfilled order is a DIFFERENT order on its first
    // attempt. Only P10 (system-wide) can.
    const config = { ...DEFAULT_POLICY_CONFIG, globalExecPerHour: 1_000_000 };
    const { strategy, policy, world, log } = setup(db, config);
    const records = Array.from({ length: 50 }, (_, i) => record(i));

    const stats = await ingestBackfill(db, records, strategy, policy, world, log, NOW);
    // With the cap effectively disabled, all 50 distinct-order, attempt-1
    // failures sail through — proving P1 truly has nothing to say about
    // this shape of runaway, which is exactly why P10 has to exist.
    expect(stats.approved).toBe(50);
    expect(stats.rejected).toBe(0);
  });
});

describe("ingestBackfill: running it twice", () => {
  it("the second run dedupes at the webhook layer — zero new ingestion, zero new proposals", async () => {
    const db = makeTestDb();
    const { strategy, policy, world, log } = setup(db);
    const records = Array.from({ length: 10 }, (_, i) => record(i));

    const firstRun = await ingestBackfill(db, records, strategy, policy, world, log, NOW);
    expect(firstRun.ingested).toBe(10);

    const secondRun = await ingestBackfill(db, records, strategy, policy, world, log, NOW);
    expect(secondRun.ingested).toBe(0); // same event ids, deduped
    expect(secondRun.approved).toBe(0);
    expect(secondRun.rejected).toBe(0);
  });
});

describe("ingestBackfill: P13 kill switch stops everything outright", () => {
  it("with KILL_SWITCH active, every execution-bound proposal is rejected via P13, regardless of staleness or volume", async () => {
    const db = makeTestDb();
    const config = { ...DEFAULT_POLICY_CONFIG, killSwitch: true };
    const { strategy, policy, world, log } = setup(db, config);
    const records = Array.from({ length: 8 }, (_, i) => record(i));

    const stats = await ingestBackfill(db, records, strategy, policy, world, log, NOW);
    expect(stats.rejected).toBe(8);
    expect(stats.rejectedByRuleId.P13).toBe(8);
  });
});

describe("ingestBackfill: real orders and failures are actually created (not just counted)", () => {
  it("persists a real order and failure row per ingested record", async () => {
    const db = makeTestDb();
    const { strategy, policy, world, log } = setup(db);
    await ingestBackfill(db, [record(1)], strategy, policy, world, log, NOW);

    const orders = db.select().from(schema.orders).all();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.razorpayOrderId).toBe("order_bf_1");

    const failures = db.select().from(schema.failures).all();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.category).toBe("TRANSIENT");
  });
});
