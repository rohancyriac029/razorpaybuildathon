// Spec §4. Deterministic. No LLM. Pure function of (proposal, context, engine
// state) -> verdict. Implementation is src/policy/engine.ts (block 2). run()
// depends only on this interface so every Strategy — including Oracle — is
// gated identically (§4.4).
//
// No separate recordExecution(): decide() derives all P1/P2/P5/P9/P10/P11/P12
// state by querying the `episodes` table directly (the same table run()'s
// logger already writes to after each attempt). One source of truth for
// "what happened," not a second in-memory counter that could drift from the
// audit log.

import type { FailureEvent, Order, PolicyVerdict, Proposal } from "../types.js";

export interface PolicyContext {
  order: Order;
  // .category drives P3, .occurredAt drives P11. Nullable since v3
  // (salvage-v3-agentic-commerce-spec.md §4, Change 1): a PURCHASE proposal
  // has no failure. P3/P11 in rules.ts guard for null; every other rule is
  // untouched.
  failure: FailureEvent | null;
  now: Date;
}

export interface PolicyEngine {
  decide(proposal: Proposal, ctx: PolicyContext): Promise<PolicyVerdict>;
}
