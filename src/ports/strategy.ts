// Spec §3.1 [v2.1]. Five implementations share this port: NoRetry, FixedInterval,
// Rules, Agent, Oracle. All five are gated by the same PolicyEngine (§4.4) —
// that is enforced by run() calling policyEngine.decide() on every proposal,
// never by the strategy itself.

import type { EpisodeContext, Proposal } from "../types.js";

export interface Strategy {
  readonly name: string;
  propose(ctx: EpisodeContext): Promise<Proposal>;
}
