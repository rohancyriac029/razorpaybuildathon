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
