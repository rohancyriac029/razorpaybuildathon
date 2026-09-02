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

## Block 2 — policy engine P1–P14 + tests ✅ done (2026-09-02)

Spec §4: deterministic, no LLM, `APPROVE | REJECT | MODIFY` with a rule id and reason, every verdict logged. Explicitly "cannot cut" / "your interview answer" per spec §10.

| File | What |
|---|---|
| `src/policy/rules.ts` | Pure function `evaluateProposal(proposal, ctx, snapshot, config) -> PolicyVerdict`. All 14 rules, zero DB access — testable with hand-built inputs only. |
| `src/policy/snapshot.ts` | The `PolicySnapshot` data shape rules.ts needs (counts, timestamps, flags) — decouples rule logic from how that state is gathered |
| `src/policy/gather-snapshot.ts` | DB-backed: derives the snapshot by querying `episodes`/`orders`/`intents` directly — **no separate counter state**, so there's nothing that can drift from the audit log a reviewer would replay |
| `src/policy/engine.ts` | `RulesPolicyEngine implements PolicyEngine` — wires rules.ts + gather-snapshot.ts behind the port; `policyConfigFromEnv()` reads `KILL_SWITCH`, `GLOBAL_EXEC_PER_HOUR`, `GLOBAL_CONTACTS_PER_DAY`, `STALENESS_CUTOFF_DAYS`, `VALUE_CEILING_PAISE` (added to `.env`/`.env.example`) |
| `src/util/ist.ts` | IST is UTC+5:30, no DST — computed directly. `isIstBlackoutHour` (P4), `istMidnightUtc` (P10's daily contact window) |

**Port change from block 0:** `PolicyEngine.decide()` now takes `{order, failure, now}`, not just a bare `Date` — P3 needs `failure.category`, P11 needs `failure.occurredAt`. Also **dropped `recordExecution()`** from the port entirely: since `decide()` re-derives all counters from `episodes` on every call, there's no separate state to record. `run.ts` updated to match (one fewer call, one fewer thing that could get out of sync).

**Rule-by-rule scope decisions** (each documented inline in `rules.ts`, not just here):

- **Evaluation order is fixed and tested**: P7 (idempotency) → P13 (kill switch) → P3 (TERMINAL) → P1 (max attempts) → P2 (min gap) → P11 (staleness) → P4 (blackout) → P5 (max contacts) → P12 (live link) → P6/P14 (amount) → P9 (value ceiling) → P10 (global caps) → P0 (approve). Tests assert precedence directly (e.g. P3 wins over P1 when both would fire) — this is exactly the kind of thing an interviewer probes, so it's provable, not asserted.
- **`MARK_TERMINAL`/`ESCALATE` bypass every rule except P7.** Per spec's own hard rules ("escalating is always safe"; markTerminal is the *required* response to TERMINAL) — blocking either would break triage during an incident for no safety benefit. Tested explicitly, including "approves escalate even under kill switch."
- **P9 (value ceiling) implemented as MODIFY, not REJECT** — spec says "above → escalate," so an over-ceiling proposal is rewritten into an `ESCALATE` proposal, which `run.ts` (block 0) already treats as a real non-recovery outcome. No `run.ts` changes needed; the port design from block 0 absorbed this for free.
- **P6/P14 amount check is genuinely unreachable through legitimate code**, and that's the point (spec §4.1.1: "P14 is the only rule that is not primarily a policy-engine check"). `Proposal` types carry no `amount` field at all — proven with a `@ts-expect-error` compile-time test, not just a runtime one. The P6/P14 runtime check exists purely as defense-in-depth against a future schema regression, and is exercised in tests via an unsafe cast that simulates exactly that.
- **"Executed" (for P1/P2/P5 budget purposes) means `execResult.ok === true`.** A P8 recheck that skipped execution because the order was already paid, or a genuine Razorpay API failure, burns neither a lifetime attempt nor a contact — nothing reached the customer or the card either way. Documented and tested (`gatherSnapshot` test: "counts only genuinely executed... not P8-skipped or failed ones").
- **P12 scoped to `PAYMENT_LINK` only, not `NUDGE`.** A nudge references a template, not necessarily a freshly-minted link; conflating the two would need a link-id relationship this build doesn't model. Documented as a scope decision, not an oversight.
- **P4 keys off the proposal's `sendAt`, not decision time** — a customer-facing action is rejected if it would *land* in the blackout window, even if decided at 3pm. `TOKEN_RETRY` is exempt (silent, no customer contact).

**Verified:** `npx tsc --noEmit` clean. 73/73 tests passing (up from 23):
- `test/policy-rules.test.ts` (42) — every rule's reject/approve boundary, the MARK_TERMINAL/ESCALATE bypass, and precedence ordering, all against hand-built snapshots (no DB).
- `test/policy-engine-integration.test.ts` (8) — `gatherSnapshot` against a real (in-memory, schema-migrated) DB: executed-vs-skipped counting, `lastExecutionAt`, `liveUnpaidLinkExists` flipping on `order.status`, cross-order global counting, and the full `RulesPolicyEngine` through the port, including a from-scratch P1 rejection built from 3 real DB rows.

**Known gap, honestly flagged:** `run.ts` still doesn't write to the `intents` table (only block 3's end-to-end spine will add that persistence). This means `gatherSnapshot`'s P7 idempotency-dupe check queries a table nothing populates yet in production — it's proven correct against hand-inserted rows in tests, but won't fire for real until block 3 wires up the logger. Not a design flaw: P7 is also enforced independently by the DB's `UNIQUE` constraint on `intents.idempotencyKey` (schema, block 0), so a real duplicate would fail loudly at insert time even before block 3 closes this gap — it just wouldn't get the friendlier "P7 REJECT" verdict path first.

