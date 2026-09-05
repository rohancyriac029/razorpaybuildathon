#!/usr/bin/env -S npx tsx
// Spec §6 block 6/8: `npm run eval` — "prints a markdown table." Runs the
// full replay set (spec §5.9's [synthetic] batch) across all 5 strategies
// (§5.3) and n seeds (§5.2 point 5), then prints the benchmark table, the
// TERMINAL split (§5.5), the P14 discount split (§5.5.1), the cost summary
// (§5.4), and the paired bootstrap comparison (§5.8).
//
// Config defaults to B (the headline config, spec §9's README structure —
// "config B, n=3, mean ± spread"). Override with EVAL_CONFIG=A for the
// tuning config. EVAL_SCENARIOS/EVAL_SEEDS override the 120/3 defaults —
// use small values for a smoke test; see PROGRESS.md block 8 for the exact
// commands and what a full 120x3 run costs against Gemini's free-tier quota.
import { existsSync } from "node:fs";
try {
  if (existsSync(".env")) process.loadEnvFile(".env");
} catch {
  // no .env — fine, env vars may already be set in the shell
}

import { makeEvalDb } from "../src/eval/eval-db.js";
import { runFullEval } from "../src/eval/orchestrator.js";
import { aggregateRun } from "../src/eval/aggregate-run.js";
import { CONFIG_A, CONFIG_B } from "../src/eval/generator-config.js";
import {
  renderBenchmarkTable,
  renderFallbackWarning,
  renderTerminalSplit,
  renderOfferSplit,
  renderPairedComparison,
  renderCostSummary,
  renderBaselineAnchoring,
} from "../src/eval/report.js";
import { llmClientFromEnv } from "../src/llm/factory.js";
import { resetEvalState } from "../src/eval/reset-state.js";
import type { LlmClient } from "../src/llm/client.js";

const configName = process.env.EVAL_CONFIG === "A" ? "A" : "B";
const config = configName === "A" ? CONFIG_A : CONFIG_B;
const scenarioCount = Number(process.env.EVAL_SCENARIOS ?? 120);
const seedCount = Math.max(1, Number(process.env.EVAL_SEEDS ?? 3));
const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);
const dbPath = process.env.EVAL_DB ?? "./salvage-eval.sqlite";

let llmClient: LlmClient | null = null;
try {
  llmClient = llmClientFromEnv();
  console.error(`[eval] LLM provider: ${llmClient.provider} (${llmClient.model})`);
} catch (err) {
  console.error(
    `[eval] No LLM client available (${err instanceof Error ? err.message : String(err)}) — running WITHOUT the salvage-agent strategy. The other 4 strategies still run.`,
  );
}

const totalEpisodes = scenarioCount * seeds.length * (llmClient ? 5 : 4);
console.error(
  `[eval] config=${config.name} scenarios=${scenarioCount} seeds=${seeds.join(",")} -> ${totalEpisodes} episodes` +
    (llmClient ? ` (salvage-agent may call the LLM up to ~3x per episode; a full 120x3 run takes a while — see PROGRESS.md block 8/11 for per-provider timing)` : ""),
);

const db = makeEvalDb(dbPath);

// Every run starts from clean policy state but keeps the committed LLM cache
// — without this, P10's system-wide execution cap counts the PREVIOUS run's
// executions and starves this one into an all-zeros table. See
// src/eval/reset-state.ts for the full story; this is not a hypothetical.
const reset = resetEvalState(db);
console.error(
  `[eval] reset policy state: cleared ${reset.clearedRows} rows from prior runs, kept ${reset.cachedResponsesKept} cached LLM responses`,
);

const startedAt = Date.now();
let completed = 0;

const output = await runFullEval({
  db,
  config,
  scenarioCount,
  seeds,
  llmClient,
  onProgress: () => {
    completed++;
    if (completed % 10 === 0 || completed === totalEpisodes) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      process.stderr.write(`\r[eval] ${completed}/${totalEpisodes} episodes (${elapsed}s elapsed)   `);
    }
  },
});
console.error();

const { rows, agentVsRules } = aggregateRun(output.resultsByStrategy, output.scenarios);

console.log(`# salvage eval — config ${config.name}, ${scenarioCount} scenarios, seeds [${seeds.join(", ")}]\n`);

// Printed ABOVE the table on purpose: if the agent silently fell back to the
// rules engine, every number below it is suspect and the reader needs to know
// before they read them, not in a footnote after.
const fallbackWarning = renderFallbackWarning(rows);
if (fallbackWarning) console.log(`${fallbackWarning}\n`);

console.log("## Benchmark\n");
console.log(renderBenchmarkTable(rows));

console.log("\n## TERMINAL split (spec §5.5) — \"worth ten times a zero\"\n");
console.log(renderTerminalSplit(rows));

console.log("\n## Discount/offer split (spec §5.5.1, P14)\n");
console.log(renderOfferSplit(rows));

const baselineAnchoring = renderBaselineAnchoring(rows);
if (baselineAnchoring) {
  console.log("\n## Baseline anchoring — did the LLM actually decide anything?\n");
  console.log(baselineAnchoring);
}

console.log("\n## Cost, including LLM tokens (spec §5.4)\n");
console.log(renderCostSummary(rows));

if (agentVsRules) {
  console.log("\n## salvage-agent vs rules-engine — paired bootstrap (spec §5.8)\n");
  console.log(renderPairedComparison("salvage-agent", "rules-engine", agentVsRules));
}

console.log(
  `\n_Run id: \`${output.runId}\`. Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(0)}s. ` +
    `Database: \`${dbPath}\` (commit this — it carries the LLM response cache, spec §5.8)._`,
);
