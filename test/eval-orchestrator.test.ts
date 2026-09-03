import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import { runFullEval } from "../src/eval/orchestrator.js";
import { CONFIG_A } from "../src/eval/generator-config.js";

describe("runFullEval (orchestrator)", () => {
  it("runs all 4 deterministic strategies across every scenario and seed when llmClient is null", async () => {
    const db = makeTestDb();
    const output = await runFullEval({
      db,
      config: CONFIG_A,
      scenarioCount: 10,
      seeds: [1, 2],
      llmClient: null,
    });

    expect(output.scenarios).toHaveLength(10);
    const strategyNames = [...output.resultsByStrategy.keys()].sort();
    expect(strategyNames).toEqual(["fixed-24h", "no-retry", "oracle", "rules-engine"]); // agent skipped, no llmClient

    for (const name of strategyNames) {
      const rows = output.resultsByStrategy.get(name)!;
      expect(rows).toHaveLength(20); // 10 scenarios x 2 seeds
    }
  });

  it("deterministic strategies produce identical recovery outcomes across seeds (proves they truly don't depend on seed)", async () => {
    const db = makeTestDb();
    const output = await runFullEval({
      db,
      config: CONFIG_A,
      scenarioCount: 8,
      seeds: [1, 2, 3],
      llmClient: null,
    });

    const rulesRows = output.resultsByStrategy.get("rules-engine")!;
    const bySeed = new Map<number, boolean[]>();
    for (const r of rulesRows) {
      const arr = bySeed.get(r.seed) ?? [];
      arr.push(r.recovered);
      bySeed.set(r.seed, arr);
    }
    const seed1 = bySeed.get(1)!;
    const seed2 = bySeed.get(2)!;
    const seed3 = bySeed.get(3)!;
    expect(seed1).toEqual(seed2);
    expect(seed2).toEqual(seed3);
  });

  it("NoRetry recovers nothing, Oracle recovers something, across a real multi-seed run", async () => {
    const db = makeTestDb();
    const output = await runFullEval({
      db,
      config: CONFIG_A,
      scenarioCount: 30,
      seeds: [1],
      llmClient: null,
    });

    const noRetryRows = output.resultsByStrategy.get("no-retry")!;
    expect(noRetryRows.every((r) => !r.recovered)).toBe(true);

    const oracleRows = output.resultsByStrategy.get("oracle")!;
    expect(oracleRows.some((r) => r.recovered)).toBe(true);
  });
});
