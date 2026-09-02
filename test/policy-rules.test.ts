import { describe, it, expect } from "vitest";
import { evaluateProposal, DEFAULT_POLICY_CONFIG, type PolicyConfig } from "../src/policy/rules.js";
import type { PolicySnapshot } from "../src/policy/snapshot.js";
import type {
  FailureEvent,
  MarkTerminalProposal,
  NudgeProposal,
  Order,
  PaymentLinkProposal,
  Proposal,
  TokenRetryProposal,
  EscalateProposal,
} from "../src/types.js";

// --- Fixtures ---------------------------------------------------------------
// now = 2026-09-02T10:00:00Z = 15:30 IST — safe daytime hour, not blackout.
const NOW = new Date("2026-09-02T10:00:00Z");
// 2026-09-02T18:35:00Z = 00:05 IST — inside the 22:00-08:00 blackout window.
const BLACKOUT_SEND_AT = "2026-09-02T18:35:00Z";
const DAYTIME_SEND_AT = "2026-09-02T10:00:00Z";

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "order_1",
    razorpayOrderId: "order_rzp_1",
    razorpaySubscriptionId: null,
    customerId: "cust_1",
    amount: 49900, // ₹499, well under the ₹5,000 ceiling
    currency: "INR",
    status: "attempted",
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function failure(overrides: Partial<FailureEvent> = {}): FailureEvent {
  return {
    id: "fail_1",
    orderId: "order_1",
    eventId: "evt_1",
    razorpayPaymentId: "pay_1",
    errorCode: "BAD_REQUEST_ERROR",
    errorSource: "customer",
    errorStep: "payment_authorization",
    errorReason: "insufficient_funds",
    category: "TRANSIENT",
    attemptNumber: 1,
    occurredAt: NOW.toISOString(),
    ...overrides,
  };
}

function emptySnapshot(overrides: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    priorExecutedAttempts: 0,
    lastExecutionAt: null,
    priorContacts: 0,
    liveUnpaidLinkExists: false,
    globalExecutionsLastHour: 0,
    globalContactsToday: 0,
    idempotencyKeyAlreadyExecuted: false,
    ...overrides,
  };
}

function paymentLink(overrides: Partial<PaymentLinkProposal> = {}): PaymentLinkProposal {
  return {
    type: "PAYMENT_LINK",
    orderId: "order_1",
    attemptNumber: 1,
    reasoning: "test reasoning",
    proposedAt: NOW.toISOString(),
    sendAt: DAYTIME_SEND_AT,
    channel: "whatsapp",
    ...overrides,
  };
}

function nudge(overrides: Partial<NudgeProposal> = {}): NudgeProposal {
  return {
    type: "NUDGE",
    orderId: "order_1",
    attemptNumber: 1,
    reasoning: "test reasoning",
    proposedAt: NOW.toISOString(),
    sendAt: DAYTIME_SEND_AT,
    channel: "whatsapp",
    templateId: "payment_retry_v2",
    vars: { first_name: "Priya", amount: "499", link: "https://rzp.io/l/abc" },
    ...overrides,
  };
}

function tokenRetry(overrides: Partial<TokenRetryProposal> = {}): TokenRetryProposal {
  return {
    type: "TOKEN_RETRY",
    orderId: "order_1",
    attemptNumber: 1,
    reasoning: "test reasoning",
    proposedAt: NOW.toISOString(),
    sendAt: DAYTIME_SEND_AT,
    mandateTokenId: "token_1",
    ...overrides,
  };
}

function markTerminal(overrides: Partial<MarkTerminalProposal> = {}): MarkTerminalProposal {
  return {
    type: "MARK_TERMINAL",
    orderId: "order_1",
    attemptNumber: 1,
    reasoning: "test reasoning",
    proposedAt: NOW.toISOString(),
    ...overrides,
  };
}

function escalate(overrides: Partial<EscalateProposal> = {}): EscalateProposal {
  return {
    type: "ESCALATE",
    orderId: "order_1",
    attemptNumber: 1,
    reasoning: "test reasoning",
    proposedAt: NOW.toISOString(),
    explanation: "unsure, escalating",
    ...overrides,
  };
}

