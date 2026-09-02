# Build progress

Tracks what exists against [salvage-v2-spec.md](salvage-v2-spec.md) §6 block order. Updated on every addition — check here before assuming something is or isn't built.

**Package manager: npm, not pnpm.** `corepack prepare pnpm` failed with `EPERM` on this machine (no admin rights to write `C:\Program Files\nodejs\yarn`). Functionally identical — `npm run eval` instead of `pnpm eval`. `package.json` scripts are the source of truth; the spec's `pnpm` references are cosmetic.

**Razorpay test key: works, Subscriptions not entitled.** Verified live 2026-09-02 (spec §0.1). `payments`, `payment_links`, `customers`, `invoices`, `items`, `settlements` all return 200. `plans` and `subscriptions` return 401 with a distinct error envelope (`{"error":"Unauthorized"}` vs. the real auth-failure shape) — that's a product gate, not a bad key. Activation requested; not yet confirmed. Building Path B (payment-link recovery on one-time payments, §6 block 4) first per the spec's own instruction, since it's unblocked and shares the executor with Path A.

---

## Block 0 — skeleton ✅ done (2026-09-02)

SQLite schema, three ports, `run()`. Spec §3.1: "the ports are the whole architecture."

| File | What |
|---|---|
| `src/types.ts` | Domain vocabulary: `Order`, `FailureEvent`, `Proposal` (5 variants), `PolicyVerdict`, `Intent`, `ExecResult`, `EpisodeContext` |
| `src/ports/scheduler.ts` | `Scheduler` — `RealScheduler`/`VirtualScheduler` will implement (block 3/7) |
| `src/ports/strategy.ts` | `Strategy` — the 5 baselines will implement (blocks 5–7) |
| `src/ports/world.ts` | `World` — `RazorpayWorld`/`SimWorld` will implement (blocks 4/7) |
| `src/ports/policy-engine.ts` | `PolicyEngine` — block 2 implements |
| `src/run.ts` | The one entry point: `run(strategy, scheduler, world, policyEngine, ctx, log)`. PROPOSE → GATE → EXECUTE → LOG. P8 live-order recheck is inline here, not delegated, so it can't be skipped by a strategy. `ESCALATE` is logged as a real outcome (§4.4), not a black hole. |
| `src/util/idempotency.ts` | P7: `hash(orderId, attemptNumber)` |
| `src/util/context-hash.ts` | Feeds the audit log; §3.4's "policy engine is replayable" claim |
| `src/db/schema.ts` | Tables: `customers`, `orders`, `webhook_events` (dedupe), `failures`, `episodes`, `intents`, `eval_runs`, `llm_cache` (`subscriptions` added in block 1, see below — 9 total) |
| `src/db/client.ts` | better-sqlite3 + Drizzle, WAL mode, FKs on |
| `drizzle.config.ts`, `npm run db:push` | Reviewer setup: one command, zero external services |
| `drizzle/0000_*.sql` | Committed migration SQL, generated from schema — lets tests apply the real schema to an in-memory DB without shelling out to drizzle-kit |

**Verified:** `npx tsc --noEmit` clean. `npm run db:push` created all tables against a fresh `salvage.sqlite`.

