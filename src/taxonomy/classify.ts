// Spec §6 block 1: normalise every Razorpay payment failure into one of five
// buckets. Source of truth for `error_reason` values: razorpay.com/docs/errors/
// (fetched 2026-09-02; Razorpay does not publish a stable enum of error_source
// or error_step across payment methods, so classification keys on error_reason,
// which is the one field with a documented, near-complete value list).
//
// "Any unmapped code -> TERMINAL. Fail closed, never fail open." (spec §6)
//
// One comment per entry below explains the judgment call. Reviewers will read
// this file — it is the single place domain knowledge about Razorpay failure
// semantics lives.

import type { FailureCategory } from "../types.js";

interface TaxonomyEntry {
  category: FailureCategory;
  note: string;
}

// --- TRANSIENT ---------------------------------------------------------
// Instrument fine, rails failed. Same-instrument retry recovers without the
// customer doing anything differently. No customer contact — they did
// nothing wrong (spec §7 system prompt).
const TRANSIENT: Record<string, string> = {
  gateway_technical_error: "Technical fault at the gateway, not the instrument.",
  bank_technical_error: "Core banking system fault, not the customer's card/account.",
  issuer_technical_error: "Fault at the card issuer's end.",
  server_error: "Razorpay-side technical error.",
  request_timed_out: "Network/timing failure, not a decline.",
  bank_not_available: "Bank downtime. Recovers when the bank is back.",
  bank_cutoff_in_progress: "Scheduled bank batch window; recovers shortly after.",
  psp_app_not_available: "UPI PSP app downtime, not a rejection.",
  psp_not_available: "PSP unavailable, transient by definition.",
  invalid_response_from_gateway: "Gateway-side response fault, not a customer action.",
  payment_declined_due_to_high_traffic: "Gateway load issue, not a decline of the instrument.",
  upi_app_technical_error: "Technical fault at the customer's UPI app/PSP.",
  verification_failed: "Razorpay docs mark this explicitly as a temporary/retry-safe error.",
  duplicate_rrn_found: "Gateway-side reconciliation glitch; a fresh attempt gets a new RRN.",
  transaction_frequency_limit_exceeded: "NPCI-imposed time-window limit — resolves once the window rolls over, not permanent.",
  transaction_daily_count_exceeded: "Daily count resets; same shape as a time-window limit.",
  payment_pending: "Not yet a failure — in flight. Treated as transient until resolved.",
  collect_request_pending: "A prior UPI collect is still outstanding; not a decline.",
  // Generic "the bank/gateway said no, but did not say why" reasons. Industry
  // dunning practice treats an unqualified decline as a soft decline unless a
  // specific hard-decline reason is attached — we follow that convention and
  // reserve TERMINAL for the reasons that are explicitly permanent below.
  payment_failed: "Generic gateway/bank decline with no specific reason attached — treated as soft decline (industry dunning convention), not a permanent block.",
  card_declined: "Generic decline, no specific reason code — soft decline convention.",
  payment_declined: "Generic decline, no specific reason code — soft decline convention.",
  debit_declined: "Generic decline, no specific reason code — soft decline convention.",
  credit_failed: "Generic credit-processing failure, no specific reason — soft decline convention.",
};

// --- FUNDS ---------------------------------------------------------------
// Instrument valid, money/limit not there yet. Timing is the whole decision
// (spec §7). Includes card/UPI limit exhaustion, which behaves identically
// to a balance problem from a recovery standpoint: waiting fixes it.
const FUNDS: Record<string, string> = {
  insufficient_funds: "Canonical FUNDS case.",
  credit_limit_exceeded: "Limit-based, not instrument-based — same recovery shape as insufficient funds.",
  credit_limit_expired: "Limit needs renewal/cycle rollover — a timing problem, not an instrument problem.",
  credit_limit_inactive: "Limit dormant, typically reactivates on issuer's cycle.",
  credit_limit_not_approved: "Pending approval that resolves over time, not a new instrument.",
  mcc_amount_limit_exceeded: "Per-category amount ceiling; waiting for a cycle reset can resolve it.",
  transaction_limit_exceeded: "Per-transaction/credit limit, resolves on issuer's cycle.",
  transaction_daily_limit_exceeded: "Explicit next-step in Razorpay's own docs: 'wait 24 hours.' Textbook FUNDS/timing case.",
  funds_blocked_by_mandate: "Money is committed elsewhere, not permanently unavailable — a timing problem.",
  credit_not_permitted: "Credit transactions not permitted on this line right now — same shape as the other credit-limit reasons above; a standing-based, not instrument-based, block.",
};

