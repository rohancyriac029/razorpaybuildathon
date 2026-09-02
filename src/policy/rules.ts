// Spec §4.1: P1–P14. Deterministic, no LLM. Pure function of
// (proposal, context, snapshot, config) -> verdict. This is the file an
// interviewer will ask to see (spec §6 block 2: "Exhaustive unit tests —
// this and the taxonomy mapper are the two places where a bug charges
// someone wrongly").
//
// Evaluation order (first match wins, logged as a single rule id):
//   P13 kill switch -> P7 idempotency dupe -> P3 TERMINAL -> P1 max attempts
//   -> P2 min gap -> P11 staleness -> P4 blackout hours -> P5 max contacts
//   -> P12 live unpaid link -> P6/P14 amount integrity -> P9 value ceiling
//   -> P10 global caps -> P0 approve.
//
// MARK_TERMINAL and ESCALATE are, by the system prompt's own hard rules,
// always-safe actions ("Escalating is always safe" / markTerminal is the
// *required* response to a TERMINAL failure) — every rule below except the
// idempotency check is scoped to exclude them. See the per-rule comments for
// why each scope decision was made, not just what it does.

import type { FailureEvent, Order, PolicyVerdict, Proposal } from "../types.js";
import { idempotencyKey } from "../util/idempotency.js";
import { isIstBlackoutHour } from "../util/ist.js";
import type { PolicySnapshot } from "./snapshot.js";

export interface PolicyConfig {
  killSwitch: boolean;
  globalExecPerHour: number; // P10
  globalContactsPerDay: number; // P10
  stalenessCutoffDays: number; // P11
  valueCeilingPaise: number; // P9 — spec default ₹5,000 = 500000 paise
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  killSwitch: false,
  globalExecPerHour: 20,
  globalContactsPerDay: 50,
  stalenessCutoffDays: 7,
  valueCeilingPaise: 500_000,
};

// Proposal types that move money or contact a customer. Every P-rule except
// P7 (idempotency, which is a pure duplicate check) is scoped to these three
// — MARK_TERMINAL and ESCALATE never touch a card or a customer, so blocking
// them would just make triage impossible during an incident for no safety
// benefit (documented explicitly for P13 below, applies identically to the
// rest).
const EXECUTION_BOUND: ReadonlySet<Proposal["type"]> = new Set([
  "TOKEN_RETRY",
  "PAYMENT_LINK",
  "NUDGE",
]);
const CUSTOMER_FACING: ReadonlySet<Proposal["type"]> = new Set(["PAYMENT_LINK", "NUDGE"]);

function approve(): PolicyVerdict {
  return { kind: "APPROVE", ruleId: "P0", reason: "no rule objected" };
}

function reject(ruleId: string, reason: string): PolicyVerdict {
  return { kind: "REJECT", ruleId, reason };
}

function proposalSendAt(p: Proposal): Date | null {
  return "sendAt" in p ? new Date(p.sendAt) : null;
}