function decide(
  proposal: Proposal,
  opts: { order?: Order; failure?: FailureEvent; now?: Date; snapshot?: PolicySnapshot; config?: PolicyConfig } = {},
) {
  return evaluateProposal(
    proposal,
    { order: opts.order ?? order(), failure: opts.failure ?? failure(), now: opts.now ?? NOW },
    opts.snapshot ?? emptySnapshot(),
    opts.config ?? DEFAULT_POLICY_CONFIG,
  );
}

// --- P0: default approve -----------------------------------------------------
describe("P0: default approve", () => {
  it("approves a clean payment link proposal with no rule objecting", () => {
    const v = decide(paymentLink());
    expect(v.kind).toBe("APPROVE");
    expect(v.ruleId).toBe("P0");
  });
});

// --- MARK_TERMINAL / ESCALATE always safe -----------------------------------
describe("MARK_TERMINAL and ESCALATE: always approved", () => {
  it("approves markTerminal even under kill switch", () => {
    const v = decide(markTerminal(), { config: { ...DEFAULT_POLICY_CONFIG, killSwitch: true } });
    expect(v.kind).toBe("APPROVE");
  });

  it("approves markTerminal even with max attempts already spent", () => {
    const v = decide(markTerminal(), { snapshot: emptySnapshot({ priorExecutedAttempts: 3 }) });
    expect(v.kind).toBe("APPROVE");
  });

  it("approves escalate even under kill switch", () => {
    const v = decide(escalate(), { config: { ...DEFAULT_POLICY_CONFIG, killSwitch: true } });
    expect(v.kind).toBe("APPROVE");
  });

  it("approves escalate on a TERMINAL failure (escalating is always safe)", () => {
    const v = decide(escalate(), { failure: failure({ category: "TERMINAL" }) });
    expect(v.kind).toBe("APPROVE");
  });

  it("approves markTerminal on a TERMINAL failure (it's the correct action)", () => {
    const v = decide(markTerminal(), { failure: failure({ category: "TERMINAL" }) });
    expect(v.kind).toBe("APPROVE");
  });
});

// --- P7: idempotency ----------------------------------------------------------
describe("P7: idempotency dupe", () => {
  it("rejects when the idempotency key was already executed", () => {
    const v = decide(paymentLink(), { snapshot: emptySnapshot({ idempotencyKeyAlreadyExecuted: true }) });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P7");
  });

  it("P7 outranks P13 (checked first, fires even if kill switch is also active)", () => {
    const v = decide(paymentLink(), {
      snapshot: emptySnapshot({ idempotencyKeyAlreadyExecuted: true }),
      config: { ...DEFAULT_POLICY_CONFIG, killSwitch: true },
    });
    expect(v.ruleId).toBe("P7");
  });
});

// --- P13: kill switch ---------------------------------------------------------
describe("P13: kill switch", () => {
  it("rejects an execution-bound proposal when active", () => {
    const v = decide(paymentLink(), { config: { ...DEFAULT_POLICY_CONFIG, killSwitch: true } });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P13");
  });

  it("rejects a token retry when active", () => {
    const v = decide(tokenRetry(), { config: { ...DEFAULT_POLICY_CONFIG, killSwitch: true } });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P13");
  });
});

// --- P3: TERMINAL --------------------------------------------------------------
describe("P3: TERMINAL failure -> automatic reject", () => {
  it("rejects a payment link on a TERMINAL failure", () => {
    const v = decide(paymentLink(), { failure: failure({ category: "TERMINAL" }) });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P3");
  });

  it("rejects a nudge on a TERMINAL failure", () => {
    const v = decide(nudge(), { failure: failure({ category: "TERMINAL" }) });
    expect(v.ruleId).toBe("P3");
  });

  it("rejects a token retry on a TERMINAL failure", () => {
    const v = decide(tokenRetry(), { failure: failure({ category: "TERMINAL" }) });
    expect(v.ruleId).toBe("P3");
  });

  it("P3 outranks P1 (checked first even when max attempts is also exceeded)", () => {
    const v = decide(paymentLink(), {
      failure: failure({ category: "TERMINAL" }),
      snapshot: emptySnapshot({ priorExecutedAttempts: 3 }),
    });
    expect(v.ruleId).toBe("P3");
  });
});