// --- AUTH_ABANDONED --------------------------------------------------------
// Dropped at OTP/3DS/UPI-collect, or a data-entry slip during checkout. Same
// instrument works; the customer needs another pass through the flow, nudged
// at a time they're likely to complete it (spec §7).
const AUTH_ABANDONED: Record<string, string> = {
  authentication_failed: "OTP/3DS failure or explicit cancel at the auth step — a flow dropout, not an instrument fault.",
  incorrect_otp: "Entry mistake at the OTP step; same instrument, needs a retry through the flow.",
  otp_expired: "Customer didn't complete the OTP step in time.",
  otp_attempts_exceeded: "Repeated entry mistakes at the OTP step, not an instrument problem.",
  incorrect_pin: "Entry mistake at the PIN step.",
  incorrect_atm_pin: "Entry mistake at the ATM PIN step (net-banking/debit flow).",
  pin_attempts_exceeded: "Repeated entry mistakes at the PIN step.",
  payment_cancelled: "Customer explicitly backed out mid-flow — the definition of abandoned.",
  payment_timed_out: "Customer did not complete the flow within the window.",
  payment_session_expired: "Session lapsed before completion — flow abandonment, not instrument fault.",
  payment_collect_request_expired: "UPI collect request expired unapproved — classic auth-abandon shape.",
  reqauth_mandate_not_acknowledged: "Customer did not acknowledge the mandate step.",
  authorisation_declined_by_psp: "PSP-side rejection of the authorisation step; retry through the flow, possibly a different PSP app.",
  mandate_creation_expired: "Mandate setup window lapsed before the customer completed it — a flow dropout, not an instrument fault.",
  mandate_creation_timeout: "Mandate setup timed out mid-flow — a flow dropout, same shape as an abandoned OTP.",
  // Data-entry slips: the physical card/VPA is fine, the customer mistyped a
  // field during checkout. A silent retry reproduces the same typo risk; the
  // fix is another pass through the flow, same as an abandoned OTP.
  incorrect_cvv: "Data-entry mistake on a valid card, not a card fault.",
  incorrect_card_details: "Data-entry mistake, not a card fault.",
  incorrect_card_expiry_date: "Data-entry mistake, not a card fault.",
  incorrect_cardholder_name: "Data-entry mistake, not a card fault.",
};

