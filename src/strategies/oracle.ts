// Spec §5.2 point 4, §5.6 [v2.1]: the ceiling. Reads ground truth directly
// via the ScenarioRegistry — the same one SimWorld resolves outcomes
// against — and constructs the best-informed candidate proposal per
// category, trying a small number of ground-truth-snapped time offsets
// rather than brute-force searching every possible timestamp.
//
// That scoping is deliberate, not a shortcut: wouldSucceed() has an
// irreducible-random component (spec's own model — recovery is never
// literally 100% certain even with perfect timing), so an oracle that
// searched thousands of candidate minutes would eventually find a lucky
// one for nearly every scenario, collapsing "ceiling" into "RNG
// exploitation" and making the entire %-of-headroom metric meaningless.
// This oracle instead tries what a maximally-informed single good guess
// would try — the same number of candidates a well-built rules engine
// might consider — which keeps "the best achievable outcome in this
// simulator" a meaningful, non-degenerate ceiling. See spec §5.6: the
// oracle IS the generator, and is bounded by the same policy engine as
// everyone else (§4.4) — nothing here bypasses P1-P14.
import type { Strategy } from "../ports/strategy.js";
import type { EscalateProposal, EpisodeContext, MarkTerminalProposal, PaymentLinkProposal, NudgeProposal, Proposal } from "../types.js";
import type { ScenarioRegistry } from "../eval/scenario-registry.js";
import type { GeneratorConfig } from "../eval/generator-config.js";
import { wouldSucceed } from "../eval/ground-truth.js";
import { nextIstClockTime } from "../util/ist.js";

const CANDIDATE_OFFSET_HOURS = [2, 24, 48, 72];

function baseFields(ctx: EpisodeContext) {
  return {
    orderId: ctx.failureContext.order.id,
    attemptNumber: ctx.failureContext.attemptNumber,
    proposedAt: ctx.now.toISOString(),
  };
}

export class OracleStrategy implements Strategy {
  readonly name = "oracle";

  constructor(
    private readonly registry: ScenarioRegistry,
    private readonly config: GeneratorConfig,
  ) {}

  async propose(ctx: EpisodeContext): Promise<Proposal> {
    const scenario = this.registry.get(ctx.failureContext.order.id);

    if (scenario.category === "TERMINAL") {
      const proposal: MarkTerminalProposal = {
        type: "MARK_TERMINAL",
        ...baseFields(ctx),
        reasoning: "oracle: ground truth confirms TERMINAL, never recoverable",
      };
      return proposal;
    }

    const triedTypes = new Set(ctx.failureContext.priorAttempts.map((a) => a.proposal.type));
    const candidates = this.buildCandidates(ctx, scenario.liquidityHourIst, scenario.category, triedTypes);

    for (const candidate of candidates) {
      if (wouldSucceed(scenario, candidate, new Date(candidate.sendAt), this.config)) {
        return candidate;
      }
    }

    const proposal: EscalateProposal = {
      ...baseFields(ctx),
      type: "ESCALATE",
      reasoning: "oracle: no ground-truth-informed candidate would succeed for this draw",
      explanation: "Even the best-timed, best-levered attempt fails against ground truth — letting go is correct here.",
    };
    return proposal;
  }

  private buildCandidates(
    ctx: EpisodeContext,
    liquidityHourIst: number,
    category: ReturnType<ScenarioRegistry["get"]>["category"],
    triedTypes: Set<Proposal["type"]>,
  ): Array<PaymentLinkProposal | NudgeProposal> {
    const candidates: Array<PaymentLinkProposal | NudgeProposal> = [];

    if (category === "AUTH_ABANDONED" && !triedTypes.has("NUDGE")) {
      const sendAt = nextIstClockTime(ctx.now, liquidityHourIst);
      candidates.push({
        type: "NUDGE",
        ...baseFields(ctx),
        templateId: "auth_incomplete_v1",
        vars: { first_name: "there", link: "<link>" },
        channel: "whatsapp",
        sendAt: sendAt.toISOString(),
        reasoning: "oracle: nudge timed to this customer's ground-truth active hour",
      });
      return candidates;
    }

    if (triedTypes.has("PAYMENT_LINK")) return candidates; // only lever left worth trying was already spent

    for (const hoursOut of CANDIDATE_OFFSET_HOURS) {
      const target = new Date(ctx.now.getTime() + hoursOut * 3_600_000);
      const sendAt = category === "FUNDS" ? nextIstClockTime(target, liquidityHourIst) : target;
      candidates.push({
        type: "PAYMENT_LINK",
        ...baseFields(ctx),
        sendAt: sendAt.toISOString(),
        channel: "whatsapp",
        reasoning: `oracle: link at +${hoursOut}h, snapped to ground-truth timing for ${category}`,
      });
    }
    return candidates;
  }
}
