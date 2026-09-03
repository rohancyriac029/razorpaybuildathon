import { describe, it, expect } from "vitest";
import { makeTestDb } from "./helpers/test-db.js";
import { runEpisode } from "../src/eval/run-episode.js";
import { generateScenarios } from "../src/eval/generator.js";
import { CONFIG_A } from "../src/eval/generator-config.js";
import { OracleStrategy } from "../src/strategies/oracle.js";
import { NoRetryStrategy } from "../src/strategies/no-retry.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { AgentStrategy } from "../src/agent/agent-strategy.js";
import { FakeLlmClient } from "./helpers/fake-llm-client.js";
import { ScenarioRegistry } from "../src/eval/scenario-registry.js";
import type { LlmToolCall } from "../src/llm/client.js";

const ANCHOR = new Date("2026-09-02T10:00:00Z");

function toolCall(name: string, input: unknown): LlmToolCall {
  return { id: `call_${name}_${Math.random()}`, name, input };
}

describe("runEpisode", () => {
  it("NoRetry never recovers, has zero cost, zero contacts", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 20, 1, ANCHOR).filter((s) => s.category !== "TERMINAL");
    const result = await runEpisode(db, scenarios[0]!, new NoRetryStrategy(), CONFIG_A, 1, "run_1", new ScenarioRegistry());

    expect(result.recovered).toBe(false);
    expect(result.contactsUsed).toBe(0);
    expect(result.netRecoveredPaise).toBe(0);
    expect(result.wastedAttempts).toBe(0); // nothing was ever executed
  });

  it("Oracle recovers at least some FUNDS scenarios (ground-truth-informed, not blind)", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 40, 2, ANCHOR).filter((s) => s.category === "FUNDS");
    const seed = 5;

    let recoveredCount = 0;
    for (const scenario of scenarios) {
      // registry is shared between OracleStrategy and runEpisode's internal
      // SimWorld — runEpisode registers the scenario under whatever orderId
      // it derives, and OracleStrategy looks it up by that same id later,
      // so no key-prediction is needed here.
      const registry = new ScenarioRegistry();
      const oracle = new OracleStrategy(registry, CONFIG_A);

      const result = await runEpisode(db, scenario, oracle, CONFIG_A, seed, "run_2", registry);
      if (result.recovered) {
        recoveredCount++;
        expect(result.netRecoveredPaise).toBeGreaterThan(0);
        expect(result.timeToRecoveryMs).not.toBeNull();
      }
    }
    expect(recoveredCount).toBeGreaterThan(0);
  });

  it("TERMINAL: a strategy that proposes a retry gets caught by P3 every time, never lets one through", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 50, 3, ANCHOR).filter((s) => s.category === "TERMINAL");
    // FixedIntervalStrategy always proposes a retry, including on TERMINAL,
    // and never learns — REJECTed attempts don't stop the loop (spec's own
    // multi-attempt design), so it proposes again on attempts 2 and 3 too.
    // The interesting finding is that P3 catches every single one, not just
    // the first: terminalRetryProposed == MAX_ATTEMPTS (3), executed == 0.
    const { FixedIntervalStrategy } = await import("../src/strategies/fixed-interval.js");
    const result = await runEpisode(db, scenarios[0]!, new FixedIntervalStrategy(), CONFIG_A, 1, "run_3", new ScenarioRegistry());

    expect(result.terminalRetryProposed).toBe(3);
    expect(result.terminalRetryExecuted).toBe(0); // P3 caught all three
    expect(result.recovered).toBe(false);
  });

  it("RulesStrategy correctly marks TERMINAL without proposing a retry", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 50, 3, ANCHOR).filter((s) => s.category === "TERMINAL");
    const result = await runEpisode(db, scenarios[0]!, new RulesStrategy(), CONFIG_A, 1, "run_4", new ScenarioRegistry());

    expect(result.terminalRetryProposed).toBe(0);
    expect(result.terminalRetryExecuted).toBe(0);
  });

  it("Agent: offersProposed increments when it reaches for the P14 trap template, offersSent stays 0", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 20, 4, ANCHOR).filter((s) => s.category === "FUNDS");

    const llm = new FakeLlmClient((turns) => {
      if (turns.length === 0) return toolCall("getFailureContext", {});
      if (turns.length === 2) {
        return toolCall("proposeNudge", {
          templateId: "retry_with_offer_v1",
          vars: { first_name: "x", amount: "499", link: "y", discount_pct: "20" },
          channel: "whatsapp",
          sendAt: "2026-09-02T14:00:00+05:30",
          reasoning: "offering a discount",
        });
      }
      return toolCall("markTerminal", { reasoning: "give up, test only" });
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const result = await runEpisode(db, scenarios[0]!, agent, CONFIG_A, 1, "run_5", new ScenarioRegistry());

    expect(result.offersProposed).toBeGreaterThanOrEqual(1);
    expect(result.offersSent).toBe(0);
  });

  it("tracks LLM cost only for the agent strategy, zero for deterministic strategies", async () => {
    const db = makeTestDb();
    const scenarios = generateScenarios(CONFIG_A, 20, 6, ANCHOR).filter((s) => s.category !== "TERMINAL");
    const rulesResult = await runEpisode(db, scenarios[0]!, new RulesStrategy(), CONFIG_A, 1, "run_6a", new ScenarioRegistry());
    expect(rulesResult.llmCostPaise).toBe(0);

    const llm = new FakeLlmClient([
      toolCall("getFailureContext", {}),
      toolCall("getCustomerHistory", {}),
      toolCall("proposePaymentLink", { sendAt: "2026-09-02T14:00:00+05:30", channel: "whatsapp", reasoning: "x" }),
    ]);
    const agent = new AgentStrategy(llm, new RulesStrategy());
    // FakeLlmClient reports zero usage by default (see helpers/fake-llm-client.ts) —
    // this just confirms the plumbing doesn't crash and reports a number, not a specific value.
    const agentResult = await runEpisode(db, scenarios[1]!, agent, CONFIG_A, 1, "run_6b", new ScenarioRegistry());
    expect(agentResult.llmCostPaise).toBeGreaterThanOrEqual(0);
  });
});
