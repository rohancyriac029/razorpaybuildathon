// Real call against the live Gemini API. Skipped by default — same pattern
// as test/world-razorpay-live.test.ts. Run explicitly with:
//   LIVE_LLM_TESTS=true npm test -- agent-strategy-live
import { describe, it, expect } from "vitest";
import { AgentStrategy } from "../src/agent/agent-strategy.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { llmClientFromEnv } from "../src/llm/factory.js";
import type { EpisodeContext, FailureEvent, Order } from "../src/types.js";

const RUN_LIVE = process.env.LIVE_LLM_TESTS === "true";

function ctx(): EpisodeContext {
  const order: Order = {
    id: "order_live1",
    razorpayOrderId: "order_rzp_live1",
    razorpaySubscriptionId: null,
    customerId: "cust_live1",
    amount: 49900,
    currency: "INR",
    status: "attempted",
    createdAt: "2026-09-01T00:00:00Z",
  };
  const failure: FailureEvent = {
    id: "fail_live1",
    orderId: "order_live1",
    eventId: "evt_live1",
    razorpayPaymentId: "pay_live1",
    errorCode: "BAD_REQUEST_ERROR",
    errorSource: "customer",
    errorStep: "payment_authorization",
    errorReason: "insufficient_funds",
    category: "FUNDS",
    attemptNumber: 1,
    occurredAt: "2026-09-02T10:00:00Z",
  };
  return {
    failureContext: {
      order,
      failure,
      attemptNumber: 1,
      priorAttempts: [],
      economics: { attemptsRemaining: 3, contactsRemaining: 2, attemptCostPaise: 200, amountAtStakePaise: 49900 },
    },
    history: {
      customerId: "cust_live1",
      isFirstTime: false,
      lastPayments: [
        { paidAt: "2026-08-05T14:30:00Z", amount: 49900, method: "unknown", hourOfDayIst: 20 },
        { paidAt: "2026-07-05T14:35:00Z", amount: 49900, method: "unknown", hourOfDayIst: 20 },
      ],
      workingInstrument: null,
    },
    now: new Date("2026-09-02T10:00:00Z"),
  };
}

describe.skipIf(!RUN_LIVE)("AgentStrategy (LIVE, real Gemini call)", () => {
  it("investigates and proposes a real, valid, policy-shaped decision for a FUNDS failure", async () => {
    const llm = llmClientFromEnv();
    const agent = new AgentStrategy(llm, new RulesStrategy());

    const proposal = await agent.propose(ctx());

    expect(agent.lastFellBackToRules).toBe(false);
    expect(["TOKEN_RETRY", "PAYMENT_LINK", "NUDGE", "MARK_TERMINAL", "ESCALATE"]).toContain(proposal.type);
    expect(proposal.orderId).toBe("order_live1");
    expect(proposal.reasoning.length).toBeGreaterThan(10);

    // FUNDS is never TERMINAL and this history is clean — a genuinely
    // reasonable model should not give up immediately, but this is a real
    // model call, not a mock, so assert loosely rather than pin an exact
    // proposal type.
    console.log("Live agent decision:", proposal.type, "-", proposal.reasoning);
  }, 30_000);
});
