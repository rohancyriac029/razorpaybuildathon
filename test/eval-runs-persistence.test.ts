import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "./helpers/test-db.js";
import * as schema from "../src/db/schema.js";
import { runEpisode } from "../src/eval/run-episode.js";
import { generateScenarios } from "../src/eval/generator.js";
import { CONFIG_A } from "../src/eval/generator-config.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { ScenarioRegistry } from "../src/eval/scenario-registry.js";

const ANCHOR = new Date("2026-09-02T10:00:00Z");

describe("runEpisode persists to eval_runs (spec §3.4: replayable from the DB)", () => {
  it("writes exactly one eval_runs row per call, matching the returned EpisodeRunResult", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 10, 1, ANCHOR).filter((s) => s.category !== "TERMINAL");
    const result = await runEpisode(db, scenarios[0]!, new RulesStrategy(), CONFIG_A, 1, "run_test", new ScenarioRegistry());

    const rows = db.select().from(schema.evalRuns).where(eq(schema.evalRuns.runId, "run_test")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strategyName).toBe("rules-engine");
    expect(rows[0]!.scenarioId).toBe(scenarios[0]!.id);
    expect(rows[0]!.recovered).toBe(result.recovered);
    expect(rows[0]!.netRecoveredPaise).toBe(result.netRecoveredPaise);
    expect(rows[0]!.configName).toBe("A");
  });

  it("separate runIds don't collide even for the identical scenario/strategy/seed", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 10, 1, ANCHOR).filter((s) => s.category !== "TERMINAL");
    await runEpisode(db, scenarios[0]!, new RulesStrategy(), CONFIG_A, 1, "run_A", new ScenarioRegistry());
    await runEpisode(db, scenarios[0]!, new RulesStrategy(), CONFIG_A, 1, "run_B", new ScenarioRegistry());

    const allRows = db.select().from(schema.evalRuns).all();
    expect(allRows).toHaveLength(2);
    expect(new Set(allRows.map((r) => r.runId))).toEqual(new Set(["run_A", "run_B"]));
  });
});
