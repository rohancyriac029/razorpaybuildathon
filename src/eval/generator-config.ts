// Spec §5.7 [v2.1]: "Config B: three named perturbations, not a second
// hand-authored world." Config B = config A with exactly three one-line
// changes, each with a stated real-world justification — not an arbitrary
// second world.
//
// Spec §5.2 point 2, the firewall: nothing in this file, or any value
// derived from it, may appear in src/agent/system-prompt.ts. Grep for the
// numbers below in that file before every commit that touches either.

import type { FailureCategory } from "../types.js";

export interface GeneratorConfig {
  name: "A" | "B";
  /** Category mix — must sum to 1. Estimate informed by (not lifted from) src/eval/sources.ts; see UNCITED_ASSUMPTIONS there. */
  categoryMix: Record<FailureCategory, number>;
  /** Day-of-month range (inclusive) where FUNDS liquidity is concentrated. */
  liquidityDaysOfMonth: [number, number];
  /** Base recovery probability per category, before timing/lever adjustments — calibrated against RetentionLens's ~20-47% fixed-interval/median recovery band (src/eval/sources.ts), not reverse-engineered from a target headline number. */
  baseRecoveryProb: Record<FailureCategory, number>;
  /** Downtime pattern for TRANSIENT: "uniform" = independent per-scenario outage duration; "bursty" = correlated clusters (spec §5.7 perturbation 3: "issuer incidents cluster; they don't arrive Poisson"). */
  downtimePattern: "uniform" | "bursty";
}

export const CONFIG_A: GeneratorConfig = {
  name: "A",
  categoryMix: {
    INSTRUMENT: 0.3, // largest single cause per Recurly (src/eval/sources.ts)
    FUNDS: 0.25, // major soft-decline category per Recurly/RetentionLens
    TRANSIENT: 0.2, // gateway/bank technical, not heavily quantified in sources found — estimate
    AUTH_ABANDONED: 0.15, // UPI-specific; no US-centric source covers this — domain estimate
    TERMINAL: 0.1, // fraud/risk declines per Recurly's "bank-level fraud flags"
  },
  liquidityDaysOfMonth: [1, 7], // payroll-cycle assumption, stated as such — see sources.ts
  baseRecoveryProb: {
    TRANSIENT: 0.75, // instrument fine, rails failed — highly recoverable per taxonomy definition
    FUNDS: 0.55, // within RetentionLens's ~47.6% industry-median band when timed reasonably
    AUTH_ABANDONED: 0.45, // flow dropout, moderate recovery on a well-timed nudge
    INSTRUMENT: 0.35, // needs genuine customer action (new card), lower than a same-instrument retry
    TERMINAL: 0.0, // never recoverable by definition — this is the floor the taxonomy exists to protect
  },
  downtimePattern: "uniform",
};

// Three named perturbations from config A, each with a stated justification
// (spec §5.7's own table, applied literally):
export const CONFIG_B: GeneratorConfig = {
  ...CONFIG_A,
  name: "B",
  // 1. Liquidity mass moves from days 1-7 -> days 25-31: different payroll convention.
  liquidityDaysOfMonth: [25, 31],
  // 2. Reason mix shifts toward AUTH_ABANDONED: UPI-heavy customer cohort.
  categoryMix: {
    INSTRUMENT: 0.25,
    FUNDS: 0.2,
    TRANSIENT: 0.15,
    AUTH_ABANDONED: 0.3, // +0.15 vs config A, taken proportionally from the other four
    TERMINAL: 0.1,
  },
  // 3. Downtime changes from uniform -> bursty: issuer incidents cluster, they don't arrive Poisson.
  downtimePattern: "bursty",
};
