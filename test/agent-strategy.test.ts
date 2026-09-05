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

    // The agent anchors on the deterministic baseline, so the tool result it
    // actually sees carries baselineRecommendation — compare against the same
    // shape the agent builds, baseline included.
    const baseline = await new RulesStrategy().propose(testCtx);
    expect(capturedFailureContextResult).toEqual(getFailureContextResult(testCtx, baseline));
  });

  it("hands the model the baseline's recommendation, and records endorse-vs-deviate", async () => {
    const testCtx = ctx("AUTH_ABANDONED"); // baseline here is NUDGE, unconditionally
    let seenBaseline: Record<string, unknown> | null = null;
    const llm = new FakeLlmClient((turns) => {
      const last = turns[turns.length - 1];
      if (last?.role === "tool_result" && last.toolName === "getFailureContext") {
        seenBaseline = JSON.parse(last.content).baselineRecommendation;
      }
      if (turns.length === 0) return toolCall("getFailureContext", {});
      // Deviate: propose a link where the baseline said nudge.
      return toolCall("proposePaymentLink", {
        sendAt: "2026-09-03T10:00:00.000Z",
        channel: "whatsapp",
        reasoning: "deviating from baseline to test the deviation counter",
      });
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const proposal = await agent.propose(testCtx);

    expect(seenBaseline).not.toBeNull();
    expect(seenBaseline!.recommendedAction).toBe("NUDGE");
    expect(seenBaseline!.templateId).toBe("auth_incomplete_v1");
    expect(seenBaseline!.timingIsYourDecision).toBe(true);
    expect(proposal.type).toBe("PAYMENT_LINK");
    expect(agent.lastBaselineAction).toBe("NUDGE");
    expect(agent.lastDeviatedFromBaseline).toBe(true);
  });

  it("records an endorsement when the model proposes the baseline's own action", async () => {
    const testCtx = ctx("AUTH_ABANDONED");
    // Derive the baseline's own sendAt rather than hardcoding one — a guessed
    // timestamp is a "retimed", not an "endorsed", and the point of this test
    // is the exact-match path.
    const baseline = await new RulesStrategy().propose(testCtx);
    const baselineSendAt = (baseline as { sendAt: string }).sendAt;
    const llm = new FakeLlmClient((turns) => {
      if (turns.length === 0) return toolCall("getFailureContext", {});
      return toolCall("proposeNudge", {
        templateId: "auth_incomplete_v1",
        vars: { first_name: "there", link: "<link>" },
        channel: "whatsapp",
        sendAt: baselineSendAt,
        reasoning: "endorsing baseline: dropped mid-flow, a nudge is the right lever",
      });
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const proposal = await agent.propose(testCtx);

    expect(proposal.type).toBe("NUDGE");
    expect(agent.lastDeviatedFromBaseline).toBe(false);
    expect(agent.lastAnchorRelation).toBe("endorsed");
  });

  it("distinguishes 'retimed' from 'endorsed' — same lever, moved clock", async () => {
    // The distinction a type-only comparison misses, and the reason the first
    // anchored pilot reported 113/113 agreement while recovery collapsed.
    const testCtx = ctx("AUTH_ABANDONED");
    const llm = new FakeLlmClient((turns) => {
      if (turns.length === 0) return toolCall("getFailureContext", {});
      return toolCall("proposeNudge", {
        templateId: "auth_incomplete_v1",
        vars: { first_name: "there", link: "<link>" },
        channel: "whatsapp",
        sendAt: "2026-09-05T18:00:00+05:30", // same lever, deliberately different instant
        reasoning: "agreeing on the nudge but moving it later",
      });
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    const proposal = await agent.propose(testCtx);

    expect(proposal.type).toBe("NUDGE");
    expect(agent.lastAnchorRelation).toBe("retimed");
    expect(agent.lastDeviatedFromBaseline).toBe(false); // not a lever change
  });

  it("treats an equivalent instant in another timezone form as an endorsement", async () => {
    const testCtx = ctx("AUTH_ABANDONED");
    const baseline = await new RulesStrategy().propose(testCtx);
    const baselineSendAt = (baseline as { sendAt: string }).sendAt;
    // Same moment, written with a +05:30 offset instead of a Z suffix.
    const equivalent = new Date(baselineSendAt).toISOString().replace("Z", "+00:00");

    const llm = new FakeLlmClient((turns) => {
      if (turns.length === 0) return toolCall("getFailureContext", {});
      return toolCall("proposeNudge", {
        templateId: "auth_incomplete_v1",
        vars: { first_name: "there", link: "<link>" },
        channel: "whatsapp",
        sendAt: equivalent,
        reasoning: "endorsing baseline, different string form, same instant",
      });
    });
    const agent = new AgentStrategy(llm, new RulesStrategy());
    await agent.propose(testCtx);

    expect(agent.lastAnchorRelation).toBe("endorsed");
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

  it("getCustomerHistoryResult returns the history fields but strips customerId (an internal id with no decision-relevant content — see tools.ts's doc)", () => {
    const testCtx = ctx("FUNDS");
    const result = getCustomerHistoryResult(testCtx);
    expect(result).toEqual({
      isFirstTime: testCtx.history.isFirstTime,
      lastPayments: testCtx.history.lastPayments,
      workingInstrument: testCtx.history.workingInstrument,
    });
    expect(result).not.toHaveProperty("customerId");
  });
});
