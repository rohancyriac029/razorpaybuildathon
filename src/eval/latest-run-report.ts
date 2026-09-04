// Spec §6 block 9: the static HTML page's eval-scoreboard data source.
// Reads the most recent `npm run eval` invocation's persisted eval_runs
// rows (run-episode.ts writes these) and turns them into the same
// StrategyReportRow[] shape aggregate-run.ts produces from in-memory
// results — one aggregation implementation, not two that could drift.
import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { aggregateRun } from "./aggregate-run.js";
import type { EpisodeRunResult } from "./run-episode.js";
import type { Scenario } from "./scenario.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface LatestRunReport {
  runId: string | null;
  configName: string | null;
  rows: ReturnType<typeof aggregateRun>["rows"];
  agentVsRules: ReturnType<typeof aggregateRun>["agentVsRules"];
}

export function latestRunReport(db: Db): LatestRunReport {
  const latest = db
    .select({ runId: schema.evalRuns.runId })
    .from(schema.evalRuns)
    .orderBy(desc(schema.evalRuns.createdAt))
    .limit(1)
    .get();

  if (!latest) {
    return { runId: null, configName: null, rows: [], agentVsRules: null };
  }

  const dbRows = db.select().from(schema.evalRuns).where(eq(schema.evalRuns.runId, latest.runId)).all();

  const resultsByStrategy = new Map<string, EpisodeRunResult[]>();
  for (const row of dbRows) {
    const result: EpisodeRunResult = {
      scenarioId: row.scenarioId,
      strategyName: row.strategyName,
      seed: row.seed,
      recovered: row.recovered,
      netRecoveredPaise: row.netRecoveredPaise,
      wastedAttempts: row.wastedAttempts,
      contactsUsed: row.contactsUsed,
      terminalRetryProposed: row.terminalRetriesProposed,
      terminalRetryExecuted: row.terminalRetriesExecuted,
      offersProposed: row.offersProposed,
      offersSent: row.offersSent,
      timeToRecoveryMs: row.timeToRecoveryMs,
      llmCostPaise: row.llmCostPaiseUsd ?? 0,
      // Not persisted to eval_runs (adding columns would need a migration
      // this late), so the HTML scoreboard cannot show the LLM-fallback
      // warning — same class of documented limitation as this file's
      // post-hoc TERMINAL inference below. `npm run eval`'s own stdout,
      // which computes these live, stays the authoritative view and is
      // where the warning is printed.
      llmFallbacks: 0,
      agentAttempts: 0,
    };
    const arr = resultsByStrategy.get(row.strategyName) ?? [];
    arr.push(result);
    resultsByStrategy.set(row.strategyName, arr);
  }

  // aggregateRun only needs .id and .category off each scenario (keyed by
  // id) for the TERMINAL split. The full Scenario — including hidden
  // ground truth — isn't persisted to eval_runs, deliberately: it's the
  // answer key, in the spirit of spec §5.2's firewall, and this table is
  // meant to be readable by a post-hoc HTML view, not double as a scenario
  // store. category isn't a column either, so it's inferred: run-episode.ts
  // only increments terminalRetriesProposed/Executed for TERMINAL scenarios,
  // so any scenarioId with a nonzero value on either is TERMINAL. This
  // undercounts scenarios where EVERY strategy correctly avoided proposing a
  // retry — acceptable for a post-hoc HTML view; the authoritative split is
  // `npm run eval`'s own stdout, computed from live Scenario objects.
  const terminalScenarioIds = new Set<string>();
  for (const row of dbRows) {
    if (row.terminalRetriesProposed > 0 || row.terminalRetriesExecuted > 0) {
      terminalScenarioIds.add(row.scenarioId);
    }
  }
  const allScenarioIds = new Set(dbRows.map((r) => r.scenarioId));
  const scenarios: Scenario[] = [...allScenarioIds].map(
    (id) => ({ id, category: terminalScenarioIds.has(id) ? "TERMINAL" : "TRANSIENT" }) as Scenario,
  );

  const { rows, agentVsRules } = aggregateRun(resultsByStrategy, scenarios);
  return { runId: latest.runId, configName: dbRows[0]?.configName ?? null, rows, agentVsRules };
}
