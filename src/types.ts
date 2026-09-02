// Shared domain vocabulary. Every port, strategy, and world implementation speaks this.

export type FailureCategory =
  | "TRANSIENT"
  | "FUNDS"
  | "AUTH_ABANDONED"
  | "INSTRUMENT"
  | "TERMINAL";

export type Channel = "link" | "whatsapp" | "sms" | "email";

export type ProposalType =
  | "TOKEN_RETRY"
  | "PAYMENT_LINK"
  | "NUDGE"
  | "MARK_TERMINAL"
  | "ESCALATE";

export interface Order {
  id: string; // internal id
  razorpayOrderId: string;
  razorpaySubscriptionId: string | null;
  customerId: string;
  amount: number; // paise
  currency: string;
  status: "created" | "attempted" | "paid" | "cancelled";
  createdAt: string; // ISO
}

export interface FailureEvent {
  id: string;
  orderId: string;
  eventId: string; // razorpay event id, for webhook dedupe
  razorpayPaymentId: string | null;
  errorCode: string | null;
  errorSource: string | null;
  errorStep: string | null;
  errorReason: string | null;
  category: FailureCategory;
  attemptNumber: number; // which attempt on this order this is
  occurredAt: string;
}

export interface CustomerHistoryEntry {
  paidAt: string;
  amount: number;
  method: string;
  hourOfDayIst: number;
}

export interface CustomerHistory {
  customerId: string;
  isFirstTime: boolean;
  lastPayments: CustomerHistoryEntry[]; // most recent first, capped at 5
  workingInstrument: string | null;
}

export interface RecoveryEconomics {
  attemptsRemaining: number; // out of P1 = 3, lifetime
  contactsRemaining: number; // out of P5 = 2, lifetime
  attemptCostPaise: number; // estimated cost of one attempt (gateway + goodwill proxy)
  amountAtStakePaise: number;
}

// Shared with EpisodeLogEntry (src/run.ts) — deliberately includes
// "escalated"/"rejected" so a prior attempt's memory can tell the agent
// "the policy engine rejected this" or "I escalated last time," which is
// exactly the kind of signal the multi-attempt reasoning chain needs
// (spec §3's example: "attempt 2: I was wrong about transient...").
export type AttemptOutcome =
  | "recovered"
  | "failed_again"
  | "no_response"
  | "pending"
  | "escalated"
  | "rejected"
  | null;

export interface PriorAttempt {
  attemptNumber: number;
  reasoning: string;
  proposal: Proposal;
  verdict: PolicyVerdict;
  outcome: AttemptOutcome;
}

export interface FailureContext {
  order: Order;
  failure: FailureEvent;
  attemptNumber: number;
  priorAttempts: PriorAttempt[];
  economics: RecoveryEconomics;
}

// --- Proposals -------------------------------------------------------------
// Every propose tool writes one of these. None of them execute anything.
// This separation is load-bearing (spec §6, Phase 5 / block 6).

interface ProposalBase {
  orderId: string;
  attemptNumber: number;
  reasoning: string;
  proposedAt: string;
}

export interface TokenRetryProposal extends ProposalBase {
  type: "TOKEN_RETRY";
  mandateTokenId: string;
  sendAt: string; // ISO
}

export interface PaymentLinkProposal extends ProposalBase {
  type: "PAYMENT_LINK";
  sendAt: string;
  channel: Channel;
}

export interface NudgeProposal extends ProposalBase {
  type: "NUDGE";
  templateId: string;
  vars: Record<string, string>;
  channel: Channel;
  sendAt: string;
}

export interface MarkTerminalProposal extends ProposalBase {
  type: "MARK_TERMINAL";
}

export interface EscalateProposal extends ProposalBase {
  type: "ESCALATE";
  explanation: string;
}

export type Proposal =
  | TokenRetryProposal
  | PaymentLinkProposal
  | NudgeProposal
  | MarkTerminalProposal
  | EscalateProposal;

// --- Policy engine -----------------------------------------------------------

export type PolicyVerdictKind = "APPROVE" | "REJECT" | "MODIFY";

export interface PolicyVerdict {
  kind: PolicyVerdictKind;
  ruleId: string; // e.g. "P3", or "P0" for approve-with-no-objection
  reason: string;
  modifiedProposal?: Proposal; // present only when kind === "MODIFY"
}

// --- Intents (post-policy, pre-execution) ------------------------------------

export interface Intent {
  id: string;
  episodeId: string;
  orderId: string;
  attemptNumber: number;
  proposal: Proposal;
  verdict: PolicyVerdict;
  idempotencyKey: string; // hash(orderId, attemptNumber) — P7
  status: "pending" | "executed" | "rejected" | "escalated";
  createdAt: string;
}

export interface ExecResult {
  intentId: string;
  ok: boolean;
  razorpayRefId: string | null; // payment_link id, payment id, etc.
  detail: string;
  executedAt: string;
}

// --- Episode context, passed to a Strategy on every invocation --------------

export interface EpisodeContext {
  failureContext: FailureContext;
  history: CustomerHistory;
  now: Date;
}
