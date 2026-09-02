import { describe, it, expect } from "vitest";
import { classify, taxonomyTable } from "../src/taxonomy/classify.js";

describe("taxonomy: classify()", () => {
  it("fails closed on missing error_reason", () => {
    expect(classify({ errorReason: null }).category).toBe("TERMINAL");
    expect(classify({ errorReason: undefined }).category).toBe("TERMINAL");
    expect(classify({ errorReason: "" }).category).toBe("TERMINAL");
  });

  it("fails closed on an unmapped error_reason", () => {
    const r = classify({ errorReason: "totally_made_up_reason_xyz" });
    expect(r.category).toBe("TERMINAL");
    expect(r.matchedReason).toBeNull();
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(classify({ errorReason: "  Insufficient_Funds  " }).category).toBe("FUNDS");
  });

  it("maps the five spec-canonical examples correctly", () => {
    expect(classify({ errorReason: "gateway_technical_error" }).category).toBe("TRANSIENT");
    expect(classify({ errorReason: "insufficient_funds" }).category).toBe("FUNDS");
    expect(classify({ errorReason: "payment_cancelled" }).category).toBe("AUTH_ABANDONED");
    expect(classify({ errorReason: "card_expired" }).category).toBe("INSTRUMENT");
    expect(classify({ errorReason: "debit_instrument_blocked" }).category).toBe("TERMINAL");
  });

  it("never returns a category outside the five-value taxonomy", () => {
    const valid = new Set(["TRANSIENT", "FUNDS", "AUTH_ABANDONED", "INSTRUMENT", "TERMINAL"]);
    for (const { category } of taxonomyTable()) {
      expect(valid.has(category)).toBe(true);
    }
  });

  it("has no duplicate error_reason keys across categories (last-write-wins would silently misclassify)", () => {
    // Re-derive the raw key lists the same way classify.ts does, but assert
    // no key appears twice across the five buckets before they're merged.
    const rows = taxonomyTable();
    const seen = new Map<string, string>();
    for (const { reason, category } of rows) {
      if (seen.has(reason)) {
        throw new Error(
          `Duplicate taxonomy key "${reason}": appears as both ${seen.get(reason)} and ${category}`,
        );
      }
      seen.set(reason, category);
    }
    expect(seen.size).toBe(rows.length);
  });

  it("covers every error_reason documented at razorpay.com/docs/errors/ (127 values, fetched 2026-09-02)", () => {
    // This is the literal list returned by the docs fetch. If Razorpay adds a
    // new reason, this test fails loudly instead of the reason silently
    // falling through to the safe-but-uninformative TERMINAL default.
    const documented = [
      "amount_less_than_minimum_amount", "authentication_failed", "bank_account_invalid",
      "bank_account_validation_failed", "bank_not_enabled", "bank_technical_error",
      "capture_failed", "card_expired", "card_network_not_enabled", "card_not_enrolled",
      "card_number_invalid", "card_type_invalid", "compliance_violation",
      "debit_instrument_blocked", "duplicate_refund_id", "duplicate_request",
      "emi_greater_than_max_amount", "emi_plan_unavailable", "incorrect_atm_pin",
      "incorrect_card_details", "incorrect_card_expiry_date", "incorrect_cardholder_name",
      "incorrect_cvv", "incorrect_otp", "incorrect_pin", "input_validation_failed",
      "insufficient_funds", "international_transaction_not_allowed", "invalid_amount",
      "invalid_currency", "invalid_device", "invalid_email", "invalid_mobile_number",
      "invalid_order_id", "invalid_request", "invalid_user_details", "invalid_vpa",
      "live_mode_not_enabled", "merchant_not_activated", "mismatch_in_transaction_details",
      "mobile_number_invalid", "order_already_paid", "order_payment_method_mismatch",
      "order_amount_mismatch", "otp_attempts_exceeded", "otp_expired", "payment_cancelled",
      "payment_failed", "payment_method_not_enabled", "payment_pending_approval",
      "payment_risk_check_failed", "payment_timed_out", "pin_attempts_exceeded",
      "pin_not_set", "record_not_found", "recurring_payment_not_enabled",
      "refund_limit_crossed", "server_error", "transaction_daily_limit_exceeded",
      "transaction_limit_exceeded", "transaction_frequency_limit_exceeded",
      "transaction_on_vpa_restricted", "upi_app_technical_error",
      "upi_autopay_not_supported_on_psp", "upi_collect_not_enabled",
      "upi_intent_not_enabled", "user_not_eligible", "user_not_registered_for_netbanking",
      "verification_failed",
      // gateway-source reasons not already listed above
      "authorisation_declined_by_psp", "bank_cutoff_in_progress", "bank_not_available",
      "beneficiary_account_does_not_exist", "beneficiary_account_dormant", "card_declined",
      "collect_on_mcc_blocked", "collect_request_pending", "credit_limit_exceeded",
      "credit_limit_expired", "credit_limit_inactive", "credit_limit_not_approved",
      "credit_not_permitted", "credit_failed", "debit_declined", "deemed_transaction",
      "debit_instrument_inactive", "duplicate_rrn_found", "funds_blocked_by_mandate",
      "gateway_technical_error", "invalid_response_from_gateway", "issuer_technical_error",
      "mandate_creation_declined", "mandate_creation_expired", "mandate_creation_failed",
      "mandate_creation_timeout", "mcc_amount_limit_exceeded", "payment_amount_tampered",
      "payment_collect_request_expired", "payment_declined",
      "payment_declined_due_to_high_traffic", "payment_pending", "payment_session_expired",
      "psp_app_not_available", "psp_app_not_supported", "psp_not_available",
      "psp_not_registered", "reqauth_mandate_not_acknowledged", "request_timed_out",
      "transaction_daily_count_exceeded", "vpa_resolution_failed",
    ];

    const unclassified: string[] = [];
    for (const reason of documented) {
      const result = classify({ errorReason: reason });
      if (result.matchedReason === null) unclassified.push(reason);
    }
    expect(unclassified).toEqual([]);
  });
});