// --- P1: max 3 attempts lifetime -----------------------------------------------
describe("P1: max attempts", () => {
  it("rejects the 4th attempt", () => {
    const v = decide(paymentLink(), { snapshot: emptySnapshot({ priorExecutedAttempts: 3 }) });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P1");
  });

  it("approves the 3rd attempt (2 prior executed)", () => {
    const v = decide(paymentLink(), { snapshot: emptySnapshot({ priorExecutedAttempts: 2 }) });
    expect(v.kind).toBe("APPROVE");
  });
});

// --- P2: min 6h gap --------------------------------------------------------------
describe("P2: min 6h between attempts", () => {
  it("rejects when the last attempt was 3h ago", () => {
    const v = decide(paymentLink(), {
      snapshot: emptySnapshot({ lastExecutionAt: new Date(NOW.getTime() - 3 * 3_600_000) }),
    });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P2");
  });

  it("approves when the last attempt was 7h ago", () => {
    const v = decide(paymentLink(), {
      snapshot: emptySnapshot({ lastExecutionAt: new Date(NOW.getTime() - 7 * 3_600_000) }),
    });
    expect(v.kind).toBe("APPROVE");
  });

  it("P1 outranks P2 (checked first when both conditions hold)", () => {
    const v = decide(paymentLink(), {
      snapshot: emptySnapshot({
        priorExecutedAttempts: 3,
        lastExecutionAt: new Date(NOW.getTime() - 3 * 3_600_000),
      }),
    });
    expect(v.ruleId).toBe("P1");
  });
});

// --- P11: staleness cutoff ---------------------------------------------------
describe("P11: staleness cutoff", () => {
  it("rejects a failure older than the cutoff (default 7 days)", () => {
    const v = decide(paymentLink(), {
      failure: failure({ occurredAt: new Date(NOW.getTime() - 8 * 86_400_000).toISOString() }),
    });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P11");
  });

  it("approves a failure within the cutoff", () => {
    const v = decide(paymentLink(), {
      failure: failure({ occurredAt: new Date(NOW.getTime() - 6 * 86_400_000).toISOString() }),
    });
    expect(v.kind).toBe("APPROVE");
  });
});

// --- P4: blackout hours -------------------------------------------------------
describe("P4: no customer contact 22:00-08:00 IST", () => {
  it("rejects a payment link whose sendAt falls in the blackout window", () => {
    const v = decide(paymentLink({ sendAt: BLACKOUT_SEND_AT }));
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P4");
  });

  it("rejects a nudge whose sendAt falls in the blackout window", () => {
    const v = decide(nudge({ sendAt: BLACKOUT_SEND_AT }));
    expect(v.ruleId).toBe("P4");
  });

  it("does NOT reject a token retry in the same window (silent, not customer-facing)", () => {
    const v = decide(tokenRetry({ sendAt: BLACKOUT_SEND_AT }));
    expect(v.kind).toBe("APPROVE");
  });

  it("approves a payment link scheduled in daytime", () => {
    const v = decide(paymentLink({ sendAt: DAYTIME_SEND_AT }));
    expect(v.kind).toBe("APPROVE");
  });
});

// --- P5: max 2 contacts lifetime -----------------------------------------------
describe("P5: max contacts", () => {
  it("rejects the 3rd customer contact", () => {
    const v = decide(nudge(), { snapshot: emptySnapshot({ priorContacts: 2 }) });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P5");
  });

  it("does NOT reject a token retry regardless of contact count (not customer-facing)", () => {
    const v = decide(tokenRetry(), { snapshot: emptySnapshot({ priorContacts: 2 }) });
    expect(v.kind).toBe("APPROVE");
  });

  it("approves the 2nd contact (1 prior)", () => {
    const v = decide(nudge(), { snapshot: emptySnapshot({ priorContacts: 1 }) });
    expect(v.kind).toBe("APPROVE");
  });
});

// --- P12: one live unpaid link per order ---------------------------------------
describe("P12: one live unpaid link per order", () => {
  it("rejects a second payment link while one is live and unpaid", () => {
    const v = decide(paymentLink(), { snapshot: emptySnapshot({ liveUnpaidLinkExists: true }) });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P12");
  });

  it("does NOT reject a nudge even if a live link exists (P12 scoped to links)", () => {
    const v = decide(nudge(), { snapshot: emptySnapshot({ liveUnpaidLinkExists: true }) });
    expect(v.kind).toBe("APPROVE");
  });
});