**Deliberate scope cut vs. spec:** no `contacts_log`/`executions_log` tables — P5/P10/P11/P12 caps will be computed by querying `episodes`/`intents` directly in block 2. Revisit only if that query becomes a measured bottleneck (it won't, at hackathon scale).

## Block 1 — taxonomy mapper + webhook handler ✅ done (2026-09-02)

Spec §6 block 1: normalise every failure, verify signatures, dedupe, fail closed.

| File | What |
|---|---|
| `src/taxonomy/classify.ts` | Maps every Razorpay `error_reason` documented at `razorpay.com/docs/errors/` (fetched live, 2026-09-02) into `TRANSIENT \| FUNDS \| AUTH_ABANDONED \| INSTRUMENT \| TERMINAL`. **110 reasons mapped** — 23 TRANSIENT, 10 FUNDS, 19 AUTH_ABANDONED, 27 INSTRUMENT, 31 TERMINAL. One comment per entry, as spec requires ("reviewers will read this file"). Unmapped or missing reason → `TERMINAL`, fail closed. A module-load-time assertion throws if any reason is ever assigned to two buckets (a real bug the naive `Object.fromEntries` merge would otherwise hide silently). |
| `src/webhooks/events.ts` | Typed payload shapes for the 7 subscribed events, field paths confirmed against live docs (not guessed) |
| `src/webhooks/verify.ts` | Wraps `Razorpay.validateWebhookSignature` (confirmed export name/signature against the installed package, not assumed) |
| `src/webhooks/handler.ts` | Pure(ish) functions: `dedupeAndStore`, `processPaymentFailed`, `processOrderPaid`, `processSubscriptionLifecycle`, `processDowntime` — testable without a live server |
| `src/server.ts` | Fastify `POST /webhooks/razorpay`: raw-body capture (needed for HMAC — Fastify's default parser discards it), signature check → 401, dedupe → 200 fast + async processing |

**Design decision worth flagging:** `subscription.pending`/`subscription.halted` do **not** independently drive taxonomy classification. Confirmed against live docs: those events carry a subscription id, not an order id, and don't reliably include a payment entity — but `payment.failed` *always* fires alongside them for the same underlying charge failure, with `order_id` and `error_reason` both present. So `payment.failed` is the sole input to `classify()`; the subscription events are lifecycle bookkeeping in a separate `subscriptions` table (added to schema, block 0 addendum). This also avoids a real bug: conflating "Razorpay gave up retrying" (`halted`) with "this instrument is permanently dead" (`TERMINAL`) would incorrectly `markTerminal` a subscription that failed only on recoverable `FUNDS` grounds.

**Correction from the earlier chat-level claim:** webhook dedupe keys on the **`x-razorpay-event-id` HTTP header**, not a body field — verified against docs, since I'd initially assumed a body-level event id without checking.

**Verified:** `npx tsc --noEmit` clean. 23/23 tests passing across three files:
- `test/taxonomy.test.ts` (7) — fail-closed paths, case-insensitivity, no-duplicate-keys, and a literal 127-reason list from the docs fetch cross-checked against the mapper (found and fixed 6 real gaps: `credit_not_permitted`, `user_not_eligible`, `upi_autopay_not_supported_on_psp`, `mandate_creation_expired`, `mandate_creation_timeout`, `payment_amount_tampered`).
- `test/webhooks-handler.test.ts` (10) — dedupe idempotency, order/customer upsert, attempt-number increment, the lifecycle/failures separation (asserts zero `failures` rows written on `subscription.pending`), missing-customer-id fallback.
- `test/webhooks-verify.test.ts` (6) — real HMAC signing against the actual `verifyWebhookSignature` wrapper: accepts valid, rejects wrong-secret/tampered-body/missing/empty/malformed signatures.

**Deliberate scope cut:** no live Fastify `inject()` round-trip test yet (would need a throwaway/in-memory DB wired into `server.ts`, which currently opens the real file DB at import time). The security-critical paths (signature accept/reject, dedupe, classification) are covered at the function level instead. Revisit when block 3's end-to-end spine needs a running server anyway.

**Not yet wired:** `payment.downtime.*` events are received and stored as raw rows but not consumed (`processDowntime` is a no-op beyond the dedupe insert) — matches spec §1.4 / cut-list item 7 ("consume it or drop it, don't reinvent `getMethodHealth`"). Decision on whether to consume it deferred to whenever policy/agent blocks need it, or dropped for good with a README note.

## Block 2 — policy engine P1–P14 + tests — not started

## Block 3 — end-to-end spine with stub strategy — not started

## Block 4 — live Razorpay wiring — not started (blocked on Subscriptions entitlement for Path A; Path B unblocked)

## Block 5 — Rules strategy — not started

## Block 6 — Agent strategy + system prompt — not started (needs `ANTHROPIC_API_KEY`, not yet in `.env`)

## Block 7 — SimWorld, oracle, configs A/B — not started

## Block 8 — eval runner — not started

## Block 9 — static HTML page — not started

## Block 10 — backfill script + kill-switch demo — not started

## Block 11 — README + demo rehearsal — not started

---

## Open questions / blockers for the user

- **`ANTHROPIC_API_KEY`** not set in `.env` — needed before block 6. Add whenever convenient; not on the critical path yet.
- **Subscriptions entitlement** — requested, unconfirmed. Re-check: `curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_KEY_SECRET" https://api.razorpay.com/v1/plans?count=1` (200 = unblocked).
