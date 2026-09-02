import { describe, it, expect } from "vitest";
import { NoRetryStrategy } from "../src/strategies/no-retry.js";
import { FixedIntervalStrategy } from "../src/strategies/fixed-interval.js";
import { OracleStrategy } from "../src/strategies/oracle.js";
import { ScenarioRegistry } from "../src/eval/scenario-registry.js";
import { CONFIG_A } from "../src/eval/generator-config.js";
import { generateScenarios } from "../src/eval/generator.js";
import { wouldSucceed } from "../src/eval/ground-truth.js";
import type { EpisodeContext, FailureCategory, Order, FailureEvent, PriorAttempt } from "../src/types.js";
import type { Scenario } from "../src/eval/scenario.js";

const ANCHOR = new Date("2026-09-02T10:00:00Z"); // 15:30 IST, safe daytime

function order(): Order {
  return {
    id: "order_1",
    razorpayOrderId: "order_rzp_1",
    razorpaySubscriptionId: null,
    customerId: "cust_1",
    amount: 49900,
    currency: "INR",
    status: "attempted",
    createdAt: "2026-09-01T00:00:00Z",
  };
}

function ctx(category: FailureCategory, priorAttempts: PriorAttempt[] = []): EpisodeContext {
  const failure: FailureEvent = {
    id: "fail_1",
    orderId: "order_1",
    eventId: "evt_1",
    razorpayPaymentId: "pay_1",
    errorCode: null,
    errorSource: null,
    errorStep: null,
    errorReason: "test_reason",
    category,
    attemptNumber: priorAttempts.length + 1,
    occurredAt: ANCHOR.toISOString(),
  };
  return {
    failureContext: {
      order: order(),
      failure,
      attemptNumber: priorAttempts.length + 1,
      priorAttempts,
      economics: { attemptsRemaining: 3, contactsRemaining: 2, attemptCostPaise: 200, amountAtStakePaise: 49900 },
    },
    history: { customerId: "cust_1", isFirstTime: true, lastPayments: [], workingInstrument: null },
    now: ANCHOR,
  };
}

describe("NoRetryStrategy", () => {
  it("always escalates, regardless of category", async () => {
    const strategy = new NoRetryStrategy();
    for (const category of ["TRANSIENT", "FUNDS", "AUTH_ABANDONED", "INSTRUMENT", "TERMINAL"] as FailureCategory[]) {
      const proposal = await strategy.propose(ctx(category));
      expect(proposal.type).toBe("ESCALATE");
    }
  });
});

describe("FixedIntervalStrategy", () => {
  it("always proposes a payment link at exactly +24h, even on TERMINAL (deliberately naive)", async () => {
    const strategy = new FixedIntervalStrategy();
    for (const category of ["TRANSIENT", "FUNDS", "TERMINAL"] as FailureCategory[]) {
      const proposal = await strategy.propose(ctx(category));
      expect(proposal.type).toBe("PAYMENT_LINK");
      expect(proposal.sendAt).toBe(new Date(ANCHOR.getTime() + 24 * 3_600_000).toISOString());
    }
  });

  it("is deterministic and category-blind: identical proposal for every category", async () => {
    const strategy = new FixedIntervalStrategy();
    const a = await strategy.propose(ctx("TRANSIENT"));
    const b = await strategy.propose(ctx("INSTRUMENT"));
    expect(a.sendAt).toBe(b.sendAt);
    expect(a.channel).toBe(b.channel);
  });
});

describe("OracleStrategy", () => {
  function scenarioCtx(scenario: Scenario, priorAttempts: PriorAttempt[] = []): EpisodeContext {
    return ctx(scenario.category, priorAttempts);
  }

  it("proposes markTerminal for a TERMINAL scenario, never a retry", async () => {
    const registry = new ScenarioRegistry();
    const scenarios = generateScenarios(CONFIG_A, 50, 4, ANCHOR).filter((s) => s.category === "TERMINAL");
    const scenario = scenarios[0]!;
    registry.register("order_1", scenario);

    const strategy = new OracleStrategy(registry, CONFIG_A);
    const proposal = await strategy.propose(scenarioCtx(scenario));
    expect(proposal.type).toBe("MARK_TERMINAL");
  });

  it("finds a genuinely winning candidate for at least some FUNDS scenarios (ground-truth informed, not blind)", async () => {
    const registry = new ScenarioRegistry();
    const scenarios = generateScenarios(CONFIG_A, 100, 6, ANCHOR).filter((s) => s.category === "FUNDS");
    const strategy = new OracleStrategy(registry, CONFIG_A);

    let wins = 0;
    for (const scenario of scenarios) {
      registry.register("order_1", scenario);
      const proposal = await strategy.propose(scenarioCtx(scenario));
      if (proposal.type === "PAYMENT_LINK") {
        const succeeded = wouldSucceed(scenario, proposal, new Date(proposal.sendAt), CONFIG_A);
        expect(succeeded).toBe(true); // the oracle must only ever RETURN a candidate it verified succeeds
        wins++;
      }
    }
    expect(wins).toBeGreaterThan(0); // it should actually win sometimes, not just always escalate
  });

  it("every returned PAYMENT_LINK/NUDGE proposal from the oracle is a verified success against ground truth (never a lucky-looking guess)", async () => {
    const registry = new ScenarioRegistry();
    const scenarios = generateScenarios(CONFIG_A, 150, 15, ANCHOR).filter((s) => s.category !== "TERMINAL");
    const strategy = new OracleStrategy(registry, CONFIG_A);

    for (const scenario of scenarios) {
      registry.register("order_1", scenario);
      const proposal = await strategy.propose(scenarioCtx(scenario));
      if (proposal.type === "PAYMENT_LINK" || proposal.type === "NUDGE") {
        expect(wouldSucceed(scenario, proposal, new Date(proposal.sendAt), CONFIG_A)).toBe(true);
      } else {
        expect(proposal.type).toBe("ESCALATE"); // the only other legitimate outcome for a non-TERMINAL scenario
      }
    }
  });

  it("does not retry a proposal type already tried in a prior attempt", async () => {
    const registry = new ScenarioRegistry();
    const scenarios = generateScenarios(CONFIG_A, 50, 6, ANCHOR).filter((s) => s.category === "AUTH_ABANDONED");
    const scenario = scenarios[0]!;
    registry.register("order_1", scenario);

    const priorAttempt: PriorAttempt = {
      attemptNumber: 1,
      reasoning: "prior",
      proposal: {
        type: "NUDGE",
        orderId: "order_1",
        attemptNumber: 1,
        reasoning: "x",
        proposedAt: ANCHOR.toISOString(),
        sendAt: ANCHOR.toISOString(),
        channel: "whatsapp",
        templateId: "auth_incomplete_v1",
        vars: {},
      },
      verdict: { kind: "APPROVE", ruleId: "P0", reason: "test" },
      outcome: "failed_again",
    };

    const strategy = new OracleStrategy(registry, CONFIG_A);
    const proposal = await strategy.propose(scenarioCtx(scenario, [priorAttempt]));
    // NUDGE already tried and failed — oracle should not propose NUDGE
    // again for AUTH_ABANDONED (its only real lever), so it escalates.
    expect(proposal.type).not.toBe("NUDGE");
  });
});
