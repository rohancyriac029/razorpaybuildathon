import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import { runFullEval } from "../src/eval/orchestrator.js";
import { latestRunReport } from "../src/eval/latest-run-report.js";
import { CONFIG_A } from "../src/eval/generator-config.js";

describe("latestRunReport", () => {
  it("returns an empty report when no eval has ever run", () => {
    const db = makeTestDb();
    const report = latestRunReport(db);
    expect(report.runId).toBeNull();
    expect(report.rows).toEqual([]);
    expect(report.agentVsRules).toBeNull();
  });

  it("reconstructs the same strategy rows a fresh in-memory aggregation would produce", async () => {
    const db = makeTestDb();
    const output = await runFullEval({ db, config: CONFIG_A, scenarioCount: 15, seeds: [1], llmClient: null });

    const report = latestRunReport(db);
    expect(report.runId).toBe(output.runId);
    expect(report.configName).toBe("A");
    const strategyNames = report.rows.map((r) => r.metrics.strategyName).sort();
    expect(strategyNames).toEqual(["fixed-24h", "no-retry", "oracle", "rules-engine"]);

    const oracleRow = report.rows.find((r) => r.metrics.strategyName === "oracle")!;
    expect(oracleRow.metrics.episodes).toBe(15);
    expect(oracleRow.oracleHeadroomPct).toBe(100);
  });

  it("picks the MOST RECENT run when multiple exist", async () => {
    const db = makeTestDb();
    await runFullEval({ db, config: CONFIG_A, scenarioCount: 5, seeds: [1], llmClient: null });
    const second = await runFullEval({ db, config: CONFIG_A, scenarioCount: 8, seeds: [1], llmClient: null });

    const report = latestRunReport(db);
    expect(report.runId).toBe(second.runId);
    const noRetryRow = report.rows.find((r) => r.metrics.strategyName === "no-retry")!;
    expect(noRetryRow.metrics.episodes).toBe(8); // the second run's scenario count, not the first's
  });
});
