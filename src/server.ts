// Spec §6 block 1: Fastify POST /webhooks/razorpay. Verify signature, reject
// unverified with 401, return 200 fast, process async.
// Spec §6 block 9: also serves the static audit/eval-scoreboard page and its
// two read-only JSON endpoints — "one static HTML page," no framework, but
// it needs somewhere to fetch real data from, and this server already has
// the DB connection.
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { db as defaultDb } from "./db/client.js";
import type * as schema from "./db/schema.js";
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
import { listOrdersWithEpisodes, getDecisionChain } from "./audit/decision-chain.js";
import { latestRunReport } from "./eval/latest-run-report.js";

/**
 * db is injectable so tests can run the real Fastify request lifecycle
 * (signature check, dedupe, classification) against an in-memory database
 * via .inject(), instead of only unit-testing the handler functions
 * directly. Production (the `if (import.meta.url === ...)` block below)
 * uses the real file-backed db.
 *
 * onPaymentFailed is an optional hook, called after a payment.failed
 * webhook is classified, with the internal orderId. Defaults to a no-op so
 * existing classification-only tests are unaffected — production wires it
 * to the real decide -> schedule pipeline (see the bottom of this file).
 */
export function buildServer(
  db: BetterSQLite3Database<typeof schema> = defaultDb,
  onPaymentFailed: (db: BetterSQLite3Database<typeof schema>, orderId: string) => Promise<void> = async () => {},
) {
  const app = Fastify({ logger: process.env.VITEST !== "true" });

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

  app.get("/", async (_req, reply) => {
    try {
      const html = readFileSync("public/index.html", "utf-8");
      reply.type("text/html").send(html);
    } catch {
      reply.code(404).send({ error: "public/index.html not found" });
    }
  });

  app.get("/api/orders", async () => listOrdersWithEpisodes(db));

  app.get<{ Params: { id: string } }>("/api/orders/:id", async (req, reply) => {
    const chain = getDecisionChain(db, req.params.id);
    if (!chain) return reply.code(404).send({ error: "order not found" });
    return chain;
  });

  app.get("/api/eval/latest", async () => latestRunReport(db));

  app.post("/webhooks/razorpay", async (req, reply) => {
    const rawBody = (req as unknown as { rawBody: string }).rawBody ?? "";
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    const eventId = req.headers["x-razorpay-event-id"] as string | undefined;

    // Read per-request, not captured at module load: a test (or a secret
    // rotation) that sets this after the module is first imported must
    // still take effect.
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
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
        case "payment.failed": {
          const result = processPaymentFailed(db, eventId, body as never, now);
          await onPaymentFailed(db, result.orderId);
          break;
        }
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
  // Production wiring, constructed once at startup. AgentStrategy is
  // primary; RulesStrategy is both the eval's ablation baseline (block 5)
  // and, unchanged, this strategy's fallback on a malformed/timed-out/down
  // LLM (spec §3.1.1) — same instance, dual use, no separate code path.
  const Razorpay = (await import("razorpay")).default;
  const { RazorpayWorld } = await import("./world/razorpay-world.js");
  const { RealScheduler } = await import("./scheduler/real.js");
  const { RulesStrategy } = await import("./strategies/rules.js");
  const { AgentStrategy } = await import("./agent/agent-strategy.js");
  const { llmClientFromEnv } = await import("./llm/factory.js");
  const { RulesPolicyEngine } = await import("./policy/engine.js");
  const { policyConfigFromEnv } = await import("./policy/engine.js");
  const { makeEpisodeLogger } = await import("./persistence/episode-logger.js");
  const { runDecisionPipeline, registerExecutionDispatcher } = await import(
    "./orchestration/decision-pipeline.js"
  );

  const rzp = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID ?? "",
    key_secret: process.env.RAZORPAY_KEY_SECRET ?? "",
  });
  const world = new RazorpayWorld(rzp, defaultDb);
  const scheduler = new RealScheduler();
  const rulesFallback = new RulesStrategy();
  const strategy = new AgentStrategy(llmClientFromEnv(), rulesFallback);
  const policyEngine = new RulesPolicyEngine(defaultDb, policyConfigFromEnv());
  const log = makeEpisodeLogger(defaultDb, strategy.name, null);

  registerExecutionDispatcher(defaultDb, scheduler, world, log);

  const app = buildServer(defaultDb, (db, orderId) =>
    runDecisionPipeline(db, orderId, strategy, policyEngine, scheduler, log),
  );
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).then(() => {
    app.log.info(`salvage listening on :${port}`);
  });
}
