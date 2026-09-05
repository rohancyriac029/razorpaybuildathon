// Spec §5.3: "The rules engine is ~150 lines... deterministic, auditable,
// free to run, never hallucinates. It captures most of the taxonomy's
// value — because the taxonomy is doing the work, not the LLM." This is
// the real competitor in the eval (non-negotiable per spec) AND the
// Agent's production fallback (spec §3.1.1: same code, dual use) when the
// LLM is down, times out, or returns something Zod rejects.
//
//   TERMINAL       -> stop (markTerminal)
//   INSTRUMENT     -> payment link, +2h, once
//   AUTH_ABANDONED -> nudge with link, next 10:00-20:00 IST slot
//   TRANSIENT      -> link at +90m if downtime cleared, else +6h
//   FUNDS          -> link at +48h; if day-of-month <= 7, +24h
//
// No LLM, no memory of prior attempts beyond what P1/P2 already enforce —
// this strategy makes the same decision every time it sees the same
// category, which is the entire point of the ablation (spec §5.2 point 3,
// §9: "where the agent loses to the rules engine, and my theory why").
import type { Strategy } from "../ports/strategy.js";
import type { DowntimeChecker } from "../policy/downtime-checker.js";
import { UnknownDowntimeChecker } from "../policy/downtime-checker.js";
import { getTemplate } from "../messaging/templates.js";
import { istDayOfMonth, istHourOfDay, nextIstClockTime, snapOutOfBlackout } from "../util/ist.js";
import type { EpisodeContext, MarkTerminalProposal, NudgeProposal, PaymentLinkProposal, Proposal } from "../types.js";

const AUTH_ABANDONED_TEMPLATE_ID = "auth_incomplete_v1";
if (!getTemplate(AUTH_ABANDONED_TEMPLATE_ID)) {
  // Fail at import time, not at first proposal, if the catalogue ever drops this id.
  throw new Error(`rules.ts: template "${AUTH_ABANDONED_TEMPLATE_ID}" is missing from the catalogue`);
}

const HOURS = 3_600_000;

function baseFields(ctx: EpisodeContext) {
  return {
    orderId: ctx.failureContext.order.id,
    attemptNumber: ctx.failureContext.attemptNumber,
    proposedAt: ctx.now.toISOString(),
  };
}

export class RulesStrategy implements Strategy {
  readonly name = "rules-engine";

  constructor(private readonly downtime: DowntimeChecker = new UnknownDowntimeChecker()) {}

  async propose(ctx: EpisodeContext): Promise<Proposal> {
    switch (ctx.failureContext.failure.category) {
      case "TERMINAL":
        return this.markTerminal(ctx);
      case "INSTRUMENT":
        return this.instrument(ctx);
      case "AUTH_ABANDONED":
        return this.authAbandoned(ctx);
      case "TRANSIENT":
        return this.transient(ctx);
      case "FUNDS":
        return this.funds(ctx);
    }
  }

  private markTerminal(ctx: EpisodeContext): MarkTerminalProposal {
    return {
      type: "MARK_TERMINAL",
      ...baseFields(ctx),
      reasoning: "TERMINAL: classification is authoritative, never retry a blocked instrument.",
    };
  }

  private instrument(ctx: EpisodeContext): PaymentLinkProposal {
    return {
      type: "PAYMENT_LINK",
      ...baseFields(ctx),
      reasoning: "INSTRUMENT: this instrument will fail identically again — link lets the customer supply a new one.",
      sendAt: snapOutOfBlackout(new Date(ctx.now.getTime() + 2 * HOURS)).toISOString(),
      channel: "whatsapp",
    };
  }

  private authAbandoned(ctx: EpisodeContext): NudgeProposal {
    const istHour = istHourOfDay(ctx.now);
    const sendAt =
      istHour >= 10 && istHour < 20 ? ctx.now : nextIstClockTime(ctx.now, 10, 0);
    return {
      type: "NUDGE",
      ...baseFields(ctx),
      reasoning: "AUTH_ABANDONED: dropped mid-flow, needs a nudge timed for waking hours, not a silent retry.",
      sendAt: sendAt.toISOString(),
      channel: "whatsapp",
      templateId: AUTH_ABANDONED_TEMPLATE_ID,
      vars: { first_name: "there", link: "<link>" },
    };
  }

  private transient(ctx: EpisodeContext): PaymentLinkProposal {
    const cleared = this.downtime.isCleared(null, ctx.now);
    const delayMs = cleared ? 90 * 60_000 : 6 * HOURS;
    return {
      type: "PAYMENT_LINK",
      ...baseFields(ctx),
      reasoning: cleared
        ? "TRANSIENT, rails reported clear: retry soon at +90m."
        : "TRANSIENT, downtime status unknown/active: fail-closed default, wait +6h rather than assume rails recovered.",
      sendAt: snapOutOfBlackout(new Date(ctx.now.getTime() + delayMs)).toISOString(),
      channel: "whatsapp",
    };
  }

  private funds(ctx: EpisodeContext): PaymentLinkProposal {
    const isSalaryWindow = istDayOfMonth(ctx.now) <= 7;
    const delayMs = (isSalaryWindow ? 24 : 48) * HOURS;
    return {
      type: "PAYMENT_LINK",
      ...baseFields(ctx),
      reasoning: isSalaryWindow
        ? "FUNDS, day-of-month <= 7 (salary-cycle window): shorter +24h wait."
        : "FUNDS, outside the salary-cycle window: default +48h wait for balance to recover.",
      sendAt: snapOutOfBlackout(new Date(ctx.now.getTime() + delayMs)).toISOString(),
      channel: "whatsapp",
    };
  }
}
