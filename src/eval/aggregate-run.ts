// Turns the orchestrator's raw per-episode results into everything
// report.ts needs: one StrategyReportRow per strategy (with oracle
// headroom filled in) plus the agent-vs-rules paired bootstrap. Separated
// from orchestrator.ts so it's testable against hand-built results without
// re-running a full eval.
import { aggregate, oracleHeadroomPct } from "./metrics.js";
import { pairedBootstrap, type PairedBootstrapResult } from "./paired-bootstrap.js";
import type { StrategyReportRow } from "./report.js";
import type { EpisodeRunResult } from "./run-episode.js";
import type { Scenario } from "./scenario.js";

export interface AggregateRunOutput {
  rows: StrategyReportRow[];
  agentVsRules: PairedBootstrapResult | null; // null if the agent strategy wasn't run (no LLM client)
}

export function aggregateRun(
  resultsByStrategy: Map<string, EpisodeRunResult[]>,
  scenarios: Scenario[],
): AggregateRunOutput {
  const scenarioCategoryById = new Map(scenarios.map((s) => [s.id, s.category]));

  const oracleResults = resultsByStrategy.get("oracle") ?? [];
  const oracleNetTotal = oracleResults.reduce((sum, r) => sum + r.netRecoveredPaise, 0);

  const rows: StrategyReportRow[] = [];
  for (const [strategyName, results] of resultsByStrategy) {
    const metrics = aggregate(results, scenarioCategoryById);

    const seeds = [...new Set(results.map((r) => r.seed))].sort();
    const recoveryRateBySeed = seeds.map((seed) => {
      const seedResults = results.filter((r) => r.seed === seed);
      const recovered = seedResults.filter((r) => r.recovered).length;
      return seedResults.length > 0 ? recovered / seedResults.length : 0;
    });

    const strategyNetTotal = results.reduce((sum, r) => sum + r.netRecoveredPaise, 0);
    const headroom = strategyName === "oracle" ? 100 : oracleHeadroomPct(strategyNetTotal, oracleNetTotal);

    rows.push({ metrics, recoveryRateBySeed, oracleHeadroomPct: headroom });
  }

  // Canonical ordering for the table (spec §5.3's own list order), not
  // insertion order, which depends on which strategies happened to run.
  const order = ["no-retry", "fixed-24h", "rules-engine", "salvage-agent", "oracle"];
  rows.sort((a, b) => order.indexOf(a.metrics.strategyName) - order.indexOf(b.metrics.strategyName));

  const agentResults = resultsByStrategy.get("salvage-agent");
  const rulesResults = resultsByStrategy.get("rules-engine");
  let agentVsRules: PairedBootstrapResult | null = null;
  if (agentResults && rulesResults) {
    const rulesByKey = new Map(rulesResults.map((r) => [`${r.scenarioId}_${r.seed}`, r]));
    const diffs: number[] = [];
    for (const a of agentResults) {
      const r = rulesByKey.get(`${a.scenarioId}_${a.seed}`);
      if (r) diffs.push(a.netRecoveredPaise - r.netRecoveredPaise);
    }
    agentVsRules = pairedBootstrap(diffs);
  }

  return { rows, agentVsRules };
}
