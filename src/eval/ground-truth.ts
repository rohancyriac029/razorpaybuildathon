// Spec §5.1: the unobservable counterfactual, generated because nobody has
// this label in real life. This function IS the generator's answer to
// "would this payment have succeeded on retry, at what time, on what
// instrument" — and per spec §5.6, the oracle strategy is just argmax over
// this function, which is why the oracle is the ceiling of this simulator,
// not of production. See src/eval/sources.ts for what's cited vs. estimated.
import { istDayOfMonth, istHourOfDay } from "../util/ist.js";
import { mulberry32 } from "./rng.js";
import type { GeneratorConfig } from "./generator-config.js";
import type { Scenario } from "./scenario.js";
import type { Proposal } from "../types.js";

// How well-suited each lever is to each failure category, independent of
// timing. Encodes the taxonomy's own definitions (spec §7): INSTRUMENT
// needs a fresh instrument (link), a silent retry on AUTH_ABANDONED just
// reproduces the same unapproved collect, etc.
const LEVER_FACTOR: Record<Scenario["category"], Partial<Record<Proposal["type"], number>>> = {
  TRANSIENT: { PAYMENT_LINK: 1.0, NUDGE: 0.7, TOKEN_RETRY: 1.0 },
  FUNDS: { PAYMENT_LINK: 1.0, NUDGE: 0.6, TOKEN_RETRY: 1.0 },
  AUTH_ABANDONED: { NUDGE: 1.0, PAYMENT_LINK: 0.5, TOKEN_RETRY: 0.2 },
  INSTRUMENT: { PAYMENT_LINK: 1.0, NUDGE: 0.4, TOKEN_RETRY: 0.0 },
  TERMINAL: {},
};

function leverFactor(scenario: Scenario, proposalType: Proposal["type"]): number {
  return LEVER_FACTOR[scenario.category]?.[proposalType] ?? 0;
}

function hourProximityFactor(targetHour: number, actualHour: number): number {
  const diff = Math.min(Math.abs(targetHour - actualHour), 24 - Math.abs(targetHour - actualHour));
  if (diff <= 2) return 1.0;
  if (diff <= 5) return 0.7;
  return 0.5;
}

function fundsDayFactor(config: GeneratorConfig, dayOfMonth: number): number {
  const [lo, hi] = config.liquidityDaysOfMonth;
  if (dayOfMonth >= lo && dayOfMonth <= hi) return 1.0;
  const distance = Math.min(Math.abs(dayOfMonth - lo), Math.abs(dayOfMonth - hi));
  if (distance <= 3) return 0.6;
  return 0.35;
}

function timingFactor(scenario: Scenario, proposal: Proposal, at: Date, config: GeneratorConfig): number {
  const hour = istHourOfDay(at);

  switch (scenario.category) {
    case "FUNDS":
      return fundsDayFactor(config, istDayOfMonth(at)) * hourProximityFactor(scenario.liquidityHourIst, hour);
    case "AUTH_ABANDONED":
      return hourProximityFactor(scenario.liquidityHourIst, hour);
    case "TRANSIENT": {
      if (scenario.downtimeClearAtOffsetMs === null) return 1.0; // idiosyncratic, not downtime-related
      const clearedAt = scenario.occurredAt.getTime() + scenario.downtimeClearAtOffsetMs;
      return at.getTime() >= clearedAt ? 1.0 : 0.3;
    }
    case "INSTRUMENT":
      return 1.0; // no meaningful time-dependency — needs customer action, not a clock
    case "TERMINAL":
      return 0.0;
  }
}

/**
 * The counterfactual. Deterministic given (scenario, proposal, at) — same
 * inputs always produce the same verdict, because the irreducible-random
 * component is seeded from the scenario, not from wall-clock entropy. This
 * matters for the oracle: it must be able to evaluate the SAME function the
 * real outcome will use, or "argmax over ground truth" isn't actually the
 * ceiling.
 */
export function wouldSucceed(scenario: Scenario, proposal: Proposal, at: Date, config: GeneratorConfig): boolean {
  if (scenario.category === "TERMINAL") return false;
  if (proposal.type === "MARK_TERMINAL" || proposal.type === "ESCALATE") return false; // not a recovery action

  if (proposal.type === "TOKEN_RETRY" && !scenario.hasConfirmedMandateToken) return false;

  const lever = leverFactor(scenario, proposal.type);
  if (lever === 0) return false;

  const timing = timingFactor(scenario, proposal, at, config);
  const prob = scenario.baseRecoveryProb * lever * timing;

  const rand = mulberry32(scenario.outcomeSeed ^ Math.floor(at.getTime() / 60_000));
  return rand() < prob;
}
