import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../src/webhooks/verify.js";

const SECRET = "test_webhook_secret_123";

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ event: "payment.failed" });
    const sig = sign(body, SECRET);
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const body = JSON.stringify({ event: "payment.failed" });
    const sig = sign(body, "wrong_secret");
    expect(verifyWebhookSignature(body, sig, SECRET)).toBe(false);
  });

  it("rejects when the body was tampered with after signing", () => {
    const original = JSON.stringify({ event: "payment.failed", amount: 100 });
    const sig = sign(original, SECRET);
    const tampered = JSON.stringify({ event: "payment.failed", amount: 999999 });
    expect(verifyWebhookSignature(tampered, sig, SECRET)).toBe(false);
  });

  it("rejects a missing signature outright (fail closed)", () => {
    const body = JSON.stringify({ event: "payment.failed" });
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe(false);
  });

  it("rejects an empty-string signature", () => {
    const body = JSON.stringify({ event: "payment.failed" });
    expect(verifyWebhookSignature(body, "", SECRET)).toBe(false);
  });

  it("does not throw on a malformed signature and instead returns false", () => {
    const body = JSON.stringify({ event: "payment.failed" });
    expect(() => verifyWebhookSignature(body, "not-hex-!!!", SECRET)).not.toThrow();
    expect(verifyWebhookSignature(body, "not-hex-!!!", SECRET)).toBe(false);
  });
});