// --- INSTRUMENT ------------------------------------------------------------
// The same instrument will fail again, deterministically. Only a link that
// lets the customer supply a different instrument/method resolves this
// (spec §7).
const INSTRUMENT: Record<string, string> = {
  card_expired: "Canonical INSTRUMENT case.",
  card_number_invalid: "Malformed/wrong card number — will fail identically on retry.",
  card_type_invalid: "Card type not accepted for this flow — needs a different card.",
  card_network_not_enabled: "This card's network isn't supported — needs a different card.",
  card_not_enrolled: "Card not enrolled for the required auth (e.g. 3DS) — needs a different card.",
  bank_account_invalid: "Wrong/closed account — will fail identically on retry.",
  bank_account_validation_failed: "Account failed third-party validation — needs a different account.",
  invalid_vpa: "Malformed/wrong UPI ID — will fail identically on retry.",
  vpa_resolution_failed: "UPI network could not validate this VPA — needs a different one.",
  transaction_on_vpa_restricted: "This VPA is blocked at the PSP level for this transaction.",
  user_not_registered_for_netbanking: "Account not netbanking-enabled — needs a different method.",
  debit_instrument_inactive: "Instrument dormant — needs a different one or reactivation outside this flow.",
  pin_not_set: "Instrument has no PIN configured — cannot complete via this method until set elsewhere.",
  recurring_payment_not_enabled: "This instrument/mandate path doesn't support recurring — needs a different setup.",
  mandate_creation_declined: "Mandate on this instrument was declined — needs a different instrument.",
  mandate_creation_failed: "Mandate on this instrument failed — needs a different instrument.",
  international_transaction_not_allowed: "This specific card isn't enabled for international — needs a different card, not a wait.",
  // Merchant/config-side "this rail isn't enabled" reasons. From the
  // customer's perspective this behaves exactly like an instrument problem:
  // the fix is to route them to pick a different method via a link, not to
  // retry the identical, always-losing rail.
  payment_method_not_enabled: "Method disabled for this merchant — always fails identically; route to a different method via link.",
  bank_not_enabled: "Bank disabled for this merchant — always fails identically; route via link.",
  upi_collect_not_enabled: "Collect flow disabled — route to a different UPI flow/method via link.",
  upi_intent_not_enabled: "Intent flow disabled — route to a different UPI flow/method via link.",
  emi_plan_unavailable: "This EMI plan doesn't exist for this card — needs a different plan/method via link.",
  emi_greater_than_max_amount: "EMI not offered at this amount on this card — needs a different method via link.",
  psp_app_not_supported: "This UPI app is blacklisted/unsupported — needs a different PSP app via link.",
  psp_not_registered: "PSP not registered for this flow — needs a different PSP via link.",
  user_not_eligible: "Razorpay's own next-step is 'retry with different method' — an eligibility gate on this instrument, not a timing or auth problem.",
  upi_autopay_not_supported_on_psp: "This PSP doesn't support the Autopay/mandate flow — needs a different PSP app, per Razorpay's own next-step.",
};

// --- TERMINAL ----------------------------------------------------------
// Never retry, never contact. markTerminal immediately (spec §7).
const TERMINAL: Record<string, string> = {
  debit_instrument_blocked: "Explicit: 'card blocked by issuer or by customer' — the canonical TERMINAL case (stolen/blocked).",
  payment_risk_check_failed: "Fraud/risk decline — the canonical TERMINAL case.",
  compliance_violation: "Regulatory block, not retry-able by design.",
  deemed_transaction: "Explicitly cannot be processed further per Razorpay's own docs.",
  beneficiary_account_does_not_exist: "Account doesn't exist — no retry recovers this.",
  beneficiary_account_dormant: "Dormant account — not a timing problem the merchant can wait out.",
  collect_on_mcc_blocked: "Merchant category systemically blocked for UPI collect — retry never helps.",
  // Integration/config errors. These describe a broken request from the
  // merchant's own systems (bad order id, amount mismatch, wrong currency,
  // stale test/live keys, deactivated account) rather than a customer
  // payment failure. They should be rare-to-absent on real `payment.failed`
  // webhooks for a genuine customer attempt; if one appears, retrying without
  // fixing the underlying integration bug reproduces the identical error, so
  // there is nothing for a recovery agent to do — fail closed.
  amount_less_than_minimum_amount: "Integration/config error — reproduces identically on retry.",
  invalid_amount: "Integration/config error — reproduces identically on retry.",
  invalid_currency: "Integration/config error — reproduces identically on retry.",
  invalid_order_id: "Integration/config error — reproduces identically on retry.",
  invalid_request: "Integration/config error — reproduces identically on retry.",
  input_validation_failed: "Integration/config error — reproduces identically on retry.",
  order_amount_mismatch: "Integration/config error — reproduces identically on retry.",
  order_payment_method_mismatch: "Integration/config error — reproduces identically on retry.",
  mismatch_in_transaction_details: "Integration/config error — reproduces identically on retry.",
  invalid_user_details: "Integration/config error — reproduces identically on retry.",
  invalid_email: "Integration/config error — reproduces identically on retry.",
  invalid_mobile_number: "Integration/config error — reproduces identically on retry.",
  mobile_number_invalid: "Integration/config error — reproduces identically on retry.",
  invalid_device: "Integration/config error — reproduces identically on retry.",
  record_not_found: "Integration/config error — reproduces identically on retry.",
  duplicate_request: "Integration/config error — reproduces identically on retry.",
  duplicate_refund_id: "Refund-flow error, not a payment failure at all — out of scope, fail closed.",
  refund_limit_crossed: "Refund-flow error, not a payment failure at all — out of scope, fail closed.",
  capture_failed: "Capture-step failure on our side — not customer-recoverable via a link.",
  order_already_paid: "Contradicts the premise of a failure needing recovery — fail closed rather than act on stale/bad data.",
  live_mode_not_enabled: "Merchant config error — no customer action fixes this.",
  merchant_not_activated: "Merchant config error — no customer action fixes this.",
  payment_pending_approval: "Stuck on the merchant's internal maker-checker, not something a customer nudge affects.",
  payment_amount_tampered: "Explicit security/integrity flag — never retry, treat like a fraud decline.",
};

