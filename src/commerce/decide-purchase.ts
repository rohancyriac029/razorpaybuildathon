// v3 agentic-commerce surface (spec §4, Change 2). The parallel gate entry
// point to src/run.ts's decide() — NOT a reuse of it, because Strategy /
// EpisodeContext / FailureContext all require a non-null FailureEvent, and
// a purchase has no failure (see the comment on BuyerContext in types.ts).
//
// What IS reused, byte-for-byte, under its existing 42 tests: the policy
// engine itself, via the same PolicyEngine port every recovery strategy is
// gated by. Only this ~30-line orchestration shell is new — mirrors
// decide() in src/run.ts almost line for line.
import { randomUUID, createHash } from "node:crypto";
import type { PolicyEngine } from "../ports/policy-engine.js";
import type { EpisodeLogger } from "../run.js";
import type { AttemptOutcome, BuyerContext, Proposal } from "../types.js";

export interface BuyerAgentLike {
  propose(ctx: BuyerContext): Promise<Proposal>;
}

export interface PurchaseDecisionResult {
  contextHash: string;
  proposal: Proposal; // effective proposal, post-MODIFY
  verdict: Awaited<ReturnType<PolicyEngine["decide"]>>;
  intentId: string | null;
}

function hashBuyerContext(ctx: BuyerContext): string {
  const stable = JSON.stringify({
    order: ctx.order,
    mandate: ctx.mandate,
    spentSoFarPaise: ctx.spentSoFarPaise,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * PROPOSE -> GATE -> LOG for a purchase. Mirrors src/run.ts's decide():
 * the mandate's per-order ceiling is enforced by constructing the
 * PolicyEngine's config with valueCeilingPaise = mandate.maxPerOrderPaise
 * (spec §4 "Mandate enforcement") — the caller does this before passing
 * policyEngine in; NOT done here, so this function has no new safety logic
 * of its own, exactly as intended.
 */
export async function decidePurchase(
  agent: BuyerAgentLike,
  policyEngine: PolicyEngine,
  ctx: BuyerContext,
  log: EpisodeLogger,
): Promise<PurchaseDecisionResult> {
  const contextHash = hashBuyerContext(ctx);

  // PROPOSE
  const proposal = await agent.propose(ctx);

  // GATE — same port, same engine, same 14 rules. failure: null is the one
  // and only accommodation a purchase needs from the engine (spec §4).
  const verdict = await policyEngine.decide(proposal, {
    order: ctx.order,
    failure: null,
    now: ctx.now,
  });

  const effectiveProposal =
    verdict.kind === "MODIFY" && verdict.modifiedProposal ? verdict.modifiedProposal : proposal;

  let outcome: AttemptOutcome = null;
  let intentId: string | null = null;

  if (verdict.kind === "REJECT") {
    outcome = "rejected";
  } else if (effectiveProposal.type === "ESCALATE") {
    outcome = "escalated";
  } else if (effectiveProposal.type === "MARK_TERMINAL") {
    outcome = null; // unreachable for a buyer in practice, kept for type completeness
  } else {
    intentId = randomUUID();
    outcome = "pending"; // resolved by executePurchase()
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
