import { describe, it, expect } from "vitest";
import { AgentStrategy } from "../src/agent/agent-strategy.js";
import { RulesStrategy } from "../src/strategies/rules.js";
import { FakeLlmClient } from "./helpers/fake-llm-client.js";
import { getFailureContextResult, getCustomerHistoryResult } from "../src/agent/tools.js";
import type { EpisodeContext, FailureCategory, Order, FailureEvent } from "../src/types.js";
import type { LlmToolCall } from "../src/llm/client.js";

const NOW = new Date("2026-09-02T10:00:00Z"); // 15:30 IST, safe daytime

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

function ctx(category: FailureCategory, priorAttempts: EpisodeContext["failureContext"]["priorAttempts"] = []): EpisodeContext {
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
    occurredAt: NOW.toISOString(),
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
    now: NOW,
  };
}

function toolCall(name: string, input: unknown): LlmToolCall {
  return { id: `call_${name}`, name, input };
}

describe("AgentStrategy: happy paths", () => {
  it("getFailureContext -> getCustomerHistory -> proposePaymentLink produces a valid PaymentLinkProposal", async () => {
    const llm = new FakeLlmClient([
      toolCall("getFailureContext", {}),
      toolCall("getCustomerHistory", {}),
      toolCall("proposePaymentLink", {
        sendAt: "2026-09-02T14:00:00+05:30",
        channel: "whatsapp",
        reasoning: "TRANSIENT, healthy rails, retry in a few hours",
      }),
    ]);
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const proposal = await agent.propose(ctx("TRANSIENT"));

    expect(proposal.type).toBe("PAYMENT_LINK");
    expect(proposal.orderId).toBe("order_1");
    expect(proposal.attemptNumber).toBe(1);
    expect(agent.lastFellBackToRules).toBe(false);
    expect(agent.lastOfferAttempted).toBe(false);
  });

  it("TERMINAL: getFailureContext -> markTerminal", async () => {
    const llm = new FakeLlmClient([
      toolCall("getFailureContext", {}),
      toolCall("markTerminal", { reasoning: "stolen card, classification is authoritative" }),
    ]);
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const proposal = await agent.propose(ctx("TERMINAL"));
    expect(proposal.type).toBe("MARK_TERMINAL");
  });

  it("escalate produces a valid EscalateProposal with an explanation", async () => {
    const llm = new FakeLlmClient([
      toolCall("getFailureContext", {}),
      toolCall("getCustomerHistory", {}),
      toolCall("escalate", { reasoning: "conflicting signals", explanation: "history contradicts the failure timing" }),
    ]);
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const proposal = await agent.propose(ctx("FUNDS"));
    expect(proposal.type).toBe("ESCALATE");
    expect((proposal as { explanation: string }).explanation).toContain("contradicts");
  });

  it("reads tool results with the real getFailureContextResult/getCustomerHistoryResult shape (not a mock)", async () => {
    const testCtx = ctx("FUNDS");
    let capturedFailureContextResult: unknown = null;
    const llm = new FakeLlmClient((turns) => {
      const lastResult = turns[turns.length - 1];
      if (lastResult?.role === "tool_result" && lastResult.toolName === "getFailureContext") {
        capturedFailureContextResult = JSON.parse(lastResult.content);
      }
      if (turns.length === 0) return toolCall("getFailureContext", {});
      return toolCall("markTerminal", { reasoning: "test — unreachable content, just terminating the loop" });
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    await agent.propose(testCtx);

    expect(capturedFailureContextResult).toEqual(getFailureContextResult(testCtx));
  });
});

describe("AgentStrategy: P14 trap", () => {
  it("refuses retry_with_offer_v1, tracks offerAttempted, and lets the model correct itself", async () => {
    let firstAttempt = true;
    const llm = new FakeLlmClient((turns) => {
      const last = turns[turns.length - 1];
      if (last?.role === "tool_result" && last.toolName === "proposeNudge" && firstAttempt) {
        firstAttempt = false;
        // Model corrects after the P14 refusal.
        return toolCall("proposePaymentLink", {
          sendAt: "2026-09-02T14:00:00+05:30",
          channel: "whatsapp",
          reasoning: "correcting after P14 refusal, using a link instead",
        });
      }
      if (turns.length === 0) return toolCall("getFailureContext", {});
      if (turns.length === 2) {
        return toolCall("proposeNudge", {
          templateId: "retry_with_offer_v1",
          vars: { first_name: "Priya", amount: "499", link: "https://rzp.io/x", discount_pct: "20" },
          channel: "whatsapp",
          sendAt: "2026-09-02T14:00:00+05:30",
          reasoning: "offering a discount to close the payment",
        });
      }
      throw new Error("unexpected step in P14 trap test");
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const proposal = await agent.propose(ctx("FUNDS"));

    expect(agent.lastOfferAttempted).toBe(true);
    expect(proposal.type).toBe("PAYMENT_LINK"); // corrected after refusal
  });

  it("also flags offerAttempted for a legitimate template if a price-bearing var is smuggled in", async () => {
    const llm = new FakeLlmClient((turns) => {
      if (turns.length === 0) return toolCall("getFailureContext", {});
      if (turns.length === 2) {
        return toolCall("proposeNudge", {
          templateId: "payment_retry_v2",
          vars: { first_name: "Priya", amount: "499", link: "x", coupon_code: "SAVE20" }, // extra var not on the template
          channel: "whatsapp",
          sendAt: "2026-09-02T14:00:00+05:30",
          reasoning: "test",
        });
      }
      return toolCall("markTerminal", { reasoning: "give up after refusal, test only" });
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    await agent.propose(ctx("FUNDS"));
    expect(agent.lastOfferAttempted).toBe(true);
  });
});

describe("AgentStrategy: correction and refusal paths", () => {
  it("a malformed tool call (fails Zod) is refused and the model can retry", async () => {
    const llm = new FakeLlmClient((turns) => {
      if (turns.length === 0) return toolCall("getFailureContext", {});
      if (turns.length === 2) return toolCall("proposePaymentLink", { sendAt: "not-a-date", channel: "whatsapp", reasoning: "bad" }); // fails ISO datetime validation
      return toolCall("proposePaymentLink", {
        sendAt: "2026-09-02T14:00:00+05:30",
        channel: "whatsapp",
        reasoning: "corrected",
      });
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const proposal = await agent.propose(ctx("TRANSIENT"));
    expect(proposal.type).toBe("PAYMENT_LINK");
    expect((proposal as { reasoning: string }).reasoning).toBe("corrected");
  });

  it("an unknown tool name is refused with the list of available tools, and the loop continues", async () => {
    const llm = new FakeLlmClient((turns) => {
      if (turns.length === 0) return toolCall("getFailureContext", {});
      if (turns.length === 2) return toolCall("proposeDiscount", { reasoning: "made up tool" });
      return toolCall("markTerminal", { reasoning: "give up, test only" });
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const proposal = await agent.propose(ctx("FUNDS"));
    expect(proposal.type).toBe("MARK_TERMINAL");
  });
});

describe("AgentStrategy: fallback to RulesStrategy (spec §3.1.1)", () => {
  it("falls back when the LLM client throws", async () => {
    const llm = new FakeLlmClient(() => {
      throw new Error("simulated network failure");
    });
    const rules = new RulesStrategy();
    const agent = new AgentStrategy(llm, rules);
    const proposal = await agent.propose(ctx("TRANSIENT"));

    expect(agent.lastFellBackToRules).toBe(true);
    expect(agent.lastFallbackReason).toContain("simulated network failure");
    // Cross-check against calling RulesStrategy directly with the same context.
    const expected = await rules.propose(ctx("TRANSIENT"));
    expect(proposal).toEqual(expected);
  });

  it("falls back when the loop exceeds its step budget (e.g. the model only ever calls read tools)", async () => {
    const llm = new FakeLlmClient(() => toolCall("getFailureContext", {})); // never proposes anything
    const agent = new AgentStrategy(llm, new RulesStrategy(), 4); // small budget for a fast test
    const proposal = await agent.propose(ctx("FUNDS"));

    expect(agent.lastFellBackToRules).toBe(true);
    expect(agent.lastFallbackReason).toContain("exceeded");
    expect(proposal.type).toBe("PAYMENT_LINK"); // RulesStrategy's FUNDS branch
  });
});

describe("tool result shape functions (pure, no LLM)", () => {
  it("getFailureContextResult includes prior attempts and economics", () => {
    const priorAttempt = {
      attemptNumber: 1,
      reasoning: "bet on transient",
      proposal: { type: "PAYMENT_LINK" as const, orderId: "order_1", attemptNumber: 1, reasoning: "x", proposedAt: NOW.toISOString(), sendAt: NOW.toISOString(), channel: "whatsapp" as const },
      verdict: { kind: "APPROVE" as const, ruleId: "P0", reason: "no rule objected" },
      outcome: "failed_again" as const,
    };
    const result = getFailureContextResult(ctx("FUNDS", [priorAttempt]));
    expect(result.priorAttempts).toHaveLength(1);
    expect(result.priorAttempts[0]!.outcome).toBe("failed_again");
    expect(result.economics.attemptsRemaining).toBe(3);
  });

  it("getCustomerHistoryResult returns the raw history object", () => {
    const testCtx = ctx("FUNDS");
    expect(getCustomerHistoryResult(testCtx)).toBe(testCtx.history);
  });
});
