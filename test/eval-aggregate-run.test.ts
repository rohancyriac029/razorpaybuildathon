import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import { runFullEval } from "../src/eval/orchestrator.js";
import { aggregateRun } from "../src/eval/aggregate-run.js";
import { CONFIG_A } from "../src/eval/generator-config.js";
import { renderBenchmarkTable, renderPairedComparison } from "../src/eval/report.js";

describe("aggregateRun", () => {
  it("produces one row per strategy in the canonical order, oracle at 100% headroom", async () => {
    const db = makeTestDb();
    const output = await runFullEval({ db, config: CONFIG_A, scenarioCount: 15, seeds: [1], llmClient: null });
    const { rows, agentVsRules } = aggregateRun(output.resultsByStrategy, output.scenarios);

    expect(rows.map((r) => r.metrics.strategyName)).toEqual(["no-retry", "fixed-24h", "rules-engine", "oracle"]);
    const oracleRow = rows.find((r) => r.metrics.strategyName === "oracle")!;
    expect(oracleRow.oracleHeadroomPct).toBe(100);
    expect(agentVsRules).toBeNull(); // no agent ran
  });

  it("no-retry's headroom is 0% (it recovers nothing while oracle recovers something)", async () => {
    const db = makeTestDb();
    const output = await runFullEval({ db, config: CONFIG_A, scenarioCount: 30, seeds: [1], llmClient: null });
    const { rows } = aggregateRun(output.resultsByStrategy, output.scenarios);

    const noRetryRow = rows.find((r) => r.metrics.strategyName === "no-retry")!;
    expect(noRetryRow.oracleHeadroomPct).toBe(0);
  });

  it("end-to-end: the resulting rows render into a well-formed markdown table", async () => {
    const db = makeTestDb();
    const output = await runFullEval({ db, config: CONFIG_A, scenarioCount: 10, seeds: [1, 2], llmClient: null });
    const { rows } = aggregateRun(output.resultsByStrategy, output.scenarios);
    const table = renderBenchmarkTable(rows);

    expect(table).toContain("no-retry");
    expect(table).toContain("oracle");
    expect(table.split("\n").length).toBe(rows.length + 2); // header + separator + one row per strategy
  });

  it("renderPairedComparison handles the no-agent-ran case via the n=0 path", () => {
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
