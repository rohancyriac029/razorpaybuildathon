// Spec §5.3: the floor. Never attempts recovery — escalates immediately,
// every time. Every real strategy is measured against this as the bottom
// of the range, the same way `oracle` is measured against as the top.
import type { Strategy } from "../ports/strategy.js";
import type { EpisodeContext, EscalateProposal } from "../types.js";

export class NoRetryStrategy implements Strategy {
  readonly name = "no-retry";

  async propose(ctx: EpisodeContext): Promise<EscalateProposal> {
    return {
      type: "ESCALATE",
      orderId: ctx.failureContext.order.id,
      attemptNumber: ctx.failureContext.attemptNumber,
      reasoning: "no-retry baseline: floor strategy, never attempts recovery",
      proposedAt: ctx.now.toISOString(),
      explanation: "Floor baseline — intentionally never recovers anything.",
    };
  }
}