// --- P6 / P14: amount integrity (defense-in-depth) ------------------------------
describe("P6/P14: amount integrity", () => {
  it("rejects if a smuggled amount field disagrees with the order amount", () => {
    const proposalWithAmount = { ...paymentLink(), amount: 99999 } as unknown as Proposal;
    const v = decide(proposalWithAmount, { order: order({ amount: 49900 }) });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P6");
  });

  it("does not reject if a smuggled amount field agrees with the order amount", () => {
    const proposalWithAmount = { ...paymentLink(), amount: 49900 } as unknown as Proposal;
    const v = decide(proposalWithAmount, { order: order({ amount: 49900 }) });
    expect(v.kind).toBe("APPROVE");
  });

  it("legitimate Proposal types have no amount field to violate (compile-time proof)", () => {
    const p = paymentLink();
    // @ts-expect-error -- Proposal types intentionally carry no amount field (spec §4.1.1 / P14).
    const attemptedAmount = p.amount;
    expect(attemptedAmount).toBeUndefined();
  });
});

// --- P9: value ceiling -----------------------------------------------------------
describe("P9: value ceiling", () => {
  it("MODIFIES into an escalation at exactly the ceiling", () => {
    const v = decide(paymentLink(), { order: order({ amount: DEFAULT_POLICY_CONFIG.valueCeilingPaise }) });
    expect(v.kind).toBe("MODIFY");
    expect(v.ruleId).toBe("P9");
    expect(v.modifiedProposal?.type).toBe("ESCALATE");
  });

  it("MODIFIES into an escalation above the ceiling", () => {
    const v = decide(paymentLink(), {
      order: order({ amount: DEFAULT_POLICY_CONFIG.valueCeilingPaise + 1 }),
    });
    expect(v.kind).toBe("MODIFY");
    expect(v.ruleId).toBe("P9");
  });

  it("approves normally just below the ceiling", () => {
    const v = decide(paymentLink(), {
      order: order({ amount: DEFAULT_POLICY_CONFIG.valueCeilingPaise - 1 }),
    });
    expect(v.kind).toBe("APPROVE");
  });

  it("the modified proposal preserves orderId and attemptNumber for audit continuity", () => {
    const v = decide(paymentLink({ orderId: "order_xyz", attemptNumber: 2 }), {
      order: order({ id: "order_xyz", amount: 999_999_999 }),
    });
    expect(v.modifiedProposal?.orderId).toBe("order_xyz");
    expect(v.modifiedProposal?.attemptNumber).toBe(2);
  });
});

// --- P10: global caps ---------------------------------------------------------
describe("P10: global caps", () => {
  it("rejects when system-wide executions/hour is at the cap", () => {
    const v = decide(paymentLink(), {
      snapshot: emptySnapshot({ globalExecutionsLastHour: DEFAULT_POLICY_CONFIG.globalExecPerHour }),
    });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P10");
  });

  it("approves when just below the executions/hour cap", () => {
    const v = decide(paymentLink(), {
      snapshot: emptySnapshot({ globalExecutionsLastHour: DEFAULT_POLICY_CONFIG.globalExecPerHour - 1 }),
    });
    expect(v.kind).toBe("APPROVE");
  });

  it("rejects a customer-facing proposal when contacts/day is at the cap", () => {
    const v = decide(nudge(), {
      snapshot: emptySnapshot({ globalContactsToday: DEFAULT_POLICY_CONFIG.globalContactsPerDay }),
    });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P10");
  });

  it("does NOT reject a token retry on the contacts/day cap (not customer-facing)", () => {
    const v = decide(tokenRetry(), {
      snapshot: emptySnapshot({ globalContactsToday: DEFAULT_POLICY_CONFIG.globalContactsPerDay }),
    });
    expect(v.kind).toBe("APPROVE");
  });

  it("this is the backfill-script kill-switch scenario (spec §4.2): every order is on attempt 1, only the global cap catches it", () => {
    // Simulates re-running the backfill twice: 1000 orders, all attempt #1,
    // no per-order rule (P1/P2/P5) has anything to say. Only P10 stops it.
    const v = decide(paymentLink({ orderId: "order_from_backfill_row_501" }), {
      snapshot: emptySnapshot({ priorExecutedAttempts: 0, globalExecutionsLastHour: 20 }),
    });
    expect(v.kind).toBe("REJECT");
    expect(v.ruleId).toBe("P10");
  });
});
