// The scenario type: an order, a failure, synthetic customer history, and
// the HIDDEN ground-truth model of when it would actually recover. Nothing
// in this file — and certainly nothing derived from it — may reach
// src/agent/system-prompt.ts (spec §5.2 point 2, the firewall).
import type { FailureCategory } from "../types.js";

export interface Scenario {
  id: string;
  category: FailureCategory;
  errorReason: string;
  amountPaise: number;
  customerId: string;
  isFirstTime: boolean;
  occurredAt: Date;

  // --- hidden ground truth, never exposed to a Strategy directly ---------
  liquidityHourIst: number; // 0-23, this customer's "good" hour
  baseRecoveryProb: number; // category baseline from the config
  /** TRANSIENT only: ms after occurredAt when rails recover. null = never degraded (idiosyncratic failure). */
  downtimeClearAtOffsetMs: number | null;
  /** Always false in this build — see src/world/sim-world.ts's chargeToken doc for why TOKEN_RETRY isn't modeled as viable here. */
  hasConfirmedMandateToken: boolean;
  /** Deterministic per-scenario seed for the irreducible-randomness component of wouldSucceed. */
  outcomeSeed: number;

  // --- synthetic history, this IS exposed via getCustomerHistory ---------
  history: Array<{ paidAt: string; amount: number; hourOfDayIst: number }>;
}
