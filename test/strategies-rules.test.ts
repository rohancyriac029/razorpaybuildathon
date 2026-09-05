import { describe, it, expect } from "vitest";
import { RulesStrategy } from "../src/strategies/rules.js";
import type { DowntimeChecker } from "../src/policy/downtime-checker.js";
import type { EpisodeContext, FailureCategory, Order, FailureEvent } from "../src/types.js";

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

function ctx(category: FailureCategory, now: Date): EpisodeContext {
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
    attemptNumber: 1,
    occurredAt: now.toISOString(),
  };
  return {
    failureContext: {
      order: order(),
      failure,
      attemptNumber: 1,
      priorAttempts: [],
      economics: { attemptsRemaining: 3, contactsRemaining: 2, attemptCostPaise: 200, amountAtStakePaise: 49900 },
    },
    history: { customerId: "cust_1", isFirstTime: true, lastPayments: [], workingInstrument: null },
    now,
  };
}

const alwaysCleared: DowntimeChecker = { isCleared: () => true };
const neverCleared: DowntimeChecker = { isCleared: () => false };

describe("RulesStrategy", () => {
  it("TERMINAL -> markTerminal", async () => {
    const strategy = new RulesStrategy();
    const proposal = await strategy.propose(ctx("TERMINAL", new Date("2026-09-02T10:00:00Z")));
    expect(proposal.type).toBe("MARK_TERMINAL");
  });

  it("INSTRUMENT -> payment link at exactly +2h", async () => {
    const now = new Date("2026-09-02T10:00:00Z");
    const strategy = new RulesStrategy();
    const proposal = await strategy.propose(ctx("INSTRUMENT", now));
    expect(proposal.type).toBe("PAYMENT_LINK");
    expect(proposal.type === "PAYMENT_LINK" && proposal.sendAt).toBe(
      new Date(now.getTime() + 2 * 3_600_000).toISOString(),
    );
  });

  describe("AUTH_ABANDONED: next 10:00-20:00 IST slot", () => {
    it("sends immediately when already inside the window (15:30 IST)", async () => {
      const now = new Date("2026-09-02T10:00:00Z"); // 15:30 IST
      const strategy = new RulesStrategy();
      const proposal = await strategy.propose(ctx("AUTH_ABANDONED", now));
      expect(proposal.type).toBe("NUDGE");
      expect(proposal.type === "NUDGE" && proposal.sendAt).toBe(now.toISOString());
      expect(proposal.type === "NUDGE" && proposal.templateId).toBe("auth_incomplete_v1");
    });

    it("schedules for later TODAY's 10:00 IST when before the window (01:30 IST)", async () => {
      const now = new Date("2026-09-02T20:00:00Z"); // 01:30 IST on 2026-09-03
      const strategy = new RulesStrategy();
      const proposal = await strategy.propose(ctx("AUTH_ABANDONED", now));
      expect(proposal.type === "NUDGE" && proposal.sendAt).toBe("2026-09-03T04:30:00.000Z"); // 10:00 IST same IST-day
    });

    it("schedules for TOMORROW's 10:00 IST when after the window (21:00 IST)", async () => {
      const now = new Date("2026-09-02T15:30:00Z"); // 21:00 IST
      const strategy = new RulesStrategy();
      const proposal = await strategy.propose(ctx("AUTH_ABANDONED", now));
      expect(proposal.type === "NUDGE" && proposal.sendAt).toBe("2026-09-03T04:30:00.000Z"); // 10:00 IST next day
    });
  });

  describe("TRANSIENT: downtime-aware timing", () => {
    it("waits +90m when downtime is reported cleared", async () => {
      const now = new Date("2026-09-02T10:00:00Z");
      const strategy = new RulesStrategy(alwaysCleared);
      const proposal = await strategy.propose(ctx("TRANSIENT", now));
      expect(proposal.type === "PAYMENT_LINK" && proposal.sendAt).toBe(
        new Date(now.getTime() + 90 * 60_000).toISOString(),
      );
    });

    it("waits +6h when downtime is reported still active", async () => {
      const now = new Date("2026-09-02T10:00:00Z");
      const strategy = new RulesStrategy(neverCleared);
      const proposal = await strategy.propose(ctx("TRANSIENT", now));
      expect(proposal.type === "PAYMENT_LINK" && proposal.sendAt).toBe(
        new Date(now.getTime() + 6 * 3_600_000).toISOString(),
      );
    });

    it("defaults to the pessimistic +6h wait when no checker is supplied (fail-closed default)", async () => {
      const now = new Date("2026-09-02T10:00:00Z");
      const strategy = new RulesStrategy(); // default UnknownDowntimeChecker
      const proposal = await strategy.propose(ctx("TRANSIENT", now));
      expect(proposal.type === "PAYMENT_LINK" && proposal.sendAt).toBe(
        new Date(now.getTime() + 6 * 3_600_000).toISOString(),
      );
    });
  });

  describe("FUNDS: salary-cycle timing", () => {
    it("waits only +24h inside the day-of-month <= 7 window", async () => {
      const now = new Date("2026-09-05T10:00:00Z"); // IST day-of-month = 5
      const strategy = new RulesStrategy();
      const proposal = await strategy.propose(ctx("FUNDS", now));
      expect(proposal.type === "PAYMENT_LINK" && proposal.sendAt).toBe(
        new Date(now.getTime() + 24 * 3_600_000).toISOString(),
      );
    });

    it("waits the full +48h outside the salary-cycle window", async () => {
      const now = new Date("2026-09-15T10:00:00Z"); // IST day-of-month = 15
      const strategy = new RulesStrategy();
      const proposal = await strategy.propose(ctx("FUNDS", now));
      expect(proposal.type === "PAYMENT_LINK" && proposal.sendAt).toBe(
        new Date(now.getTime() + 48 * 3_600_000).toISOString(),
      );
    });

    it("boundary: day-of-month exactly 7 (IST) still gets the shorter +24h, snapped out of the P4 blackout", async () => {
      // 2026-09-07T18:00:00Z = 23:30 IST on 2026-09-07 -> IST day-of-month is still 7.
      // A raw +24h lands at 23:30 IST the next day, inside the 22:00-08:00 blackout
      // P4 would reject — RulesStrategy snaps it to the next 08:00 IST instead of
      // proposing a time policy is guaranteed to refuse (src/util/ist.ts's
      // snapOutOfBlackout, applied in rules.ts).
      const now = new Date("2026-09-07T18:00:00Z");
      const strategy = new RulesStrategy();
      const proposal = await strategy.propose(ctx("FUNDS", now));
      expect(proposal.type === "PAYMENT_LINK" && proposal.sendAt).toBe("2026-09-09T02:30:00.000Z"); // 08:00 IST, Sep 9
    });

    it("boundary: day-of-month exactly 8 (IST) gets the longer +48h", async () => {
      const now = new Date("2026-09-08T10:00:00Z"); // IST day-of-month = 8
      const strategy = new RulesStrategy();
      const proposal = await strategy.propose(ctx("FUNDS", now));
      expect(proposal.type === "PAYMENT_LINK" && proposal.sendAt).toBe(
        new Date(now.getTime() + 48 * 3_600_000).toISOString(),
      );
    });
  });

  it("every proposal carries the same orderId, attemptNumber, and a non-empty reasoning string", async () => {
    const now = new Date("2026-09-02T10:00:00Z");
    const strategy = new RulesStrategy();
    for (const category of ["TERMINAL", "INSTRUMENT", "AUTH_ABANDONED", "TRANSIENT", "FUNDS"] as FailureCategory[]) {
      const proposal = await strategy.propose(ctx(category, now));
      expect(proposal.orderId).toBe("order_1");
      expect(proposal.attemptNumber).toBe(1);
      expect(proposal.reasoning.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic: the same context always produces the same proposal (no hidden state, no LLM)", async () => {
    const now = new Date("2026-09-02T10:00:00Z");
    const strategy = new RulesStrategy();
    const a = await strategy.propose(ctx("FUNDS", now));
    const b = await strategy.propose(ctx("FUNDS", now));
    expect(a).toEqual(b);
  });
});
