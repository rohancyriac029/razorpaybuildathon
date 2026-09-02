// Feeds the Rules strategy's TRANSIENT branch (spec §5.3: "link at +90m if
// downtime cleared, else +6h"). Kept as an injectable interface rather than
// a hardcoded lookup because block 1 deliberately did not wire real
// consumption of payment.downtime.* webhooks (spec §1.4: consume it
// properly or drop it, don't reinvent getMethodHealth — and this schema
// doesn't even track payment method per failure yet, so "properly" would be
// real scope creep here).
//
// The default implementation is intentionally pessimistic: absent a real
// signal, ASSUME downtime is still active (the longer +6h wait), not
// cleared. This mirrors the system's fail-closed posture elsewhere (§6:
// "fail closed, never fail open") — optimistically assuming rails are fine
// when we don't actually know risks burning one of an order's three
// lifetime attempts on a retry that was never going to succeed.
export interface DowntimeChecker {
  isCleared(method: string | null, at: Date): boolean;
}

export class UnknownDowntimeChecker implements DowntimeChecker {
  isCleared(): boolean {
    return false; // unknown -> treat as still degraded, see module doc
  }
}
