// Regression test for the bug that broke the first baseline-anchoring pilot:
// the baseline's sendAt was shown to the model as a UTC `Z` string while the
// propose tools ask for an offset-form datetime. The model copied the digits
// and re-tagged them +05:30, shifting every proposal 5.5h earlier and putting
// 98 of 113 attempts inside the P4 blackout window.
import { describe, it, expect } from "vitest";
import { toIstOffsetString, istHourOfDay, isIstBlackoutHour, snapOutOfBlackout } from "../src/util/ist.js";
import { baselineSummary, buildProposalFromToolCall } from "../src/agent/tools.js";
import type { EpisodeContext, PaymentLinkProposal } from "../src/types.js";

describe("toIstOffsetString", () => {
  it("renders the same instant as IST wall clock with a +05:30 offset", () => {
    // 02:30 UTC is 08:00 IST.
    expect(toIstOffsetString(new Date("2026-08-30T02:30:00.000Z"))).toBe("2026-08-30T08:00:00+05:30");
  });

  it("round-trips: parsing the offset string yields the original instant", () => {
    const original = new Date("2026-09-01T04:30:00.000Z");
    expect(new Date(toIstOffsetString(original)).getTime()).toBe(original.getTime());
  });

  it("rolls the IST calendar date forward past UTC midnight", () => {
    // 20:00 UTC on Sep 2 is 01:30 IST on Sep 3.
    expect(toIstOffsetString(new Date("2026-09-02T20:00:00.000Z"))).toBe("2026-09-03T01:30:00+05:30");
  });
});

describe("baselineSummary sendAt formatting", () => {
  function linkAt(iso: string): PaymentLinkProposal {
    return {
      type: "PAYMENT_LINK",
      orderId: "o1",
      attemptNumber: 1,
      proposedAt: "2026-08-30T00:00:00.000Z",
      reasoning: "test",
      sendAt: iso,
      channel: "whatsapp",
    };
  }

  it("hands the model an offset-form time, never a UTC Z string", () => {
    const summary = baselineSummary(linkAt("2026-08-30T02:30:00.000Z"));
    expect(summary.fallbackSendAt).toBe("2026-08-30T08:00:00+05:30");
    expect(String(summary.fallbackSendAt)).not.toContain("Z");
    expect(summary.fallbackSendAtIstHour).toBe(8);
  });

  it("names the lever as the anchor and the timing as only a fallback", () => {
    // Selective anchoring: the field names carry the contract, so the model
    // cannot mistake an advisory timestamp for a mandated one.
    const summary = baselineSummary(linkAt("2026-08-30T02:30:00.000Z"));
    expect(summary.recommendedAction).toBe("PAYMENT_LINK");
    expect(summary.timingIsYourDecision).toBe(true);
    expect(summary).not.toHaveProperty("sendAt");
  });

  it("a baseline time copied verbatim by the model survives P4", () => {
    // The exact failure mode: baseline snapped out of blackout, model copies it.
    const snapped = snapOutOfBlackout(new Date("2026-08-30T07:30:00+05:30"));
    const summary = baselineSummary(linkAt(snapped.toISOString()));
    const asModelWouldEmitIt = new Date(String(summary.fallbackSendAt));
    expect(isIstBlackoutHour(asModelWouldEmitIt)).toBe(false);
    expect(istHourOfDay(asModelWouldEmitIt)).toBe(8);
  });

  it("refuses a blackout sendAt in-loop instead of letting it burn an attempt on P4", () => {
    // Selective anchoring hands timing back to the model, so it needs to see
    // the constraint rather than discover it by wasting one of three attempts.
    const ctx = {
      failureContext: {
        order: { id: "o1", amount: 49900 },
        attemptNumber: 1,
      },
      now: new Date("2026-09-02T10:00:00Z"),
    } as unknown as EpisodeContext;

    const bad = buildProposalFromToolCall(
      "proposePaymentLink",
      { sendAt: "2026-09-03T02:30:00+05:30", channel: "whatsapp", reasoning: "02:30 IST, inside blackout" },
      ctx,
    );
    expect(bad.proposal).toBeNull();
    expect(bad.refusalMessage).toContain("blackout");
    expect(bad.refusalMessage).toContain("08:00 and 21:59 IST");

    const good = buildProposalFromToolCall(
      "proposePaymentLink",
      { sendAt: "2026-09-03T19:00:00+05:30", channel: "whatsapp", reasoning: "19:00 IST, allowed" },
      ctx,
    );
    expect(good.proposal).not.toBeNull();
    expect(good.refusalMessage).toBeNull();
  });

  it("the old UTC-string behaviour would have produced a blackout time when re-tagged", () => {
    // Documents why this matters: taking the digits out of the UTC form and
    // labelling them +05:30 is what the model actually did.
    const utc = "2026-08-30T02:30:00.000Z";
    const naivelyRetagged = new Date(utc.replace(".000Z", "+05:30"));
    expect(isIstBlackoutHour(naivelyRetagged)).toBe(true); // 02:30 IST
    // The corrected form is immune, because the digits already read 08:00.
    const corrected = new Date(toIstOffsetString(new Date(utc)));
    expect(isIstBlackoutHour(corrected)).toBe(false);
  });
});
