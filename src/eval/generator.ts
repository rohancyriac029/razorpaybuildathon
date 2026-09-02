// Spec §6 block 7 / §5.2: generates the 120-scenario replay set from a
// GeneratorConfig. Pulls real error_reason values from the taxonomy
// (block 1) rather than inventing fake ones, so a generated FUNDS scenario
// carries a reason classify() would genuinely bucket as FUNDS — the
// generator and the taxonomy mapper are never allowed to disagree with
// each other about what a category means.
import { taxonomyTable } from "../taxonomy/classify.js";
import { mulberry32, weightedPick, hashStringToSeed } from "./rng.js";
import type { GeneratorConfig } from "./generator-config.js";
import type { Scenario } from "./scenario.js";
import type { FailureCategory } from "../types.js";

const CATEGORIES: FailureCategory[] = ["TRANSIENT", "FUNDS", "AUTH_ABANDONED", "INSTRUMENT", "TERMINAL"];

const REASONS_BY_CATEGORY: Record<FailureCategory, string[]> = (() => {
  const table = taxonomyTable();
  const out = { TRANSIENT: [], FUNDS: [], AUTH_ABANDONED: [], INSTRUMENT: [], TERMINAL: [] } as Record<FailureCategory, string[]>;
  for (const row of table) out[row.category].push(row.reason);
  return out;
})();

// Subscription amounts, roughly ₹99-₹1999 — plausible Indian SaaS/media
// subscription range. Not cited; a modeling convenience, stated as such.
const AMOUNT_OPTIONS_PAISE = [9900, 19900, 29900, 49900, 99900, 149900, 199900];

/** First-time-vs-repeat customer split — data realism, not a config-shift axis (see generator-config.ts's doc on what IS a shift axis). */
const REPEAT_CUSTOMER_RATE = 0.7;

function generateHistory(
  rand: () => number,
  liquidityDaysOfMonth: [number, number],
  liquidityHourIst: number,
  amountPaise: number,
  count: number,
  anchorTime: Date,
): Scenario["history"] {
  const history: Scenario["history"] = [];
  const [lo, hi] = liquidityDaysOfMonth;
  for (let i = 0; i < count; i++) {
    const monthsAgo = i + 1;
    const day = lo + Math.floor(rand() * (hi - lo + 1));
    const hourJitter = Math.round((rand() - 0.5) * 3); // +/- ~1.5h jitter around the true window
    const hour = ((liquidityHourIst + hourJitter) % 24 + 24) % 24;
    const d = new Date(anchorTime);
    d.setUTCMonth(d.getUTCMonth() - monthsAgo, day);
    d.setUTCHours(hour, Math.floor(rand() * 60), 0, 0);
    history.push({ paidAt: d.toISOString(), amount: amountPaise, hourOfDayIst: hour });
  }
  return history.sort((a, b) => (a.paidAt < b.paidAt ? 1 : -1)); // most recent first
}

/**
 * `anchorTime` is the simulated "now" scenarios are generated relative to
 * (occurredAt is scattered in the ~3 days before it). Defaults to the real
 * clock for ad hoc/manual use, but every caller that cares about
 * determinism — tests, the eval runner — passes an explicit value, since
 * `new Date()` would otherwise make two calls with the same seed produce
 * different scenarios.
 */
export function generateScenarios(
  config: GeneratorConfig,
  count: number,
  seed: number,
  anchorTime: Date = new Date(),
): Scenario[] {
  const rand = mulberry32(seed);
  const scenarios: Scenario[] = [];

  for (let i = 0; i < count; i++) {
    const category = weightedPick(
      CATEGORIES,
      CATEGORIES.map((c) => config.categoryMix[c]),
      rand,
    );
    const reasons = REASONS_BY_CATEGORY[category];
    const errorReason = reasons[Math.floor(rand() * reasons.length)]!;
    const amountPaise = AMOUNT_OPTIONS_PAISE[Math.floor(rand() * AMOUNT_OPTIONS_PAISE.length)]!;
    const isFirstTime = rand() >= REPEAT_CUSTOMER_RATE;
    const liquidityHourIst = 8 + Math.floor(rand() * 14); // 08:00-21:59 IST — waking hours only
    const customerId = `sim_cust_${config.name}_${seed}_${i}`; // deterministic, not crypto.randomUUID()

    const downtimeClearAtOffsetMs =
      category === "TRANSIENT" && rand() < (config.downtimePattern === "bursty" ? 0.5 : 0.3)
        ? Math.round((30 + rand() * 150) * 60_000) // 30-180 min, matches Baremetrics' "24-48h" ceiling loosely and the taxonomy's own "30-90 min typical" language for degraded rails
        : null;

    const occurredAt = new Date(anchorTime.getTime() - Math.floor(rand() * 3) * 86_400_000); // scattered over the ~3 days before anchorTime

    const id = `scenario_${config.name}_${i}`;

    scenarios.push({
      id,
      category,
      errorReason,
      amountPaise,
      customerId,
      isFirstTime,
      occurredAt,
      liquidityHourIst,
      baseRecoveryProb: config.baseRecoveryProb[category],
      downtimeClearAtOffsetMs,
      hasConfirmedMandateToken: false, // see scenario.ts's doc — not modeled in this build
      outcomeSeed: hashStringToSeed(`${id}_${seed}`),
      history: isFirstTime ? [] : generateHistory(rand, config.liquidityDaysOfMonth, liquidityHourIst, amountPaise, 1 + Math.floor(rand() * 4), anchorTime),
    });
  }

  return scenarios;
}
