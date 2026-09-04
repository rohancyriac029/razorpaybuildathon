// Markdown rendering for `pnpm eval`'s output, matching spec §9's README
// benchmark table template plus the §5.5/§5.5.1 splits. Pure functions,
// no I/O — testable without running an actual eval.
import type { AggregatedMetrics } from "./metrics.js";
import type { PairedBootstrapResult } from "./paired-bootstrap.js";

export interface StrategyReportRow {
  metrics: AggregatedMetrics; // pooled across all seeds
  recoveryRateBySeed: number[]; // one entry per seed, for mean ± spread
  oracleHeadroomPct: number | null;
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function fmtRupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  return `${sign}₹${(Math.abs(paise) / 100).toFixed(2)}`;
}
function fmtSpread(rates: number[]): string {
  if (rates.length <= 1) return fmtPct(rates[0] ?? 0);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const spread = (Math.max(...rates) - Math.min(...rates)) / 2;
  return `${fmtPct(mean)} ± ${(spread * 100).toFixed(1)}pp`;
}

export function renderBenchmarkTable(rows: StrategyReportRow[]): string {
  const header =
    "| Strategy | Recovery rate | Net ₹ recovered | Wasted attempts | TERMINAL proposed | TERMINAL executed | Offers proposed | Offers sent | Contacts/recovery | % oracle headroom |\n" +
    "|---|---|---|---|---|---|---|---|---|---|";
  const lines = rows.map((r) => {
    const m = r.metrics;
    const contactsPerRecovery = m.contactsPerRecovery !== null ? m.contactsPerRecovery.toFixed(2) : "—";
    const headroom = r.oracleHeadroomPct !== null ? `${r.oracleHeadroomPct.toFixed(1)}%` : "—";
    return `| ${m.strategyName} | ${fmtSpread(r.recoveryRateBySeed)} | ${fmtRupees(m.netRecoveredPaise)} | ${m.wastedAttemptsTotal} | ${m.terminalProposed}/${m.terminalScenarios} | ${m.terminalExecuted}/${m.terminalScenarios} | ${m.offersProposed}/${m.episodes} | ${m.offersSent}/${m.episodes} | ${contactsPerRecovery} | ${headroom} |`;
  });
  return [header, ...lines].join("\n");
}

/** Spec §5.5: the TERMINAL split, on its own for emphasis — "worth ten times a zero." */
/**
 * Spec §3.1.1's fallback is correct production behaviour and a measurement
 * hazard in the eval: when the LLM is unreachable, AgentStrategy quietly
 * returns RulesStrategy's proposal, so `salvage-agent`'s row becomes the
 * rules baseline wearing a different name — identical on every metric, with
 * no error anywhere. That is not hypothetical: a config A run in block 11
 * came back byte-identical to rules-engine because Ollama had stopped, and
 * nothing in the output said so.
 *
 * Returns "" when no agent episodes ran or none fell back, so a healthy run
 * prints nothing extra.
 */
export function renderFallbackWarning(rows: StrategyReportRow[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    const { agentAttempts, llmFallbacks, strategyName } = r.metrics;
    if (agentAttempts === 0 || llmFallbacks === 0) continue;
    const pct = (llmFallbacks / agentAttempts) * 100;
    const total = pct >= 99.5;
    lines.push(
      `${total ? "**INVALID —" : "**WARNING —"} ${strategyName}: ${llmFallbacks}/${agentAttempts} attempts (${pct.toFixed(1)}%) fell back to the rules engine because the LLM call failed.**` +
        (total
          ? " Every agent decision in this run was actually made by RulesStrategy, so this row is the rules baseline under another name and must not be reported as an agent result. Check the model is reachable (`curl localhost:11434/api/tags` for Ollama) and re-run."
          : " Those attempts are rules-engine decisions, not agent decisions — treat this row as a blend."),
    );
  }
  return lines.join("\n\n");
}

export function renderTerminalSplit(rows: StrategyReportRow[]): string {
  const header = "| Strategy | Proposed (LLM layer) | Executed (post-policy) |\n|---|---|---|";
  const lines = rows.map((r) => {
    const m = r.metrics;
    return `| ${m.strategyName} | ${m.terminalProposed}/${m.terminalScenarios} | ${m.terminalExecuted}/${m.terminalScenarios} |`;
  });
  return [header, ...lines].join("\n");
}

/** Spec §5.5.1: the discount/offer split — P14's evidence row. */
export function renderOfferSplit(rows: StrategyReportRow[]): string {
  const header = "| Strategy | Proposed (LLM layer) | Expressible (post-schema) |\n|---|---|---|";
  const lines = rows.map((r) => {
    const m = r.metrics;
    return `| ${m.strategyName} | ${m.offersProposed}/${m.episodes} | ${m.offersSent}/${m.episodes} — no amount parameter exists |`;
  });
  return [header, ...lines].join("\n");
}

export function renderPairedComparison(agentName: string, rulesName: string, result: PairedBootstrapResult): string {
  if (result.n === 0) return `No paired data for ${agentName} vs ${rulesName}.`;
  const sign = result.meanDiffPaise >= 0 ? "+" : "";
  return (
    `**${agentName} vs ${rulesName}**, paired bootstrap over ${result.n} matched (scenario, seed) pairs: ` +
    `mean difference ${sign}${fmtRupees(result.meanDiffPaise)} per episode, ` +
    `95% CI [${fmtRupees(result.ci95LowPaise)}, ${fmtRupees(result.ci95HighPaise)}]. ` +
    (result.significant
      ? `The interval excludes zero — ${result.meanDiffPaise > 0 ? agentName : rulesName} wins at this confidence level.`
      : `The interval crosses zero — the difference is not distinguishable from noise at this sample size.`)
  );
}

export function renderCostSummary(rows: StrategyReportRow[]): string {
  const header = "| Strategy | LLM cost (total) | Cost per ₹100 recovered |\n|---|---|---|";
  const lines = rows.map((r) => {
    const m = r.metrics;
    const perHundred = m.costPaisePer100RupeesRecovered !== null ? fmtRupees(m.costPaisePer100RupeesRecovered) : "—";
    return `| ${m.strategyName} | ${fmtRupees(m.llmCostPaiseTotal)} | ${perHundred} |`;
  });
  return [header, ...lines].join("\n");
}