const BUCKETS: Array<[FailureCategory, Record<string, string>]> = [
  ["TRANSIENT", TRANSIENT],
  ["FUNDS", FUNDS],
  ["AUTH_ABANDONED", AUTH_ABANDONED],
  ["INSTRUMENT", INSTRUMENT],
  ["TERMINAL", TERMINAL],
];

// Fail loudly at import time if the same error_reason was assigned to two
// buckets — Object.fromEntries would otherwise silently keep only the last
// one, which is exactly the kind of bug this taxonomy exists to prevent.
function assertNoDuplicateKeys(buckets: Array<[FailureCategory, Record<string, string>]>): void {
  const owner = new Map<string, FailureCategory>();
  for (const [category, entries] of buckets) {
    for (const reason of Object.keys(entries)) {
      const existing = owner.get(reason);
      if (existing) {
        throw new Error(
          `Taxonomy error: "${reason}" is assigned to both ${existing} and ${category}. Fix classify.ts before shipping.`,
        );
      }
      owner.set(reason, category);
    }
  }
}
assertNoDuplicateKeys(BUCKETS);

const TAXONOMY: Record<string, TaxonomyEntry> = Object.fromEntries(
  BUCKETS.flatMap(([category, entries]) =>
    Object.entries(entries).map(([reason, note]) => [reason, { category, note }]),
  ),
);

export interface ClassifyInput {
  errorReason: string | null | undefined;
  errorCode?: string | null;
  errorSource?: string | null;
}

export interface ClassifyResult {
  category: FailureCategory;
  matchedReason: string | null;
  note: string;
}

/**
 * Fail closed: any error_reason not in the table above -> TERMINAL.
 * Never fail open. This is a hard non-negotiable (spec §6, §7).
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const reason = input.errorReason?.trim().toLowerCase() ?? null;

  if (!reason) {
    return {
      category: "TERMINAL",
      matchedReason: null,
      note: "No error_reason present on the payload — fail closed, cannot classify.",
    };
  }

  const entry = TAXONOMY[reason];
  if (!entry) {
    return {
      category: "TERMINAL",
      matchedReason: null,
      note: `Unmapped error_reason "${reason}" — fail closed per spec §6.`,
    };
  }

  return { category: entry.category, matchedReason: reason, note: entry.note };
}

export function taxonomyTable(): Array<{ reason: string; category: FailureCategory; note: string }> {
  return Object.entries(TAXONOMY)
    .map(([reason, { category, note }]) => ({ reason, category, note }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.reason.localeCompare(b.reason));
}
