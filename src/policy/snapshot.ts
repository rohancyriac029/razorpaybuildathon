// The state P1/P2/P5/P9/P10/P11/P12 need, gathered once per decide() call.
// Kept as a plain data object so the rule evaluator (rules.ts) can be tested
// with hand-built snapshots and never touch a database.

export interface PolicySnapshot {
  /** Executed TOKEN_RETRY/PAYMENT_LINK/NUDGE attempts on this order (P1). */
  priorExecutedAttempts: number;
  /** createdAt of the most recent executed attempt on this order, if any (P2). */
  lastExecutionAt: Date | null;
  /** Executed PAYMENT_LINK/NUDGE contacts on this order (P5). */
  priorContacts: number;
  /** A PAYMENT_LINK was executed for this order and the order isn't paid yet (P12). */
  liveUnpaidLinkExists: boolean;
  /** Executed attempts system-wide in the last 60 minutes (P10). */
  globalExecutionsLastHour: number;
  /** Executed PAYMENT_LINK/NUDGE contacts system-wide since IST midnight (P10). */
  globalContactsToday: number;
  /** An intent with this idempotency key was already executed (P7). */
  idempotencyKeyAlreadyExecuted: boolean;
}