## Block 3 — end-to-end spine with stub strategy ✅ done (2026-09-02)

Spec §6 block 3: "Fake webhook → decide → intent → executor → row in DB. First demoable artifact." This is the first point where blocks 0-2 actually connect and run for real.

| File | What |
|---|---|
| `src/context/assemble.ts` | `assembleEpisodeContext(db, orderId, now)` — turns an order + point in time into the `EpisodeContext` any `Strategy` needs. Deliberately minimal (matches the cut-list's pre-approved "last-3-payments" degradation, spec §10 item 6); the richer signal extraction is block 6/7's job, not the shared spine's. |
| `src/economics/constants.ts` | `ATTEMPT_COST_PAISE` / `CONTACT_GOODWILL_COST_PAISE` — placeholder cost estimates for the eval's "net ₹ recovered" metric (§5.4), explicitly flagged as unsourced round numbers to revisit, unlike the taxonomy's cited figures |
| `src/persistence/episode-logger.ts` | `makeEpisodeLogger(db, strategyName, runId)` — the concrete `EpisodeLogger` for `run()`. Writes every episode (including rejects) to `episodes`, and a matching row to `intents`. **Closes the gap flagged in block 2**: `intents` is now actually populated, so P7's idempotency check has real data to query in production, not just in tests. |
| `src/scheduler/virtual.ts` | `VirtualScheduler` — in-memory priority queue satisfying the `Scheduler` port; `advance(to)` fires due callbacks in order. `RealScheduler`/BullMQ deferred to block 4 (not needed until production wiring). |
| `src/strategies/stub.ts` | `StubStrategy` — always proposes a payment link at +2h. Not one of the five real baselines; exists only to prove the spine before Rules/Agent/Oracle exist (blocks 5-7). |
| `test/helpers/fake-world.ts` | Test-double `World` — records calls, returns canned `ExecResult`s. Not `RazorpayWorld` (block 4) or `SimWorld` (block 7). |

**Closed a gap flagged in block 1's notes:** `buildServer()` now takes an injectable `db` (defaulting to the real client), so tests can run the actual Fastify request lifecycle — real HMAC signature check, real dedupe, real classification — via `.inject()` against an in-memory database, instead of only unit-testing the handler functions directly.

**Real bug found and fixed while wiring this together:** `server.ts` was reading `RAZORPAY_WEBHOOK_SECRET` into a **module-level constant at import time**, not per-request. A test (or a secret rotation) that set the env var after the module was first loaded had no effect — the check silently used a stale/empty value. Moved the read inside the request handler. This would have been a real production footgun (secret rotation requiring a process restart, undocumented) had it shipped as-is; block 3's own test caught it immediately (first attempt: 401 when 200 was expected, on a correctly-signed request).

**Second bug the spine caught in its own tests:** used `new Date()` (real wall-clock time) instead of a fixed test clock for the P3/TERMINAL scenario's `now`. Since `StubStrategy` proposes a `sendAt` of `now + 2h`, this made P4's IST blackout-window check flaky depending on what time of day the test suite happened to run — a real class of bug (time-dependent test flakiness) rather than a logic error. Fixed by using a fixed, documented-safe timestamp, matching the convention already established in `test/policy-rules.test.ts`.

**Verified:** `npx tsc --noEmit` clean. 76/76 tests passing (up from 73) — `test/spine-e2e.test.ts` (3 new):
1. The full path: signed HTTP request → real route → real classification → `assembleEpisodeContext` → `StubStrategy` → `RulesPolicyEngine` (APPROVE) → `FakeWorld.createPaymentLink` → persisted rows in both `episodes` and `intents`, with the right verdict, execResult, and strategy name on each.
2. An invalid signature is rejected with 401 at the real HTTP boundary, and nothing is persisted — proving the fail-closed webhook boundary end-to-end, not just at the `verifyWebhookSignature` unit level (block 1).
3. **The demo's central beat** (spec §5.5, §8), proven for real rather than asserted: a `TERMINAL` failure, `StubStrategy` proposing a retry anyway (the adversarial case), the real `RulesPolicyEngine` catching it with `P3`, `FakeWorld` never touched, and the rejection landing in `intents` with `status: 'rejected'`.

Fastify's logger is now silenced under Vitest (`process.env.VITEST !== "true"`) — the pino JSON lines were cluttering test output with no diagnostic value for a passing suite.

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
