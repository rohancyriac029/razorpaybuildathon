// Spec §5.3: "fixed-24h × 3 — the industry default you're beating." Blindly
// proposes a payment link at +24h regardless of category — including
// TERMINAL. That's deliberate: this is "the cron," and part of the point
// is watching the real policy engine catch ITS mistakes too (P3), not just
// the LLM's. The "×3" isn't hardcoded here — it falls out naturally from
// being re-invoked on each subsequent failure, same as every strategy,
// bounded by P1/P2 like everyone else.
import type { Strategy } from "../ports/strategy.js";
import type { EpisodeContext, PaymentLinkProposal } from "../types.js";

const TWENTY_FOUR_HOURS_MS = 24 * 3_600_000;

export class FixedIntervalStrategy implements Strategy {
  readonly name = "fixed-24h";

  async propose(ctx: EpisodeContext): Promise<PaymentLinkProposal> {
    return {
      type: "PAYMENT_LINK",
      orderId: ctx.failureContext.order.id,
      attemptNumber: ctx.failureContext.attemptNumber,
      reasoning: "fixed-24h baseline: always retries at +24h, no category or timing awareness",
      proposedAt: ctx.now.toISOString(),
      sendAt: new Date(ctx.now.getTime() + TWENTY_FOUR_HOURS_MS).toISOString(),
      channel: "whatsapp",
    };
  }
}
