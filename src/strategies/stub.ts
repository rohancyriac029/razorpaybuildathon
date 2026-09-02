// Spec §6 block 3: "end-to-end spine with a stub strategy." Not one of the
// five real baselines (NoRetry/FixedInterval/Rules/Agent/Oracle — blocks
// 5-7) — this exists only to prove the Strategy port and run() wire
// together correctly before any of those are built. Always proposes the
// same thing: a payment link two hours out.
import type { Strategy } from "../ports/strategy.js";
import type { EpisodeContext, PaymentLinkProposal } from "../types.js";

export class StubStrategy implements Strategy {
  readonly name = "stub";

  async propose(ctx: EpisodeContext): Promise<PaymentLinkProposal> {
    const sendAt = new Date(ctx.now.getTime() + 2 * 3_600_000);
    return {
      type: "PAYMENT_LINK",
      orderId: ctx.failureContext.order.id,
      attemptNumber: ctx.failureContext.attemptNumber,
      reasoning: "stub strategy: always proposes a payment link at +2h, for spine testing only",
      proposedAt: ctx.now.toISOString(),
      sendAt: sendAt.toISOString(),
      channel: "whatsapp",
    };
  }
}
