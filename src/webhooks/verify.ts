// Spec §6 block 1: "Look up the webhook signature verification helper rather
// than guessing its name." Confirmed against razorpay-node (installed
// version, checked 2026-09-02): Razorpay.validateWebhookSignature(rawBody,
// signature, secret) is a static method on the SDK's default export, backed
// by an HMAC-SHA256 comparison of the raw request body.
//
// Razorpay computes the signature over the *raw* body bytes, so the caller
// must pass the untouched string exactly as received — not a re-serialised
// JSON.stringify() of the parsed object, which can reorder keys or change
// whitespace and silently break every verification. See server.ts for how
// the raw body is captured before Fastify's JSON parser touches it.
import Razorpay from "razorpay";

export function verifyWebhookSignature(
  rawBody: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) return false;
  try {
    return Razorpay.validateWebhookSignature(rawBody, signature, secret);
  } catch {
    // The SDK throws on some malformed inputs rather than returning false.
    // A malformed signature is not a valid one — fail closed.
    return false;
  }
}
