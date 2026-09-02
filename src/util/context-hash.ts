// Spec §3.4: the policy engine's decisions are replayable from the DB.
// The context hash is what ties a logged verdict back to the exact inputs
// that produced it, without needing to re-run the LLM.
import { createHash } from "node:crypto";
import type { EpisodeContext } from "../types.js";

export function hashContext(ctx: EpisodeContext): string {
  const stable = JSON.stringify({
    order: ctx.failureContext.order,
    failure: ctx.failureContext.failure,
    priorAttempts: ctx.failureContext.priorAttempts,
    economics: ctx.failureContext.economics,
    history: ctx.history,
  });
  return createHash("sha256").update(stable).digest("hex");
}
