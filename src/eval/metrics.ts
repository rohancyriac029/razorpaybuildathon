// Spec §5.4: the metrics table. §5.5/§5.5.1: the TERMINAL and discount
// splits are reported PER SCENARIO ("4/50"), not per attempt — a strategy
// that never learns (e.g. fixed-24h) can propose a TERMINAL retry on all 3
// attempts of the same scenario; what spec's own framing counts is whether
// that scenario saw at least one such proposal, not how many times.
import type { EpisodeRunResult } from "./run-episode.js";

export interface AggregatedMetrics {
  strategyName: string;
  episodes: number;
  recoveryRate: number;
  netRecoveredPaise: number;
  wastedAttemptsTotal: number;
  terminalScenarios: number;
  terminalProposed: number; // scenarios where >=1 attempt proposed a retry/contact on a TERMINAL failure
  terminalExecuted: number; // scenarios where one actually got through to execution — should always be 0
  offersProposed: number; // episodes where the agent reached for price authority at least once
  offersSent: number; // structurally always 0 (P14)
  contactsPerRecovery: number | null;
  medianTimeToRecoveryMs: number | null;
  llmCostPaiseTotal: number;
  costPaisePer100RupeesRecovered: number | null;
  oracleHeadroomPct: number | null; // filled in by compareToOracle, not here
  /**
   * Attempts where the LLM failed and AgentStrategy silently substituted
   * RulesStrategy's proposal, over total agent attempts. A high ratio means
   * this row is not really measuring the agent — at 1.0 it is the rules
   * baseline under a different name. Reported, not hidden: see
   * renderFallbackWarning. Both 0 for deterministic strategies.
   */
  llmFallbacks: number;
  agentAttempts: number;
}

/**
 * `results` must all share the same (config, strategy) — one row per
 * (scenario, seed). `scenarioCategoryById` is needed because the TERMINAL
 * split counts scenarios, and EpisodeRunResult doesn't carry the category
 * (it's a property of the scenario, looked up by id).
 */
export function aggregate(
  results: EpisodeRunResult[],
  scenarioCategoryById: Map<string, string>,
): AggregatedMetrics {
  const strategyName = results[0]?.strategyName ?? "unknown";
  const episodes = results.length;
  const recovered = results.filter((r) => r.recovered);

  const netRecoveredPaise = results.reduce((sum, r) => sum + r.netRecoveredPaise, 0);
  const wastedAttemptsTotal = results.reduce((sum, r) => sum + r.wastedAttempts, 0);
  const llmCostPaiseTotal = results.reduce((sum, r) => sum + r.llmCostPaise, 0);

  // Per-scenario TERMINAL rollup (spec §5.5's "4/50" is per scenario, see module doc).
  const byScenario = new Map<string, EpisodeRunResult[]>();
  for (const r of results) {
    const arr = byScenario.get(r.scenarioId) ?? [];
    arr.push(r);
    byScenario.set(r.scenarioId, arr);
  }
  let terminalScenarios = 0;
  let terminalProposed = 0;
  let terminalExecuted = 0;
  let offersProposedScenarios = 0;
  for (const [scenarioId, rows] of byScenario) {
    if (scenarioCategoryById.get(scenarioId) === "TERMINAL") {
      terminalScenarios++;
      if (rows.some((r) => r.terminalRetryProposed > 0)) terminalProposed++;
      if (rows.some((r) => r.terminalRetryExecuted > 0)) terminalExecuted++;
    }
    if (rows.some((r) => r.offersProposed > 0)) offersProposedScenarios++;
  }
  const offersSent = results.reduce((sum, r) => sum + r.offersSent, 0); // structurally 0

  const contactsTotal = results.reduce((sum, r) => sum + r.contactsUsed, 0);
  const contactsPerRecovery = recovered.length > 0 ? contactsTotal / recovered.length : null;

  const recoveryTimes = recovered.map((r) => r.timeToRecoveryMs!).filter((t) => t !== null).sort((a, b) => a - b);
  const medianTimeToRecoveryMs =
    recoveryTimes.length > 0 ? recoveryTimes[Math.floor(recoveryTimes.length / 2)]! : null;

  const grossRecoveredRupees = recovered.reduce((sum, r) => sum + r.netRecoveredPaise, 0) / 100; // approximation: net, not gross — see README note this ships with
  const costPaisePer100RupeesRecovered =
    grossRecoveredRupees > 0 ? Math.round((llmCostPaiseTotal / grossRecoveredRupees) * 100) : null;

  return {
    strategyName,
    episodes,
    recoveryRate: episodes > 0 ? recovered.length / episodes : 0,
    netRecoveredPaise,
    wastedAttemptsTotal,
    terminalScenarios,
    terminalProposed,
    terminalExecuted,
    offersProposed: offersProposedScenarios,
    offersSent,
    contactsPerRecovery,
    medianTimeToRecoveryMs,
    llmCostPaiseTotal,
    costPaisePer100RupeesRecovered,
    oracleHeadroomPct: null,
    llmFallbacks: results.reduce((sum, r) => sum + r.llmFallbacks, 0),
    agentAttempts: results.reduce((sum, r) => sum + r.agentAttempts, 0),
  };
}

/** % of oracle headroom captured = this strategy's net recovered / oracle's net recovered, over the SAME scenario set (spec §5.6: only meaningful as a within-simulator comparison). */
export function oracleHeadroomPct(strategyNetPaise: number, oracleNetPaise: number): number | null {
  if (oracleNetPaise <= 0) return null;
  return Math.round((strategyNetPaise / oracleNetPaise) * 1000) / 10; // one decimal place
}
