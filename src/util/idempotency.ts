// P7: idempotency key = hash(orderId, attemptNumber); dupes dropped.
import { createHash } from "node:crypto";

export function idempotencyKey(orderId: string, attemptNumber: number): string {
  return createHash("sha256").update(`${orderId}:${attemptNumber}`).digest("hex");
}
