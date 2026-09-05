// TEMPORARY PROBE — delete after use.
// How many strategy proposals land inside the P4 blackout window purely
// because of how the generator anchors occurredAt?
import { generateScenarios } from "../src/eval/generator.js";
import { CONFIG_A, CONFIG_B, EVAL_ANCHOR_TIME, SCENARIO_GENERATION_SEED } from "../src/eval/generator-config.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { FixedIntervalStrategy } from "../src/strategies/fixed-interval.js";
import { isIstBlackoutHour, istHourOfDay } from "../src/util/ist.js";
import type { EpisodeContext } from "../src/types.js";
import type { Scenario } from "../src/eval/scenario.js";

function ctxFor(s: Scenario, now: Date): EpisodeContext {
  return {
    failureContext: {
      order: {
        id: s.id, razorpayOrderId: "x", razorpaySubscriptionId: null,
        customerId: s.customerId, amount: s.amountPaise, currency: "INR",
        status: "attempted", createdAt: s.occurredAt.toISOString(),
      },
      failure: {
        id: "f", orderId: s.id, eventId: "e", razorpayPaymentId: null,
        errorCode: null, errorSource: null, errorStep: null,
        errorReason: s.errorReason, category: s.category,
        attemptNumber: 1, occurredAt: s.occurredAt.toISOString(),
      },
      attemptNumber: 1,
      priorAttempts: [],
      economics: { attemptsRemaining: 3, contactsRemaining: 2, attemptCostPaise: 200, amountAtStakePaise: s.amountPaise },
    },
    history: { customerId: s.customerId, isFirstTime: s.isFirstTime, lastPayments: [], workingInstrument: null },
    now,
  } as unknown as EpisodeContext;
}

async function probe(config: typeof CONFIG_A, label: string) {
  const scenarios = generateScenarios(config, 120, SCENARIO_GENERATION_SEED, EVAL_ANCHOR_TIME);
  const rules = new RulesStrategy();
  const fixed = new FixedIntervalStrategy();

  const occurredHours = [...new Set(scenarios.map((s) => istHourOfDay(s.occurredAt)))];
  console.log(`\n=== ${label} ===`);
  console.log(`distinct IST hours-of-day across all 120 occurredAt values: [${occurredHours.join(", ")}]`);

  const byCat: Record<string, { total: number; rulesBlackout: number; fixedBlackout: number }> = {};

  for (const s of scenarios) {
    const now = s.occurredAt; // attempt 1
    const c = (byCat[s.category] ??= { total: 0, rulesBlackout: 0, fixedBlackout: 0 });
    c.total++;

    const rp = await rules.propose(ctxFor(s, now));
    if ("sendAt" in rp && isIstBlackoutHour(new Date(rp.sendAt))) c.rulesBlackout++;

    const fp = await fixed.propose(ctxFor(s, now));
    if (isIstBlackoutHour(new Date(fp.sendAt))) c.fixedBlackout++;
  }

  console.log("category         total   rules->P4   fixed24h->P4");
  let rt = 0, ft = 0, tot = 0;
  for (const [cat, c] of Object.entries(byCat)) {
    console.log(`${cat.padEnd(16)}${String(c.total).padStart(5)}${String(c.rulesBlackout).padStart(12)}${String(c.fixedBlackout).padStart(15)}`);
    rt += c.rulesBlackout; ft += c.fixedBlackout; tot += c.total;
  }
  console.log(`${"TOTAL".padEnd(16)}${String(tot).padStart(5)}${String(rt).padStart(12)}${String(ft).padStart(15)}`);
}

await probe(CONFIG_A, "CONFIG A");
await probe(CONFIG_B, "CONFIG B");
