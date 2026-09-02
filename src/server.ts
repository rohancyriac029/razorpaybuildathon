// Spec §6 block 1: Fastify POST /webhooks/razorpay. Verify signature, reject
// unverified with 401, return 200 fast, process async.
import Fastify from "fastify";
import { db } from "./db/client.js";
import { verifyWebhookSignature } from "./webhooks/verify.js";
import { isSubscribedEvent, type WebhookPayload } from "./webhooks/events.js";
import {
  dedupeAndStore,
  markProcessed,
  processPaymentFailed,
  processOrderPaid,
  processSubscriptionLifecycle,
  processDowntime,
} from "./webhooks/handler.js";

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";

export function buildServer() {
  const app = Fastify({ logger: true });

  // Fastify's default JSON parser discards the raw body after parsing. HMAC
  // signature verification needs the exact raw bytes Razorpay signed, so we
  // capture the raw string ourselves and still hand back a parsed object —
  // this replaces the default parser for application/json globally, which
  // is fine here since every route in this service is a webhook receiver.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      (req as unknown as { rawBody: string }).rawBody = body as string;
      try {
        done(null, body === "" ? {} : JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.get("/health", async () => ({ ok: true }));

  app.post("/webhooks/razorpay", async (req, reply) => {
    const rawBody = (req as unknown as { rawBody: string }).rawBody ?? "";
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    const eventId = req.headers["x-razorpay-event-id"] as string | undefined;

    if (!verifyWebhookSignature(rawBody, signature, WEBHOOK_SECRET)) {
      req.log.warn("webhook signature verification failed");
      return reply.code(401).send({ error: "invalid signature" });
    }

    if (!eventId) {
      // Razorpay always sends this header; if it's missing, we cannot dedupe
      // safely. Fail closed rather than risk double-processing.
      req.log.warn("webhook missing x-razorpay-event-id header");
      return reply.code(401).send({ error: "missing event id" });
    }

    const body = req.body as WebhookPayload & { event: string };
    const now = new Date().toISOString();

    // Return 200 fast; process after the response is queued. Fastify's
    // request lifecycle has already given us the parsed+verified body, so
    // "async" here means "off the caller's latency budget", not "off this
    // process" — there is no separate worker for a hackathon-scope build.
    reply.code(200).send({ ok: true });

    if (!isSubscribedEvent(body.event)) {
      return; // ignore events we didn't subscribe to
    }

    const { isNew } = dedupeAndStore(db, eventId, body.event, body, now);
    if (!isNew) {
      req.log.info({ eventId }, "duplicate webhook event, skipped");
      return;
    }

    try {
      switch (body.event) {
        case "payment.failed":
          processPaymentFailed(db, eventId, body as never, now);
          break;
        case "order.paid":
          processOrderPaid(db, body as never, now);
          break;
        case "subscription.pending":
        case "subscription.halted":
        case "subscription.charged":
          processSubscriptionLifecycle(db, body as never, now);
          break;
        case "payment.downtime.started":
        case "payment.downtime.resolved":
          processDowntime(db, body as never, now);
          break;
      }
      markProcessed(db, eventId, new Date().toISOString());
    } catch (err) {
      req.log.error({ err, eventId }, "webhook processing failed after 200 was sent");
    }
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    app.log.info(`salvage listening on :${port}`);
  });
}
