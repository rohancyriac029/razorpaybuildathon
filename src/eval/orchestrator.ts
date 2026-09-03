// Spec §6 block 8: drives all 5 strategies (§5.3) across the replay set,
// for each seed, and returns the raw per-episode results for aggregation.
// Kept separate from eval/run.ts (the CLI) so it's directly testable with
// a small scenario count and no real LLM calls.
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import { generateScenarios } from "./generator.js";
import { CachingLlmClient } from "../llm/cache.js";
import { NoRetryStrategy } from "../strategies/no-retry.js";
import { FixedIntervalStrategy } from "../strategies/fixed-interval.js";
import { RulesStrategy } from "../strategies/rules.js";
import { AgentStrategy } from "../agent/agent-strategy.js";
import { OracleStrategy } from "../strategies/oracle.js";
import { ScenarioRegistry } from "./scenario-registry.js";
import { runEpisode, type EpisodeRunResult } from "./run-episode.js";
import { EVAL_ANCHOR_TIME, SCENARIO_GENERATION_SEED, type GeneratorConfig } from "./generator-config.js";
import type { LlmClient } from "../llm/client.js";
import type { Scenario } from "./scenario.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface OrchestratorOptions {
  db: Db;
  config: GeneratorConfig;
  scenarioCount: number;
  seeds: number[];
  /** null = skip the agent strategy entirely (e.g. no LLM credentials available) — the eval still runs the other 4 strategies. */
  llmClient: LlmClient | null;
  onProgress?: (msg: string) => void;
}

export interface EvalRunOutput {
  runId: string;
  scenarios: Scenario[];
  resultsByStrategy: Map<string, EpisodeRunResult[]>;
}

export async function runFullEval(opts: OrchestratorOptions): Promise<EvalRunOutput> {
  const scenarios = generateScenarios(opts.config, opts.scenarioCount, SCENARIO_GENERATION_SEED, EVAL_ANCHOR_TIME);
  const runId = `eval_${opts.config.name}_${Date.now()}`;
  const resultsByStrategy = new Map<string, EpisodeRunResult[]>();

  const push = (r: EpisodeRunResult) => {
    const arr = resultsByStrategy.get(r.strategyName) ?? [];
    arr.push(r);
    resultsByStrategy.set(r.strategyName, arr);
  };

  for (const seed of opts.seeds) {
    // Deterministic strategies: fresh instances per seed cost nothing and
    // avoid any risk of cross-seed state leaking (none currently holds
    // any, but constructing fresh is the cheap way to keep it that way).
    const deterministicStrategies = [new NoRetryStrategy(), new FixedIntervalStrategy(), new RulesStrategy()];

    for (const strategy of deterministicStrategies) {
      for (const scenario of scenarios) {
        const result = await runEpisode(opts.db, scenario, strategy, opts.config, seed, runId, new ScenarioRegistry());
        push(result);
        opts.onProgress?.(`${strategy.name} seed=${seed} ${scenario.id} recovered=${result.recovered}`);
      }
    }

    // Oracle needs a registry shared with SimWorld per episode — see
    // run-episode.ts's doc on why this can't be a single shared instance
    // reused blindly (a fresh one per call is correct and cheap).
    for (const scenario of scenarios) {
      const registry = new ScenarioRegistry();
      const oracle = new OracleStrategy(registry, opts.config);
      const result = await runEpisode(opts.db, scenario, oracle, opts.config, seed, runId, registry);
      push(result);
      opts.onProgress?.(`oracle seed=${seed} ${scenario.id} recovered=${result.recovered}`);
    }

    if (opts.llmClient) {
      for (const scenario of scenarios) {
        // One CachingLlmClient PER SCENARIO, not shared across the whole
        // seed: the cache key needs an episode-scoping component (llm/
        // cache.ts) because the FIRST call of every episode has identical
        // empty turns — without per-scenario scoping here, two different
        // scenarios' first calls would silently share one cached response.
        const episodeKey = `${opts.config.name}_${scenario.id}`;
        const cachedLlm = new CachingLlmClient(opts.llmClient, opts.db, seed, episodeKey);
        const agent = new AgentStrategy(cachedLlm, new RulesStrategy());
        const result = await runEpisode(opts.db, scenario, agent, opts.config, seed, runId, new ScenarioRegistry());
        push(result);
        opts.onProgress?.(`salvage-agent seed=${seed} ${scenario.id} recovered=${result.recovered}`);
      }
    }
  }

  return { runId, scenarios, resultsByStrategy };
}
