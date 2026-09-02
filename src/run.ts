// Spec §3.1 [v2.1]: "exactly one function in the codebase."
// Production is run(Agent, RealScheduler, RazorpayWorld, policy).
// The eval is run(*, VirtualScheduler, SimWorld, policy) for each of the five strategies.
//
// This is what forces every baseline through the same policy engine (§4.4) and
// makes the eval exercise the real executor, not just a shared clock.
//
// [Split added during block 4] decide() and executeApproved() are separated
// because EXECUTE must happen at the proposal's `sendAt`, not at decision
// time — the whole eval is a claim about timing quality (does a well-timed
// FUNDS retry beat a badly-timed one?), and that claim is unmeasurable if
// execution always happens immediately regardless of what was proposed.
// VirtualScheduler.advance() (block 3) would otherwise have no caller.
// run() stays as a synchronous convenience wrapper — decide immediately,
// execute immediately — which is exactly right for the live demo (block 4:
// nobody wants to wait 2 real hours in a 5-minute demo) and for any test
// that doesn't care about scheduling. The eval runner (block 8) will call
// decide()/executeApproved() directly, gated by the scheduler.

import type { Strategy } from "./ports/strategy.js";
import type { World } from "./ports/world.js";
import type { PolicyEngine } from "./ports/policy-engine.js";
import type {
  AttemptOutcome,
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
  outcome: AttemptOutcome;
  /** Present only for execution-bound APPROVE/MODIFY verdicts; ties a later executeApproved() update back to this same episode row. */
  intentId: string | null;
}

export type EpisodeLogger = (entry: EpisodeLogEntry) => Promise<void>;

export interface DecisionResult {
  contextHash: string;
  proposal: Proposal; // effective proposal, post-MODIFY
  verdict: Awaited<ReturnType<PolicyEngine["decide"]>>;
  /** Non-null exactly when this proposal is approved AND execution-bound (TOKEN_RETRY/PAYMENT_LINK/NUDGE) — the caller should schedule executeApproved() at proposal.sendAt using this id. */
  intentId: string | null;
}

/**
 * PROPOSE -> VALIDATE -> GATE -> LOG. Does not execute anything. Every
 * strategy is gated by the same policy engine (§4.4) here, regardless of
 * whether the caller ever gets around to executing the result.
 */
export async function decide(
  strategy: Strategy,
  policyEngine: PolicyEngine,
  ctx: EpisodeContext,
  log: EpisodeLogger,
): Promise<DecisionResult> {
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
    now: ctx.now,
  });

  const effectiveProposal =
    verdict.kind === "MODIFY" && verdict.modifiedProposal
      ? verdict.modifiedProposal
      : proposal;

  let outcome: AttemptOutcome = null;
  let intentId: string | null = null;

  if (verdict.kind === "REJECT") {
    outcome = "rejected";
  } else if (effectiveProposal.type === "MARK_TERMINAL") {
    outcome = null; // terminal states don't recover; nothing to observe
  } else if (effectiveProposal.type === "ESCALATE") {
    outcome = "escalated"; // §4.4: a real terminal state, not a black hole
  } else {
    intentId = crypto.randomUUID();
    outcome = "pending"; // will be resolved by executeApproved() at proposal.sendAt
  }

  await log({
    contextHash,
    reasoning: effectiveProposal.reasoning,
    proposal: effectiveProposal,
    verdict,
    execResult: null,
    outcome,
    intentId,
  });

  return { contextHash, proposal: effectiveProposal, verdict, intentId };
}

/**
 * EXECUTE -> LOG(update). Call this at proposal.sendAt, not before — the
 * caller (production's real-time scheduler, or the eval's VirtualScheduler
 * firing at the simulated sendAt) owns that timing; this function just does
 * the P8 recheck and the real side effect once told to.
 */
export async function executeApproved(
  world: World,
  intentId: string,
  proposal: Proposal, // the effective proposal from DecisionResult; must be TOKEN_RETRY/PAYMENT_LINK/NUDGE
  log: EpisodeLogger,
  verdict: Awaited<ReturnType<PolicyEngine["decide"]>>,
  contextHash: string,
): Promise<ExecResult> {
  // The effective execution instant is the proposal's own sendAt, not real
  // wall-clock new Date(). For RealScheduler these are nearly identical
  // (setTimeout fires close to sendAt). For VirtualScheduler (the eval)
  // they are NOT — the scheduler fires at a simulated instant that can be
  // simulated days away from real "now," and SimWorld needs that simulated
  // instant, not the process's real clock, to evaluate ground truth
  // correctly.
  const executionTime = "sendAt" in proposal ? proposal.sendAt : new Date().toISOString();

  const intent: Intent = {
    id: intentId,
    episodeId: crypto.randomUUID(),
    orderId: proposal.orderId,
    attemptNumber: proposal.attemptNumber,
    proposal,
    verdict,
    idempotencyKey: idempotencyKey(proposal.orderId, proposal.attemptNumber),
    status: "pending",
    createdAt: executionTime,
  };

  // P8: re-check live order status immediately pre-execution.
  const liveOrder = await world.getOrder(intent.orderId);
  let execResult: ExecResult;
  let outcome: AttemptOutcome;
  if (liveOrder.status === "paid") {
    execResult = {
      intentId: intent.id,
      ok: false,
      razorpayRefId: null,
      detail: "P8 recheck: order already paid, execution skipped",
      executedAt: executionTime,
    };
    outcome = "recovered";
  } else {
    execResult = await executeByType(proposal, intent, world);
    outcome = "pending"; // OBSERVE step updates this from the outcome webhook
  }

  await log({
    contextHash,
    reasoning: proposal.reasoning,
    proposal,
    verdict,
    execResult,
    outcome,
    intentId,
  });

  return execResult;
}

/**
 * Convenience wrapper: decide, then immediately execute if approved and
 * execution-bound. Right for the live demo and for anything that doesn't
 * need to respect a proposal's sendAt. The eval (block 8) does NOT use
 * this — it drives decide()/executeApproved() separately through the
 * VirtualScheduler so timing quality is actually measured.
 */
export async function run(
  strategy: Strategy,
  scheduler: { now(): Date },
  world: World,
  policyEngine: PolicyEngine,
  ctx: EpisodeContext,
  log: EpisodeLogger,
): Promise<EpisodeLogEntry> {
  void scheduler; // reserved for callers that want run()'s "now" to match a virtual clock; decide() already reads ctx.now
  const decision = await decide(strategy, policyEngine, ctx, log);

  if (!decision.intentId) {
    return {
      contextHash: decision.contextHash,
      reasoning: decision.proposal.reasoning,
      proposal: decision.proposal,
      verdict: decision.verdict,
      execResult: null,
      outcome:
        decision.verdict.kind === "REJECT"
          ? "rejected"
          : decision.proposal.type === "ESCALATE"
            ? "escalated"
            : null,
      intentId: null,
    };
  }

  const execResult = await executeApproved(
    world,
    decision.intentId,
    decision.proposal,
    log,
    decision.verdict,
    decision.contextHash,
  );

  return {
    contextHash: decision.contextHash,
    reasoning: decision.proposal.reasoning,
    proposal: decision.proposal,
    verdict: decision.verdict,
    execResult,
    outcome: execResult.ok === false && execResult.detail.startsWith("P8 recheck") ? "recovered" : "pending",
    intentId: decision.intentId,
  };
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
