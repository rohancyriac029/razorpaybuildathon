// [Block 11] Resets the eval database's POLICY-RELEVANT state before a run,
// while deliberately preserving `llm_cache` — the one table spec §5.8 wants
// committed and reused ("a reviewer reruns the identical table with no API
// key"). Without this, `npm run eval` is not safely repeatable against the
// committed database, and that is not a hypothetical:
//
// P10 (spec §4.1) caps executions system-wide by querying `episodes` /
// `intents` with no run scoping. That is CORRECT for production — a global
// cap that ignored executions from another code path would not be a global
// cap. But the eval deliberately persists its database across runs (it
// carries the cache), and every eval episode is timestamped around the same
// fixed EVAL_ANCHOR_TIME. So run N+1's very first proposal is evaluated
// against run N's accumulated executions, all of which sit inside P10's
// one-hour window. Once total executions exceed globalExecPerHour (default
// 20), EVERY execution-bound proposal in every later run is P10-rejected and
// the whole benchmark table reads 0.0% — for every strategy, including the
// oracle.
//
// Found the hard way: a 20-scenario run against a database carrying ~10k
// accumulated episodes from earlier killed full-scale attempts produced
// exactly that all-zeros table, while the identical config against a fresh
// database produced sane, reproducible numbers (rules-engine 40%, oracle
// 15%, twice, byte-identical). See PROGRESS.md block 11.
//
// This also clears `eval_runs`, which matters for a second reason: a run
// killed midway leaves partial rows behind, and `latestRunReport` (block 9,
// what the HTML scoreboard reads) picks the most recent run — so a partial
// run would silently render as the headline result.
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";

type Db = BetterSQLite3Database<typeof schema>;

/** Eval state that policy queries and simulated execution mutate. */
const POLICY_TABLES_TO_CLEAR = [
  "intents",
  "episodes",
  "failures",
  "orders",
  "subscriptions",
  "webhook_events",
  "customers",
] as const;

/** Every table except `llm_cache`, in foreign-key-safe deletion order. */
const TABLES_TO_CLEAR = [...POLICY_TABLES_TO_CLEAR, "eval_runs"] as const;

export interface ResetStats {
  clearedRows: number;
  cachedResponsesKept: number;
}

/**
 * Clears prior runs' policy-relevant state from the eval database. Safe to
 * call on a fresh database (deletes nothing). Never touches `llm_cache`.
 *
 * Deliberately NOT wired into `makeEvalDb` — this must only ever run from
 * the eval CLI, never implicitly from anything that opens an eval database,
 * so that a mis-set EVAL_DB pointing at a real database can't silently
 * destroy production episodes.
 */
export function resetEvalState(db: Db): ResetStats {
  const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: () => { changes: number } }; pragma: (p: string) => void } }).$client;

  const cachedBefore = db.select().from(schema.llmCache).all().length;

  let clearedRows = 0;
  sqlite.pragma("foreign_keys = OFF");
  try {
    for (const table of TABLES_TO_CLEAR) {
      clearedRows += sqlite.prepare(`DELETE FROM ${table}`).run().changes;
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }

  return { clearedRows, cachedResponsesKept: cachedBefore };
}

/**
 * Isolates one strategy's policy state inside a single eval run while
 * retaining persisted results and the LLM cache.
 */
export function resetEvalPolicyState(db: Db): void {
  const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { run: () => unknown }; pragma: (p: string) => void } }).$client;

  sqlite.pragma("foreign_keys = OFF");
  try {
    for (const table of POLICY_TABLES_TO_CLEAR) {
      sqlite.prepare(`DELETE FROM ${table}`).run();
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}
