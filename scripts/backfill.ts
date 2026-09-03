#!/usr/bin/env -S npx tsx
// Spec §4.2, §6 block 10: "Either it exists or the rationale for two of
// your four new rules is fiction." Two modes:
//
//   npx tsx scripts/backfill.ts --simulate 50                 # demo mode
//   npx tsx scripts/backfill.ts --simulate 50 --stale-days 240 # demo P11
//   KILL_SWITCH=true npx tsx scripts/backfill.ts --simulate 50 # demo P13
//   npx tsx scripts/backfill.ts --from 2026-06-01 --to 2026-09-01  # real
//
// --simulate exists because this build's test account (spec §0.1) has no
// real payment history to backfill — a fresh account, by design, has
// nothing for a date-range pull to find. Simulated records are clearly
// labeled as such in the output; the ingestion logic itself
// (src/backfill/ingest.ts) is identical either way, and is what's under
// test, not this CLI shell.
import { existsSync } from "node:fs";
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch {
  // no .env — fine
}

import { db } from "../src/db/client.js";
import { ingestBackfill, type BackfillPaymentRecord } from "../src/backfill/ingest.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { RulesPolicyEngine, policyConfigFromEnv } from "../src/policy/engine.js";
import { makeEpisodeLogger } from "../src/persistence/episode-logger.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema.js";
import type { World } from "../src/ports/world.js";
import type { ExecResult, Intent, Order } from "../src/types.js";

/**
 * --simulate mode's records don't exist in Razorpay — RazorpayWorld would
 * make real API calls against fake order ids and fail. This stub reports
 * ok:true (so P10's execution-rate check has real numbers to count) without
 * touching the network, matching what a real send would do for the purpose
 * of this demo. Kept inline (not test/helpers/fake-world.ts) since it's a
 * script concern, not a test double.
 */
class SimulatedWorld implements World {
  constructor(private readonly localDb: typeof db) {}
  async getOrder(id: string): Promise<Order> {
    const row = this.localDb.select().from(schema.orders).where(eq(schema.orders.id, id)).get();
    if (!row) throw new Error(`SimulatedWorld: no local order ${id}`);
    return row;
  }
  private ok(intent: Intent, refPrefix: string): ExecResult {
    return { intentId: intent.id, ok: true, razorpayRefId: `${refPrefix}_sim_${intent.id.slice(0, 8)}`, detail: "simulated (--simulate mode, not sent for real)", executedAt: new Date().toISOString() };
  }
  async createPaymentLink(intent: Intent): Promise<ExecResult> { return this.ok(intent, "plink"); }
  async sendNudge(intent: Intent): Promise<ExecResult> { return this.ok(intent, "nudge"); }
  async chargeToken(intent: Intent): Promise<ExecResult> { return this.ok(intent, "pay"); }
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const now = new Date();
const strategy = new RulesStrategy(); // a bulk historical ingest has no reason to spend LLM calls — Rules is also the production fallback (§3.1.1)
const policy = new RulesPolicyEngine(db, policyConfigFromEnv());
const log = makeEpisodeLogger(db, strategy.name, null);

let records: BackfillPaymentRecord[];
const simulateN = argValue("--simulate");
const isSimulated = Boolean(simulateN);

// One Razorpay client for both the historical pull and (real mode) execution.
const rzpClientPromise = isSimulated
  ? null
  : (async () => {
      const Razorpay = (await import("razorpay")).default;
      return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID ?? "", key_secret: process.env.RAZORPAY_KEY_SECRET ?? "" });
    })();

if (simulateN) {
  const n = Number(simulateN);
  const staleDays = Number(argValue("--stale-days") ?? 0);
  console.log(`[backfill] SIMULATED mode: ${n} synthetic failures, ${staleDays} days old (clearly not real Razorpay data — see this file's header)`);
  const runTag = randomUUID().slice(0, 8);
  records = Array.from({ length: n }, (_, i) => ({
    id: `pay_sim_${runTag}_${i}`,
    orderId: `order_sim_${runTag}_${i}`,
    amountPaise: 49900,
    currency: "INR",
    // AUTH_ABANDONED, not TRANSIENT: its NUDGE proposal's sendAt is clamped to
    // the 10:00-20:00 IST window (src/strategies/rules.ts), so this demo's
    // P10/P11/P13 story is deterministic regardless of what wall-clock time
    // the script happens to run at. TRANSIENT's fail-closed +6h default would
    // otherwise land in the P4 blackout window depending on time of day,
    // rejecting everything via P4 before P10 ever gets a chance to run —
    // found live when this script ran at 18:47 IST and every record was
    // rejected P4 instead of the intended P10.
    errorReason: "authentication_failed",
    customerId: `cust_sim_${runTag}_${i}`,
    createdAtUnix: Math.floor(now.getTime() / 1000) - staleDays * 86_400,
  }));
} else {
  const rzp = await rzpClientPromise!;
  const fromArg = argValue("--from");
  const toArg = argValue("--to");
  const from = fromArg ? Math.floor(new Date(fromArg).getTime() / 1000) : Math.floor(now.getTime() / 1000) - 90 * 86_400;
  const to = toArg ? Math.floor(new Date(toArg).getTime() / 1000) : Math.floor(now.getTime() / 1000);
  console.log(`[backfill] REAL mode: pulling payments ${new Date(from * 1000).toISOString()} -> ${new Date(to * 1000).toISOString()}`);

  const result = await rzp.payments.all({ from, to, count: 100 });
  const failed = result.items.filter((p) => p.status === "failed");
  console.log(`[backfill] ${result.items.length} payments in range, ${failed.length} failed`);
  records = failed.map((p) => ({
    id: p.id,
    orderId: p.order_id ?? p.id,
    amountPaise: Number(p.amount),
    currency: p.currency,
    errorReason: p.error_reason ?? null,
    customerId: p.customer_id ?? null,
    createdAtUnix: p.created_at,
  }));
}

// --simulate records don't exist in Razorpay (SimulatedWorld, above) — real
// mode executes for real, matching production (src/world/razorpay-world.ts).
// A real backfill's proposals are genuine recovery attempts, not a dry run.
let world: World;
if (isSimulated) {
  world = new SimulatedWorld(db);
} else {
  const { RazorpayWorld } = await import("../src/world/razorpay-world.js");
  world = new RazorpayWorld((await rzpClientPromise!)!, db);
}

if (process.env.KILL_SWITCH === "true") {
  console.log("[backfill] KILL_SWITCH=true — P13 will reject every execution-bound proposal outright.");
}

const stats = await ingestBackfill(db, records, strategy, policy, world, log, now);

console.log(`
[backfill] done.
  total records:     ${stats.totalRecords}
  ingested (new):     ${stats.ingested}  (${stats.totalRecords - stats.ingested} deduped — already processed in a prior run)
  approved:           ${stats.approved}
  executed:           ${stats.executed}
  rejected:           ${stats.rejected}
  rejected by rule:   ${JSON.stringify(stats.rejectedByRuleId)}
`);
