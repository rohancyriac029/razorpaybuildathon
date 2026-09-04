import { describe, it, expect } from "vitest";
import { renderBenchmarkTable, renderTerminalSplit, renderOfferSplit, renderPairedComparison, renderCostSummary, renderFallbackWarning } from "../src/eval/report.js";
import type { AggregatedMetrics } from "../src/eval/metrics.js";
import type { StrategyReportRow } from "../src/eval/report.js";

function metrics(overrides: Partial<AggregatedMetrics> = {}): AggregatedMetrics {
  return {
    strategyName: "rules-engine",
    episodes: 120,
    recoveryRate: 0.4,
    netRecoveredPaise: 500000,
    wastedAttemptsTotal: 30,
    terminalScenarios: 12,
    terminalProposed: 0,
    terminalExecuted: 0,
    offersProposed: 0,
    offersSent: 0,
    contactsPerRecovery: 1.2,
    medianTimeToRecoveryMs: 3_600_000,
    llmFallbacks: 0,
    agentAttempts: 0,
    llmCostPaiseTotal: 0,
    costPaisePer100RupeesRecovered: 0,
    oracleHeadroomPct: null,
    ...overrides,
  };
}

function row(overrides: Partial<StrategyReportRow> = {}, metricsOverrides: Partial<AggregatedMetrics> = {}): StrategyReportRow {
  return {
    metrics: metrics(metricsOverrides),
    recoveryRateBySeed: [0.4],
    oracleHeadroomPct: 70,
    ...overrides,
  };
}

describe("renderBenchmarkTable", () => {
  it("produces a well-formed markdown table with a header separator row", () => {
    const table = renderBenchmarkTable([row()]);
    const lines = table.split("\n");
    expect(lines[0]).toContain("Strategy");
    expect(lines[1]).toMatch(/^\|---/);
    expect(lines[2]).toContain("rules-engine");
  });

  it("shows mean ± spread when multiple seeds disagree", () => {
    const table = renderBenchmarkTable([row({ recoveryRateBySeed: [0.3, 0.5, 0.4] })]);
    expect(table).toContain("±");
  });

  it("shows an explicit zero-spread marker for identical seeds — proves determinism rather than hiding the check", () => {
    const table = renderBenchmarkTable([row({ recoveryRateBySeed: [0.4, 0.4, 0.4] })]);
    expect(table).toContain("40.0% ± 0.0pp");
  });

  it("omits the spread marker entirely for a single seed", () => {
    const table = renderBenchmarkTable([row({ recoveryRateBySeed: [0.4] })]);
    const dataLine = table.split("\n")[2]!;
    expect(dataLine).not.toContain("±");
  });

  it("formats negative net recovered with a leading minus, not a stray double sign", () => {
    const table = renderBenchmarkTable([row({}, { netRecoveredPaise: -1234 })]);
    const dataLine = table.split("\n")[2]!;
    expect(dataLine).toContain("-₹12.34");
    expect(dataLine).not.toContain("--");
  });

  it("renders — for null contactsPerRecovery and oracleHeadroomPct rather than crashing", () => {
    const table = renderBenchmarkTable([row({ oracleHeadroomPct: null }, { contactsPerRecovery: null })]);
    expect(table).toContain("—");
  });
});

describe("renderTerminalSplit", () => {
  it("shows the proposed/executed split as X/Y fractions", () => {
    const table = renderTerminalSplit([row({}, { terminalProposed: 4, terminalExecuted: 0, terminalScenarios: 50 })]);
    expect(table).toContain("4/50");
    expect(table).toContain("0/50");
  });
});

describe("renderOfferSplit", () => {
  it("always shows offersSent as X/Y with the no-amount-parameter note", () => {
    const table = renderOfferSplit([row({}, { offersProposed: 6, offersSent: 0, episodes: 50 })]);
    expect(table).toContain("6/50");
    expect(table).toContain("0/50 — no amount parameter exists");
  });
});

describe("renderPairedComparison", () => {
  it("states significance clearly when the CI excludes zero", () => {
    const text = renderPairedComparison("salvage-agent", "rules-engine", {
      n: 360,
      meanDiffPaise: 5000,
      ci95LowPaise: 1000,
      ci95HighPaise: 9000,
      significant: true,
    });
    expect(text).toContain("excludes zero");
    expect(text).toContain("salvage-agent wins");
  });

  it("states non-significance clearly when the CI crosses zero", () => {
    const text = renderPairedComparison("salvage-agent", "rules-engine", {
      n: 360,
      meanDiffPaise: 100,
      ci95LowPaise: -2000,
      ci95HighPaise: 2200,
      significant: false,
    });
    expect(text).toContain("crosses zero");
    expect(text).toContain("not distinguishable from noise");
  });

  it("handles zero paired data without crashing", () => {
    const text = renderPairedComparison("salvage-agent", "rules-engine", {
      n: 0,
      meanDiffPaise: 0,
      ci95LowPaise: 0,
      ci95HighPaise: 0,
      significant: false,
    });
    expect(text).toContain("No paired data");
  });
});

describe("renderCostSummary", () => {
  it("renders total LLM cost and cost per ₹100 recovered", () => {
    const table = renderCostSummary([row({}, { strategyName: "salvage-agent", llmCostPaiseTotal: 4500, costPaisePer100RupeesRecovered: 12 })]);
    expect(table).toContain("salvage-agent");
    expect(table).toContain("₹45.00");
    expect(table).toContain("₹0.12");
  });

  it("renders — when cost-per-100 is null (nothing recovered to divide by)", () => {
    const table = renderCostSummary([row({}, { costPaisePer100RupeesRecovered: null })]);
    expect(table).toContain("—");
  });
});

// The guard that would have caught block 11's config A run: Ollama had
// stopped, every agent episode silently fell back to RulesStrategy, and the
// report printed an agent row byte-identical to the rules baseline with no
// indication anything was wrong.
describe("renderFallbackWarning", () => {
  it("says nothing when no agent episodes ran (deterministic-only run)", () => {
    expect(renderFallbackWarning([row({}, { strategyName: "rules-engine", agentAttempts: 0, llmFallbacks: 0 })])).toBe("");
  });

  it("says nothing when the agent ran and never fell back", () => {
    expect(renderFallbackWarning([row({}, { strategyName: "salvage-agent", agentAttempts: 60, llmFallbacks: 0 })])).toBe("");
  });

  it("flags a partial fallback rate as a blend, not a clean agent result", () => {
    const out = renderFallbackWarning([row({}, { strategyName: "salvage-agent", agentAttempts: 60, llmFallbacks: 15 })]);
    expect(out).toContain("WARNING");
    expect(out).toContain("15/60");
    expect(out).toContain("25.0%");
    expect(out).toContain("blend");
    expect(out).not.toContain("INVALID");
  });

  it("calls a 100% fallback rate INVALID and names it as the rules baseline in disguise", () => {
    const out = renderFallbackWarning([row({}, { strategyName: "salvage-agent", agentAttempts: 20, llmFallbacks: 20 })]);
    expect(out).toContain("INVALID");
    expect(out).toContain("20/20");
    expect(out).toContain("100.0%");
    expect(out).toContain("rules baseline under another name");
    expect(out).toContain("must not be reported as an agent result");
  });
});