export function evaluateProposal(
  proposal: Proposal,
  ctx: { order: Order; failure: FailureEvent; now: Date },
  snapshot: PolicySnapshot,
  config: PolicyConfig,
): PolicyVerdict {
  // --- P7: idempotency — hash(orderId, attemptNumber); dupes dropped. -----
  // Checked before everything else, including the kill switch: a duplicate
  // is a duplicate regardless of system state, and re-approving it would
  // create a second Razorpay-side side effect for an attempt already made.
  const key = idempotencyKey(proposal.orderId, proposal.attemptNumber);
  if (snapshot.idempotencyKeyAlreadyExecuted) {
    return reject("P7", `duplicate: an intent with key ${key} was already executed`);
  }

  if (!EXECUTION_BOUND.has(proposal.type)) {
    // MARK_TERMINAL / ESCALATE: always safe, always approved. See module doc.
    return approve();
  }

  // --- P13: kill switch. --------------------------------------------------
  // Halts execution-bound actions only. Triage (markTerminal/escalate) keeps
  // working during an incident — that's a feature, not a gap: it's how you'd
  // discover the system is still classifying correctly while nothing is
  // spending money or messaging anyone.
  if (config.killSwitch) {
    return reject("P13", "kill switch is active — no execution-bound action may proceed");
  }

  // --- P3: TERMINAL -> automatic reject. -----------------------------------
  // The failure's own taxonomy category wins regardless of what the model
  // proposed. This is the rule the whole demo hinges on (spec §5.5, §8).
  if (ctx.failure.category === "TERMINAL") {
    return reject("P3", "failure is classified TERMINAL — never retry or contact");
  }

  // --- P1: max 3 recovery attempts per order, lifetime. --------------------
  if (snapshot.priorExecutedAttempts >= 3) {
    return reject("P1", `order already has ${snapshot.priorExecutedAttempts} executed attempts (lifetime max 3)`);
  }

  // --- P2: min 6h between attempts. ----------------------------------------
  if (snapshot.lastExecutionAt) {
    const hoursSince = (ctx.now.getTime() - snapshot.lastExecutionAt.getTime()) / 3_600_000;
    if (hoursSince < 6) {
      return reject("P2", `only ${hoursSince.toFixed(1)}h since the last attempt (min 6h)`);
    }
  }

  // --- P11: staleness cutoff. ----------------------------------------------
  const failureAgeDays =
    (ctx.now.getTime() - new Date(ctx.failure.occurredAt).getTime()) / 86_400_000;
  if (failureAgeDays > config.stalenessCutoffDays) {
    return reject(
      "P11",
      `failure is ${failureAgeDays.toFixed(1)} days old (cutoff ${config.stalenessCutoffDays}) — refusing to act on stale data`,
    );
  }

  // --- P4: no customer contact 22:00–08:00 IST. -----------------------------
  // Keys off the proposed *sendAt*, not the decision time — a customer-facing
  // action that would land inside the blackout window is rejected even if
  // it's being decided at 3pm. TOKEN_RETRY is exempt: it's silent, no
  // customer is contacted.
  if (CUSTOMER_FACING.has(proposal.type)) {
    const sendAt = proposalSendAt(proposal);
    if (sendAt && isIstBlackoutHour(sendAt)) {
      return reject("P4", `proposed sendAt ${sendAt.toISOString()} falls in the 22:00–08:00 IST blackout window`);
    }
  }

  // --- P5: max 2 customer contacts per order, all channels. ----------------
  if (CUSTOMER_FACING.has(proposal.type) && snapshot.priorContacts >= 2) {
    return reject("P5", `order already has ${snapshot.priorContacts} customer contacts (lifetime max 2)`);
  }

  // --- P12: one live unpaid link per order. ---------------------------------
  if (proposal.type === "PAYMENT_LINK" && snapshot.liveUnpaidLinkExists) {
    return reject("P12", "a live, unpaid payment link already exists for this order");
  }

  // --- P6 / P14: amount integrity. ------------------------------------------
  // proposePaymentLink and proposeTokenRetry have NO amount parameter on the
  // Proposal type (src/types.ts) — the executor reads the amount from the
  // order at execution time, never from the proposal. So this check cannot
  // be triggered through any legitimate code path today; it exists as
  // defense-in-depth against a future schema change accidentally
  // reintroducing an amount field, and is exercised in tests via an unsafe
  // cast that simulates exactly that regression (test/policy-engine.test.ts).
  const smuggledAmount = (proposal as unknown as Record<string, unknown>)["amount"];
  if (typeof smuggledAmount === "number" && smuggledAmount !== ctx.order.amount) {
    return reject(
      "P6",
      `proposal amount ${smuggledAmount} does not match order amount ${ctx.order.amount} — no partials, no rounding, no discounts (P14)`,
    );
  }

  // --- P9: value ceiling. auto below ₹5,000; at/above -> escalate. ---------
  if (ctx.order.amount >= config.valueCeilingPaise) {
    const escalated: Proposal = {
      type: "ESCALATE",
      orderId: proposal.orderId,
      attemptNumber: proposal.attemptNumber,
      reasoning: proposal.reasoning,
      proposedAt: proposal.proposedAt,
      explanation: `Order amount ${ctx.order.amount} paise is at/above the ₹${(config.valueCeilingPaise / 100).toFixed(0)} auto-execution ceiling (P9) — routed to human review instead of ${proposal.type}.`,
    };
    return {
      kind: "MODIFY",
      ruleId: "P9",
      reason: `order amount ${ctx.order.amount} paise >= ceiling ${config.valueCeilingPaise} paise — escalating instead of auto-executing`,
      modifiedProposal: escalated,
    };
  }

  // --- P10: global caps, system-wide. ---------------------------------------
  if (snapshot.globalExecutionsLastHour >= config.globalExecPerHour) {
    return reject(
      "P10",
      `system-wide executions in the last hour (${snapshot.globalExecutionsLastHour}) reached the cap (${config.globalExecPerHour}) — likely a backfill or runaway job`,
    );
  }
  if (CUSTOMER_FACING.has(proposal.type) && snapshot.globalContactsToday >= config.globalContactsPerDay) {
    return reject(
      "P10",
      `system-wide customer contacts today (${snapshot.globalContactsToday}) reached the cap (${config.globalContactsPerDay})`,
    );
  }

  return approve();
}
