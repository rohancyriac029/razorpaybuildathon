// Spec §3.1 [v2.1]: "exactly one function in the codebase."
// Production is run(Agent, RealScheduler, RazorpayWorld, policy).
// The eval is run(*, VirtualScheduler, SimWorld, policy) for each of the five strategies.
//
// This is what forces every baseline through the same policy engine (§4.4) and
// makes the eval exercise the real executor, not just a shared clock.

import type { Scheduler } from "./ports/scheduler.js";
import type { Strategy } from "./ports/strategy.js";
import type { World } from "./ports/world.js";
import type { PolicyEngine } from "./ports/policy-engine.js";
import type {
  EpisodeContext,
  ExecResult,
  Intent,
  Proposal,
} from "./types.js";
import { idempotencyKey } from "./util/idempotency.js";
import { hashContext } from "./util/context-hash.js";

export interface EpisodeLogEntry {
  contextHash: string;
  reasoning: string;
  proposal: Proposal;
  verdict: Awaited<ReturnType<PolicyEngine["decide"]>>;
  execResult: ExecResult | null;
  outcome: "recovered" | "failed_again" | "no_response" | "pending" | "escalated" | "rejected" | null;
}

export type EpisodeLogger = (entry: EpisodeLogEntry) => Promise<void>;

/**
 * Runs one decision cycle for one episode context, through one strategy,
 * gated by one policy engine, executed against one world.
 *
 * CLASSIFY happens upstream (taxonomy, block 1) and is baked into the
 * EpisodeContext passed in. This function covers PROPOSE -> VALIDATE ->
 * GATE -> EXECUTE -> LOG (spec §3 pipeline diagram); OBSERVE is a separate
 * webhook-driven step that updates outcome after the fact.
 */
export async function run(
  strategy: Strategy,
  scheduler: Scheduler,
  world: World,
  policyEngine: PolicyEngine,
  ctx: EpisodeContext,
  log: EpisodeLogger,
): Promise<EpisodeLogEntry> {
  const contextHash = hashContext(ctx);

  // PROPOSE
  const proposal = await strategy.propose(ctx);

  // VALIDATE happens inside strategy.propose() via Zod at the LLM boundary
  // (block 6). A malformed model response never reaches here as a Proposal —
  // the Agent strategy itself falls back to Rules.propose() first (§3.1.1).

  // GATE — every strategy, no exceptions (§4.4).
  const verdict = await policyEngine.decide(proposal, {
    order: ctx.failureContext.order,
    failure: ctx.failureContext.failure,
    now: scheduler.now(),
  });

  const effectiveProposal =
    verdict.kind === "MODIFY" && verdict.modifiedProposal
      ? verdict.modifiedProposal
      : proposal;

  let execResult: ExecResult | null = null;
  let outcome: EpisodeLogEntry["outcome"] = null;

  if (verdict.kind === "REJECT") {
    outcome = "rejected";
  } else if (effectiveProposal.type === "MARK_TERMINAL") {
    outcome = null; // terminal states don't recover; nothing to observe
  } else if (effectiveProposal.type === "ESCALATE") {
    outcome = "escalated"; // §4.4: a real terminal state, not a black hole
  } else {
    // EXECUTE
    const intent: Intent = {
      id: crypto.randomUUID(),
      episodeId: crypto.randomUUID(),
      orderId: effectiveProposal.orderId,
      attemptNumber: effectiveProposal.attemptNumber,
      proposal: effectiveProposal,
      verdict,
      idempotencyKey: idempotencyKey(
        effectiveProposal.orderId,
        effectiveProposal.attemptNumber,
      ),
      status: "pending",
      createdAt: scheduler.now().toISOString(),
    };

    // P8: re-check live order status immediately pre-execution.
    const liveOrder = await world.getOrder(intent.orderId);
    if (liveOrder.status === "paid") {
      execResult = {
        intentId: intent.id,
        ok: false,
        razorpayRefId: null,
        detail: "P8 recheck: order already paid, execution skipped",
        executedAt: scheduler.now().toISOString(),
      };
      outcome = "recovered";
    } else {
      execResult = await executeByType(effectiveProposal, intent, world);
      outcome = "pending"; // OBSERVE step updates this from the outcome webhook
    }
  }

  const entry: EpisodeLogEntry = {
    contextHash,
    reasoning: effectiveProposal.reasoning,
    proposal: effectiveProposal,
    verdict,
    execResult,
    outcome,
  };

  await log(entry);
  return entry;
}

async function executeByType(
  proposal: Proposal,
  intent: Intent,
  world: World,
): Promise<ExecResult> {
  switch (proposal.type) {
    case "TOKEN_RETRY":
      return world.chargeToken(intent);
    case "PAYMENT_LINK":
      return world.createPaymentLink(intent);
    case "NUDGE":
      return world.sendNudge(intent);
    default:
      throw new Error(`executeByType: unreachable proposal type ${proposal.type}`);
  }
}
