// Spec §4. Deterministic. No LLM. Pure function of (proposal, engine state) -> verdict.
// Implementation is src/policy/engine.ts (block 2). run() depends only on this
// interface so every Strategy — including Oracle — is gated identically (§4.4).

import type { PolicyVerdict, Proposal } from "../types.js";

export interface PolicyEngine {
  decide(proposal: Proposal, at: Date): Promise<PolicyVerdict>;
  /** Records an executed intent so future decide() calls see it (P1, P5, P10 state). */
  recordExecution(proposal: Proposal, at: Date): Promise<void>;
}
