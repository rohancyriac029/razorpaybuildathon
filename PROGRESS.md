# Build progress

Tracks what exists against [salvage-v2-spec.md](salvage-v2-spec.md) §6 block order. Updated on every addition — check here before assuming something is or isn't built.

**Package manager: npm, not pnpm.** `corepack prepare pnpm` failed with `EPERM` on this machine (no admin rights to write `C:\Program Files\nodejs\yarn`). Functionally identical — `npm run eval` instead of `pnpm eval`. `package.json` scripts are the source of truth; the spec's `pnpm` references are cosmetic.

**Razorpay test key: works, Subscriptions not entitled.** Verified live 2026-09-02 (spec §0.1). `payments`, `payment_links`, `customers`, `invoices`, `items`, `settlements` all return 200. `plans` and `subscriptions` return 401 with a distinct error envelope (`{"error":"Unauthorized"}` vs. the real auth-failure shape) — that's a product gate, not a bad key. Activation requested; not yet confirmed. **Path B built (block 4)** — payment-link recovery on one-time payments, real API calls verified live. The S2S direct-card API is also 404 on this account (separate entitlement gap), and UPI Collect is deprecated as of 2026-02-28 — so triggering a real test failure needs a browser + one of the documented test cards (block 4's live demo recipe), not a fully headless script. This is what Razorpay's test mode is designed around, not a shortfall.

**LLM provider: Gemini (`gemini-3.5-flash-lite`), not Anthropic — a documented spec deviation.** User has no `ANTHROPIC_API_KEY`; has a free-tier Gemini key. Verified live 2026-09-02: real API key works, function-calling confirmed, 30 RPM / 1,500 req/day free tier (model line had already moved from 2.5→3.5 for new keys by the time this was checked — re-verify before relying on either number). Block 6 will build behind a provider-agnostic `LlmClient` interface so swapping back to Anthropic (the spec's documented default, kept as such in `.env.example`) is a one-line config change, not a rewrite.

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

## Block 4 — live Razorpay wiring (Path B) ✅ done (2026-09-02)

Spec §6 block 4, Path B: real webhook → real classification → real decision → real Payment Link, with execution genuinely deferred to the proposal's `sendAt` rather than firing immediately. Also closed a real architectural gap found while building this (see below) — that fix is arguably the most important thing in this block, more than the Razorpay wiring itself.

### What's verified live against the real account (2026-09-02)

| Call | Result |
|---|---|
| `POST /v1/orders` | ✅ 200, real order created |
| `GET /v1/orders/:id` | ✅ 200, `status` field confirmed (`created`\|`attempted`\|`paid`) — this is P8's entire mechanism |
| `POST /v1/payment_links` | ✅ 200, real `short_url` (`rzp.io/...`) |
| `POST /v1/payments/create/json` (S2S direct card) | ❌ 404 — **not enabled on this account**, same shape of gap as Subscriptions (§0.1): a product/feature needing separate entitlement, not a code bug |
| UPI Collect (`failure@razorpay` VPA) | ❌ **Deprecated by Razorpay as of 2026-02-28**, except narrow exemptions (IPO transactions, iOS apps, UPI mandates, eRupi vouchers, cross-border) we don't qualify for. This was the mechanism the *original* spec text assumed still worked — it doesn't anymore, verified against current docs, not assumed. |

**Conclusion: there is no fully headless, API-only way to trigger a real test-mode payment failure on a fresh account right now.** Razorpay's test mode is designed around the hosted checkout page — "a mock bank page with Success/Failure buttons," exactly as the original spec text describes — not around a scriptable S2S failure trigger. This isn't a shortfall in this build; both API-only routes that would have avoided a browser are independently closed off (one needs entitlement we don't have, the other was deprecated seven months ago).

### Real, documented test cards (fetched live from razorpay.com/docs, not guessed)

These map straight onto the taxonomy from block 1 — pay a real Payment Link with one of these to get a **real, genuine `payment.failed` webhook** with the stated `error_reason`:

| Card number | Network | `error_reason` | Taxonomy category |
|---|---|---|---|
| `4100 2800 0008 0001` | Visa | `insufficient_fund` | FUNDS |
| `4100 2800 0006 0003` | Visa | `card_declined` | TRANSIENT |
| `4100 2800 0000 0009` | Visa | `authentication_failed` | AUTH_ABANDONED |
| `4100 2800 0001 0008` | Visa | `card_number_invalid` | INSTRUMENT |
| `4100 2800 0002 0007` | Visa | `gateway_technical_error` | TRANSIENT |

Any future date, any CVV. **Note:** the docs page spells this `insufficient_fund` (singular) — the taxonomy (block 1) keys off `insufficient_funds` (plural), sourced from a different, more authoritative errors-reference page. Verify which one the actual webhook payload uses the first time this card is exercised for real, and fix the taxonomy key if it's actually singular — flagged here rather than guessed at.

No test card here produces `TERMINAL` — exercise that category via the existing unit/integration tests (blocks 1–3), not live.

### The live demo recipe (needs a human + a browser — this is not a gap, it's what test mode is for)

1. `cloudflared tunnel --url http://localhost:3000` (or ngrok) → gives a public URL.
2. Razorpay Dashboard → Webhooks → add `https://<tunnel>/webhooks/razorpay`, subscribe to `payment.failed` and `order.paid`, copy the webhook secret into `.env`'s `RAZORPAY_WEBHOOK_SECRET`.
3. `npm run dev` (starts the real server, wired to `RazorpayWorld` + `RealScheduler` + `RulesStrategy`).
4. Create a real order + Payment Link (via a small script using `RazorpayWorld`, or directly via the API).
5. Open the link's `short_url` in a browser, choose Card, enter one of the table above (e.g. the FUNDS one), submit.
6. Real `payment.failed` webhook fires → real classification → real decision, logged immediately → **scheduled for `sendAt`, not executed yet** (this is the fix below, and it's worth narrating in the demo: "the decision happened now, the link goes out at the time the rules engine actually chose").
7. For the demo, either wait for `sendAt` for real, or temporarily lower `GLOBAL_EXEC_PER_HOUR`/patch a short delay in for a live audience.

### The gap this block found and fixed: execution was ignoring `sendAt`

Building `RazorpayWorld` surfaced something bigger than the Razorpay wiring itself: `run()` (blocks 0–3) executed every approved proposal **immediately**, regardless of the `sendAt` the strategy proposed. That's harmless for a live demo (nobody wants to wait 2 real hours anyway) but it is **load-bearing for the eval** (blocks 7–8): the entire project's claim is that *timing* quality is what separates the agent from a cron, and if execution always happens "now," that claim becomes structurally unmeasurable — `VirtualScheduler.advance()` (block 3) would end up with no caller at all.

Fixed by splitting `src/run.ts`:

| Function | Does |
|---|---|
| `decide(strategy, policyEngine, ctx, log)` | PROPOSE → GATE → LOG. Logs immediately with `execResult: null, outcome: 'pending'`. Returns an `intentId` for execution-bound approvals. |
| `executeApproved(world, intentId, proposal, log, verdict, contextHash)` | P8 recheck → EXECUTE → LOG (update, not insert). Call this **at `proposal.sendAt`**, not before. |
| `run(...)` | Unchanged convenience wrapper: `decide()` then immediately `executeApproved()`. Right for the demo and any test that doesn't care about timing. The eval (block 8) will call `decide`/`executeApproved` directly, driven by the scheduler. |

Supporting pieces this required:
- `src/persistence/episode-logger.ts` now **upserts** on `intentId` — the same episode gets logged twice (decide-time, then execute-time-update) rather than duplicated. One row, patched, not two.
- `src/persistence/rehydrate.ts` — `rehydrateForExecution(db, intentId)` re-derives everything `executeApproved()` needs (proposal, verdict, contextHash) from the `episodes`/`intents` rows `decide()` already wrote. This is what makes a single, restart-safe scheduler dispatcher possible — it never needs to remember per-call context, only an `intentId` (spec §3.4: replayable from the DB, put to actual use).
- `src/scheduler/real.ts` — `RealScheduler`, `setTimeout`-based, satisfying the same `Scheduler` port as `VirtualScheduler`. **Not durable across restarts** — a real production deployment needs BullMQ/Redis for that (spec's own stack table calls this an acceptable simplification: "Redis becomes optional infrastructure"). Fine for a demo that runs continuously.
- `src/orchestration/decision-pipeline.ts` — `runDecisionPipeline` (context → decide → schedule) and `registerExecutionDispatcher` (the scheduler's one `onFire` callback, rehydrating by `intentId`).
- `src/server.ts` — `buildServer()` gained an optional `onPaymentFailed` hook, defaulting to a no-op so **all existing block 1–3 tests are untouched** (they don't pass it, so classification-only behavior is unchanged). Production's entrypoint constructs `RazorpayWorld` + `RealScheduler` + `RulesStrategy` + `RulesPolicyEngine` once and wires the hook for real.

**Second bug this surfaced, in testing the fix itself:** `.inject()` (Fastify's test harness) resolves once `reply.send()` fires — it does **not** wait for the async work the handler keeps doing afterward ("return 200 fast, process async," spec §3's own pipeline diagram). Block 3's spine test happened to work despite this because everything downstream of the response was synchronous under the hood; block 4's `decide()`/`scheduleAt()` are genuinely async, so the test's assertions were racing against still-pending work. Fixed in the test (capture the hook's promise, await it explicitly) — this is correct production behavior, not a bug to fix in `server.ts`.

**Third bug, a plain test bug:** `FakeWorld` originally took a single fixed `Order` at construction time, but the real internal `orderId` doesn't exist until webhook processing creates it — so a test that registers the scheduler dispatcher *before* the webhook fires can't know the id in advance. Redesigned `FakeWorld` to query the shared test `db` by id, mirroring `RazorpayWorld`'s real shape (minus the live round-trip), rather than holding one order. Updated all 5 call sites across 3 test files.

### `chargeToken` — written, unverified

`RazorpayWorld.chargeToken()` (the `TOKEN_RETRY` path) is built from the real `razorpay-node` SDK's own type definitions for `payments.createRecurringPayment`, not guessed. It has never been exercised against a real mandate token, because Subscriptions/recurring-payments entitlement is still unconfirmed (§0.1). Do not claim this path works live until it's actually run once.

### Verified

`npx tsc --noEmit` clean. **93/94 tests passing** (1 deliberately skipped by default):
- `test/world-razorpay-live.test.ts` — **gated behind `LIVE_RAZORPAY_TESTS=true`**, skipped in normal `npm test` runs so a reviewer never needs credentials to get a green suite. Run once for real this session: real order created, `getOrder` correctly reports live `created` status, real payment link created with a real `rzp.io` short URL.
- `test/run-decide-execute-split.test.ts` (2 new) — the load-bearing proof: nothing executes at decide-time or one minute before `sendAt`; advancing the scheduler past `sendAt` executes exactly once, updating the same episode/intent rows rather than duplicating them; `run()`'s synchronous convenience behavior is unchanged.
- `test/server-decision-wiring.test.ts` (1 new) — the full production shape end-to-end with test doubles: real signed webhook → real classification → real decision logged and scheduled → nothing executed for +23h → executed at +25h.

## Block 5 — Rules strategy ✅ done (2026-09-02)

Spec §5.3: "~150 lines... deterministic, auditable, free to run, never hallucinates." The real competitor in the eval (non-negotiable) and, per §3.1.1, the Agent's production fallback once block 6 exists.

| File | What |
|---|---|
| `src/strategies/rules.ts` | `RulesStrategy implements Strategy` — the exact branching from spec §5.3: `TERMINAL→stop`, `INSTRUMENT→link+2h`, `AUTH_ABANDONED→nudge, next 10:00-20:00 IST slot`, `TRANSIENT→+90m if downtime cleared else +6h`, `FUNDS→+48h, or +24h if IST day-of-month ≤7` |
| `src/policy/downtime-checker.ts` | Injectable `DowntimeChecker` interface + `UnknownDowntimeChecker` default. **Defaults pessimistic** (treats unknown as "still degraded," the longer +6h wait) rather than optimistic — matches the system's fail-closed posture elsewhere, and is honest about block 1's decision not to wire real `payment.downtime.*` consumption yet (no per-failure method tracking in this schema to key off of). Swappable later without touching the strategy's branching logic. |
| `src/messaging/templates.ts` | Minimal template catalogue (3 templates: `payment_retry_v2`, `auth_incomplete_v1`, `instrument_update_v1`) satisfying spec §4.5's "select a template, don't write copy freehand." **Deliberately does not yet include the P14 "trap" template** (`retry_with_offer`, spec §4.1.1/§5.5.1) — that belongs in block 6 alongside the Zod tool schema and runtime validator that actually enforce P14 against it; building it disconnected from that enforcement layer now would be untested, unlinked infrastructure. |
| `src/util/ist.ts` (extended) | Added `istDayOfMonth`, `nextIstClockTime(from, hour, minute)` — the salary-cycle and 10:00-20:00-slot logic block 5 needed |

**Verified:** `npx tsc --noEmit` clean. 90/90 tests passing (up from 76) — `test/strategies-rules.test.ts` (14 new): every category's branch, IST window boundaries in both directions (inside/before/after 10:00-20:00), the downtime-cleared/not-cleared/default-pessimistic split, the day-of-month boundary at exactly 7 vs 8, and a determinism check (same input → identical output, proving there's no hidden state).

**Not yet wired:** `RulesStrategy` isn't referenced anywhere outside its own tests yet — the production fallback wiring (§3.1.1: malformed/timeout/down → `Rules.propose()` instead of a dead-end escalate) is block 6's job, once the Agent strategy that needs a fallback actually exists.

## Block 6 — Agent strategy + system prompt ✅ done (2026-09-02)

Spec §6 Phase 5, §7 (system prompt). Real, live-verified multi-turn tool use — not mocked, not scaffolded.

| File | What |
|---|---|
| `src/agent/system-prompt.ts` | The full system prompt from spec §7, adapted for v2.1's P14 mechanism (structural refusal, not just instruction). No generator parameters — the firewall (spec §5.2 point 2) holds. |
| `src/llm/client.ts` | Provider-agnostic `LlmClient` interface: forced tool choice, `LlmTurn` (assistant tool-call / tool-result), an optional opaque `raw` field on `LlmToolCall` for provider-specific replay data |
| `src/llm/gemini-client.ts` | **Real, tested.** REST calls to `gemini-3.5-flash-lite`, JSON-Schema-to-Gemini-schema translation (lowercase → UPPERCASE type names) |
| `src/llm/anthropic-client.ts` | Spec's documented default provider, built from the well-known Messages API tool-use shape. **Untested** — no key. Swapping to it is `LLM_PROVIDER=anthropic` in `.env`, no code change. |
| `src/llm/factory.ts` | `llmClientFromEnv()` — the one place `LLM_PROVIDER` is read |
| `src/llm/cache.ts` | `CachingLlmClient` — spec §5.8's reproducibility requirement, keyed on `(model, systemPrompt, userMessage, tool names, turns, seed)`. Seed is in the key deliberately: keying only on the request would collapse the eval's 3 seeds onto one cached response, hiding variance instead of measuring it. |
| `src/agent/tools.ts` | The 7 tools: 2 read (`getFailureContext`, `getCustomerHistory`), 5 propose (`proposeTokenRetry`, `proposePaymentLink`, `proposeNudge`, `markTerminal`, `escalate`). Zod validation at the boundary; malformed input is refused with a message fed back to the model, not a hard failure. |
| `src/agent/agent-strategy.ts` | `AgentStrategy implements Strategy` — the multi-turn loop. Falls back to `RulesStrategy.propose()` (spec §3.1.1) on any error, including exceeding the step budget. |
| `src/messaging/templates.ts` (extended) | Added the P14 trap template (`retry_with_offer_v1`, carries `discount_pct`) and `isPriceBearingVar()` — a **pattern**, not a hardcoded id, so a future good-faith template addition can't accidentally reopen P14 by using a differently-named price-bearing variable. |

### The P14 trap, concretely

`retry_with_offer_v1` is in the catalogue — the agent can see it and reach for it. `buildProposalFromToolCall` in `tools.ts` checks every `proposeNudge` call against `isPriceBearingVar` on **both** the template's declared variables and whatever the model actually supplied (catching a price-bearing var smuggled onto an otherwise-legitimate template too). A match produces **no Proposal at all** — the call is refused with an explanation fed back as a tool_result, and `AgentStrategy.lastOfferAttempted` is set to `true` regardless of whether the model then corrects itself. This is the mechanism spec §5.5.1's metric reads from: "offers proposed" (this flag, across the eval) vs. "offers sent" (structurally always 0, since no Proposal was ever produced). Tested directly — see below.

### A real bug this found, undocumented anywhere researched

Building the Gemini client and running it live surfaced something the earlier research (block 4/5 era) didn't turn up: **Gemini's 3.x model line requires echoing back a `thoughtSignature` value on any replayed `functionCall` part in a multi-turn conversation**, or the API returns `400 INVALID_ARGUMENT` ("Function call is missing a thought_signature..."). This only surfaces on the *second* turn of a real multi-turn tool-use conversation — a single-call test (like the one that verified function-calling worked, back in the provider-decision phase) never exercises it. Fixed by adding an optional, provider-opaque `raw` field to `LlmToolCall` that `GeminiClient` populates from the response and replays on the next request; `AnthropicClient` and the fake test client simply ignore it. Caught immediately by the live test, not discovered later in the eval.

### Verified

`npx tsc --noEmit` clean. **105/107 tests passing** (2 gated behind live-credential env vars, same pattern as block 4):

- `test/agent-strategy.test.ts` (12) — the full loop against a scripted `FakeLlmClient`: happy paths (TRANSIENT→link, TERMINAL→markTerminal, escalate), the P14 trap firing and the model correcting itself in the same episode, a smuggled price-bearing variable on a legitimate template, a malformed tool call being refused and retried, an unknown tool name being refused with the real tool list, fallback-on-LLM-error, fallback-on-step-budget-exceeded (with an exact cross-check against calling `RulesStrategy` directly), and the read-tool result shape functions tested as pure functions, not mocked.
- `test/agent-strategy-live.test.ts` — **gated behind `LIVE_LLM_TESTS=true`**. Run once for real this session against a FUNDS scenario with two prior payments both landing ~20:00 IST: the agent investigated (multi-turn tool use, no mocking), correctly inferred the liquidity window from history, and proposed a payment link timed for 20:00 IST with substantive, specific reasoning — exactly the behavior spec §7's system prompt asks for, produced by a real model, not asserted.

**Production wiring completed in this block, not deferred:** `server.ts`'s entrypoint now constructs `AgentStrategy` (backed by `llmClientFromEnv()`) as the primary strategy, with `RulesStrategy` passed in as its fallback — completing what block 4 explicitly left as "a one-line change" once block 6 existed.

**Not yet wired:** `CachingLlmClient` exists and is tested at the unit level (implicitly, via its use of the same `llm_cache` table schema) but isn't yet threaded into `AgentStrategy`'s construction anywhere — that wiring, and the `seed` parameter that makes it meaningful, belongs to block 8 (the eval runner), which is the first place multiple seeds of the same scenario actually get run.

## Block 7 — SimWorld, generator, oracle, configs A/B ✅ done (2026-09-02)

Spec §5: "The eval — this is the whole project." The unobservable counterfactual (§5.1), generated and cited (§5.2), firewalled from the agent, with the oracle honestly scoped to what §5.6 demands.

| File | What |
|---|---|
| `src/eval/sources.ts` | Real citations, fetched live 2026-09-02: RetentionLens's *State of Involuntary Churn 2026* (recovery rates by approach: no-retry ~0-10%, fixed-interval ~20-40%, industry median ~47.6%, smart+card-updater 70-85%; smart timing lifts recovery ~25% over fixed), Baremetrics (9% MRR loss, 24-48h soft-decline resolution), Recurly (expired cards = single largest cause). **Explicitly separates cited facts from this build's own estimates** (category mix, salary-cycle mechanism) — three targeted fetches came back with no percentage breakdown at all, and that's stated as a finding, not silently patched over with an invented number. |
| `src/eval/generator-config.ts` | `CONFIG_A` (tuning) and `CONFIG_B` — exactly the three named, justified perturbations spec §5.7 asks for: liquidity days 1-7→25-31 (payroll convention), `AUTH_ABANDONED` share 0.15→0.30 (UPI-heavy cohort), downtime uniform→bursty (issuer incidents cluster) |
| `src/eval/rng.ts` | `mulberry32` seeded PRNG — same seed always produces the same scenarios *and* the same ground-truth randomness |
| `src/eval/scenario.ts` | The `Scenario` type: order/failure/customer-history fields a `Strategy` can see, plus hidden ground-truth fields (`liquidityHourIst`, `baseRecoveryProb`, `downtimeClearAtOffsetMs`) it cannot |
| `src/eval/generator.ts` | `generateScenarios(config, count, seed, anchorTime)` — pulls real `error_reason` values from the taxonomy (block 1) so a generated FUNDS scenario is guaranteed to classify back to FUNDS, not an invented string |
| `src/eval/ground-truth.ts` | `wouldSucceed(scenario, proposal, at, config)` — spec §5.1's counterfactual, and per §5.6, exactly what the oracle is `argmax` over. Lever-appropriateness × timing-appropriateness × base rate, with a seeded irreducible-random component |
| `src/eval/scenario-registry.ts` | Shared between `SimWorld` and `OracleStrategy` so both read the *same* scenario data — spec §5.6's claim only holds if there's no risk of two copies drifting apart |
| `src/world/sim-world.ts` | `SimWorld implements World` — resolves synchronously against ground truth instead of calling live Razorpay, updates `order.status` when `wouldSucceed` says yes |
| `src/strategies/no-retry.ts`, `fixed-interval.ts`, `oracle.ts` | The remaining 3 of the 5 required strategies (spec §5.3). `FixedIntervalStrategy` is deliberately category-blind, including on TERMINAL — the point is watching the real policy engine catch its mistakes too. `OracleStrategy` tries a small, ground-truth-informed candidate set (not brute-force search), which is what keeps "ceiling" meaningful instead of degenerating into RNG exploitation. |

### The firewall, checked, not just claimed

Spec §5.2 point 2: nothing in `system-prompt.ts` may reference generator parameters. Verified directly — `src/agent/system-prompt.ts` contains no numeric liquidity windows, no category-mix percentages, no config values. The system prompt says only "customers may have predictable liquidity windows; you have `getCustomerHistory`" (paraphrased from spec's own §5.2 wording), and block 6's live test already proved the agent can infer a real pattern from history data alone — that result is now doubly meaningful, since the pattern it inferred came from *this* generator, and the prompt never saw the generator's parameters.

### The oracle's scope, stated plainly (spec §5.6)

The oracle is not an exhaustive search. It tries a small number of ground-truth-snapped candidates per category — the same shape of guess a maximally-informed real strategy would make — and only ever *returns* a candidate it has verified succeeds against `wouldSucceed`. If none of its candidates work, it escalates. Tested directly: `strategies-baselines.test.ts` asserts every PAYMENT_LINK/NUDGE the oracle ever returns is a confirmed win, never a hopeful guess.

### Sanity-checked before building on top of it

Ran the generator at n=500 for both configs before writing tests, not after: category mix tracked config proportions within sampling noise, config B's `AUTH_ABANDONED` shift was visible, `TERMINAL` never succeeded (0/46, 0/50), and FUNDS success rates showed a genuine, substantial timing effect — well-timed proposals succeeded 4-7× more often than badly-timed ones (47.6%/54.5% vs. 11.1%/7.1% across configs A/B). The well-timed figure landing near RetentionLens's cited ~47.6% industry-median recovery rate is a coincidence worth noting, not something tuned to match — the generator was calibrated against the cited band before this check, not after.

### A real bug found while wiring `SimWorld`, and its fix

`generateScenarios` used `crypto.randomUUID()` for `customerId` and `new Date()` (unseeded) for `occurredAt`/history dates — silently breaking the determinism the module's own doc comment promised. Caught immediately by a determinism test (`generateScenarios(config, n, seed)` called twice with the same seed produced different output). Fixed: `customerId` is now derived from `(config.name, seed, index)`; `generateScenarios` takes an explicit `anchorTime` parameter (defaulting to the real clock only for ad hoc/manual use) that every scenario and history date is computed relative to, so any caller that cares about reproducibility supplies one.

**Second, related fix, in `run.ts` this time:** `executeApproved()` was stamping `intent.createdAt`/`execResult.executedAt` with real wall-clock `new Date()`. Harmless in production (`RealScheduler` fires close to real `sendAt` anyway), but wrong for the eval — `VirtualScheduler` fires at a *simulated* instant that can be simulated days from real "now," and `SimWorld` needs that simulated instant, not the process's real clock, to evaluate ground truth correctly. Fixed: the effective execution time is now `proposal.sendAt` itself, not `new Date()`. Caught and fixed before writing `SimWorld`, not after a confusing test failure inside it.

### Verified

`npx tsc --noEmit` clean. **126/128 tests passing** (up from 105; 2 gated behind live-credential env vars, unchanged from before):
- `test/eval-generator.test.ts` (8) — determinism, category-mix tracking, config B's shift, every generated `error_reason` round-tripping through the real taxonomy classifier, first-time-vs-repeat history shape, TERMINAL never succeeding, and the FUNDS timing-sensitivity effect asserted as a real, substantial ratio (not just "greater than").
- `test/sim-world.test.ts` (4) — order status flips to `paid` exactly when `wouldSucceed` says so (cross-checked against calling `wouldSucceed` directly, not a hardcoded expectation), `chargeToken` always fails with a stated reason, and — the load-bearing one — execution against a scenario whose ground-truth window is set far in *simulated* future time succeeds correctly, proving `SimWorld` reads `intent.createdAt` and not real wall-clock time.
- `test/strategies-baselines.test.ts` (7) — `NoRetry` always escalates, `FixedInterval` is category-blind including on TERMINAL, and three oracle-specific tests: markTerminal on TERMINAL, a genuine positive win-rate on FUNDS scenarios, and — most load-bearing — every PAYMENT_LINK/NUDGE the oracle ever returns is independently re-verified against `wouldSucceed` before the test accepts it.
- `test/sim-pipeline-integration.test.ts` (2, new) — the full chain for real: `decide()` → `VirtualScheduler.scheduleAt()` → `.advance()` → `executeApproved()` → `SimWorld` resolving against ground truth, with Oracle recovering strictly more than NoRetry (which recovers exactly zero, as designed) across 30 real generated scenarios; and `FixedIntervalStrategy`'s blind TERMINAL retry genuinely caught by the real `RulesPolicyEngine` (`P3`), not asserted against a mock.

**Not yet wired:** the eval runner itself (orchestration loop across 120 scenarios × 5 strategies × 3 seeds, metrics computation, the markdown table, the paired bootstrap) is block 8. `CachingLlmClient` (block 6) still isn't threaded into anything — block 8 is where seeds and caching actually matter. `RulesStrategy` (block 5) and `AgentStrategy` (block 6) aren't exercised against `SimWorld` yet in a test — only `NoRetry`/`FixedInterval`/`Oracle` were, since those three are new to this block; block 8's full run will exercise all five together as a matter of course.

## Block 8 — eval runner ✅ done (2026-09-03)

Spec §5's whole point, wired end to end and run for real: `npm run eval` produces a genuine markdown report from real executions — including real Gemini calls — not a mock. Also the most bug-dense block in this build: three real, load-bearing bugs found and fixed by actually running the thing twice, not by reasoning about it.

| File | What |
|---|---|
| `src/eval/run-episode.ts` | `runEpisode()` — one scenario through one strategy for one seed, up to 3 attempts (spec §3's real multi-attempt trajectory, not a single isolated decision). Reuses `assembleEpisodeContext` (block 3) for real. |
| `src/eval/orchestrator.ts` | `runFullEval()` — drives all 5 strategies across the replay set for every seed; `llmClient: null` skips `salvage-agent` cleanly (the other 4 still run) when no LLM credentials are available |
| `src/eval/metrics.ts` | `aggregate()` — spec §5.4's metrics, with §5.5/§5.5.1's TERMINAL and discount splits computed **per scenario** ("4/50"), not per attempt — a strategy that never learns can propose a TERMINAL retry on all 3 attempts of the same scenario, and spec's framing counts whether the scenario saw one, not how many |
| `src/eval/paired-bootstrap.ts` | Spec §5.8's paired bootstrap CI, seeded for reproducibility |
| `src/eval/aggregate-run.ts` | Glues orchestrator output → per-strategy report rows + the agent-vs-rules paired comparison |
| `src/eval/report.ts` | Pure markdown rendering — benchmark table, TERMINAL split, discount split, cost summary, paired-comparison sentence |
| `src/eval/llm-pricing.ts` | Gemini pricing ($0.30/$2.50 per M tokens) and USD→INR (₹95), both verified live 2026-09-02, both flagged to re-check before quoting in a demo |
| `src/eval/eval-db.ts` | Dedicated, self-bootstrapping, file-backed eval database — separate from dev `salvage.sqlite`, persists across runs on purpose (it carries the committed LLM cache) |
| `eval/run.ts` | The actual `npm run eval` entrypoint. `EVAL_CONFIG` (default B, the headline config), `EVAL_SCENARIOS` (default 120), `EVAL_SEEDS` (default 3) |

### Three real bugs, found by running it, not by reading it

**1. `runEpisode` crashed on `failures.eventId`'s foreign key.** Simulated failures need a matching `webhook_events` row first, exactly like a real webhook always gets via `dedupeAndStore` — I'd forgotten it for the synthetic path. Caught immediately by the first test run (100% of episode tests failed identically).

**2. Re-running the eval against the persisted DB crashed on a duplicate primary key.** `orderId` was originally derived from `(config, scenario, strategy, seed)` alone — deterministic within a run, but colliding across separate invocations of `npm run eval` against the same file. Worse than the crash: even with idempotent inserts, a second run would have inherited a stale `order.status='paid'` from the *first* run's recovery, silently corrupting the second run's P8 recheck before any real execution happened. Fixed by scoping `orderId` to the run itself (`runId`, which already includes a timestamp) — collision-free across runs, while the LLM cache (keyed independently by request content) is untouched by the change.

**3. The eval was not actually reproducible, and it took a real byte-for-byte diff between two live runs to find out why.** First fix attempt: the LLM cache key didn't include an episode-scoping component, so the *first* call of every episode — always identical (empty turns, fixed kickoff message) regardless of scenario — silently shared one cached response across different scenarios. Fixed by constructing one `CachingLlmClient` per scenario. That fix was necessary but not sufficient: a second live A/B run still diverged from the *second* call onward. Traced by dumping the actual cache table's contents in order and diffing two real runs' tool-call sequences by hand, then confirmed with a targeted repro script comparing `assembleEpisodeContext` output across two different `orderId`s for the identical scenario: `getCustomerHistoryResult` was returning `ctx.history` **including `customerId`** — an internal identifier with zero decision-relevant content, derived from the now run-scoped `orderId`, so it differed between runs and silently poisoned every cache key downstream of the second call. Fixed by stripping it in `tools.ts` (block 6) — the model never needed to see it. **Verified, not asserted:** two full live runs against Gemini, cold then warm — `56s` → `1.7s`, and the entire report (benchmark table, cost, paired bootstrap CI, every number) came back **byte-for-byte identical** except the elapsed-time line. That's spec §5.8's reproducibility bar, actually met, not just claimed.

### Rate limiting, added before attempting anything at scale

`AgentStrategy` falls back to `RulesStrategy` on *any* thrown error (spec §3.1.1) — including a 429. Without throttling, a real multi-hundred-call run would hit Gemini's 30 RPM free-tier cap partway through and silently replace agent episodes with Rules-strategy fallbacks, corrupting the exact numbers the eval exists to produce. Added a module-level throttle to `GeminiClient` (~24 RPM, under the cap) plus 429-specific retry with backoff, belt-and-braces. This also means the throttle is correctly shared across every `GeminiClient`/`CachingLlmClient` instance in the process, matching Google's own "limits apply per project" behavior.

### Verified

`npx tsc --noEmit` clean. **160/162 tests passing** (up from 132; 2 gated behind live-credential env vars, unchanged). New: `test/eval-paired-bootstrap.test.ts` (5), `test/eval-run-episode.test.ts` (6), `test/eval-orchestrator.test.ts` (3, including the determinism proof — seed 1/2/3 produce byte-identical outcomes for every deterministic strategy), `test/eval-aggregate-run.test.ts` (4), `test/eval-report.test.ts` (13), `test/llm-cache.test.ts` (3, a direct regression test for bug #3's fix — two different episode keys with byte-identical requests do NOT share a cache entry; the same key does).

**Real runs against Gemini, both documented above:** a 3-scenario/1-seed smoke test through the actual CLI (not a unit test) exercising every strategy including `salvage-agent`, and the cold/warm reproducibility A/B. Real, honest result worth keeping in mind for the demo: at n=3, `rules-engine` beat `salvage-agent` in the first run — exactly the "more likely outcome" spec §5.3 predicts, and not something to chase away by tuning.

### Not yet run: the real 120×3×5 headline eval

**Deliberately not executed yet**, to conserve Gemini's free-tier daily quota (1,500 requests) until it's wanted for real. Spec's own estimate is 700-900 model calls for a full run; at the ~24 RPM throttle that's roughly 30-45 minutes of wall-clock time. When ready:

```bash
npm run eval                              # config B (headline), 120 scenarios, 3 seeds — the default
EVAL_CONFIG=A npm run eval                # config A (tuning), for comparison
EVAL_SCENARIOS=20 EVAL_SEEDS=1 npm run eval   # a cheap, fast sanity check before committing to the full run
```

Run it once, then **commit `salvage-eval.sqlite`** (spec §5.8 — it carries the LLM cache; a reviewer reruns the identical table with no API key). Currently gitignored via the `*.sqlite` pattern (block 0) — that pattern needs a `!salvage-eval.sqlite` exception added once a real run is ready to commit; not added yet since there is nothing worth committing until then.

## Block 9 — static HTML page ✅ done (2026-09-03)

Spec §6 block 9: "Decision detail with full reasoning chain and policy verdict; eval scoreboard. One file, no framework." One HTML file with inline CSS/JS, fetching real data from two new read-only API routes on the existing Fastify server — no build step, no framework, no separate static-site generator.

| File | What |
|---|---|
| `public/index.html` | The page. Two tabs: **Decisions** (order list → click → full multi-attempt reasoning chain, each step showing the proposal, the policy verdict color-coded by kind, the exec result, and the outcome) and **Eval scoreboard** (the benchmark table + paired bootstrap sentence, rendered client-side from JSON, not server-rendered markdown) |
| `src/audit/decision-chain.ts` | `listOrdersWithEpisodes()` / `getDecisionChain()` — reads **production/demo episodes only** (`episodes.runId IS NULL`), explicitly excluding eval episodes so a 120×3×5 eval run's ~1800 synthetic orders don't drown out the handful of real demo decisions the page exists to show |
| `src/eval/latest-run-report.ts` | Reconstructs the same `StrategyReportRow[]` shape `aggregate-run.ts` produces from in-memory results, but from the **persisted** `eval_runs` table — one aggregation implementation serving both the CLI's stdout and the HTML page, not two that could drift apart |
| `src/server.ts` (extended) | Three new routes: `GET /` (serves the HTML file), `GET /api/orders`, `GET /api/orders/:id`, `GET /api/eval/latest` — all read-only, no auth (matches spec §11's "do not build: auth") |

### A real gap closed along the way: eval results were never persisted

Block 8 shipped `EpisodeRunResult` as an in-memory-only return value — the `eval_runs` table existed in the schema since block 0 but nothing ever wrote to it. This meant "replayable from the DB" (spec §3.4) was true for production episodes but not for eval results, and the HTML page's scoreboard would have had nothing to read once the CLI process exited. Fixed: added a `runId` column (groups one `npm run eval` invocation's rows so the page can find "the latest run"; needed a small migration, `drizzle/0001_crazy_sentinels.sql`), and `runEpisode` now writes one row per episode. `eval/run.ts`'s own stdout table and the HTML page's scoreboard are backed by the same underlying data, computed two different ways (in-memory vs. reconstructed-from-DB) — `test/eval-latest-run-report.test.ts` asserts they agree.

### Verified — not just written, actually served and fetched

- **Real HTTP, not just `.inject()`**: started an actual listening server (`app.listen()`) on a real port, seeded a real multi-attempt decision chain matching spec §3's own example dialogue almost verbatim ("bet on transient, link at +2h" → "I was wrong about transient — switching channel and targeting their historical 20:00 IST window"), plus a real `TERMINAL`-trap-rejected-by-P3 episode, plus a real (deterministic-only, no LLM) eval run — then hit `GET /`, `GET /api/orders`, `GET /api/orders/:id`, and `GET /api/eval/latest` with real `curl` requests and confirmed every response shape matches exactly what the page's client-side JS expects to consume.
- **Client-side JS syntax validated directly**: extracted the embedded `<script>` block and parsed it with `new Function()` — catches a syntax error the way a browser would, without needing a browser in this environment.
- `npx tsc --noEmit` clean. **175/177 tests passing** (up from 160; 2 gated behind live-credential env vars, unchanged). New: `test/eval-runs-persistence.test.ts` (2), `test/eval-latest-run-report.test.ts` (3, including the "reconstructs the same rows a fresh aggregation would" cross-check and the "picks the most recent run" case), `test/audit-decision-chain.test.ts` (5, including the production-vs-eval-episode exclusion and the multi-attempt chain ordering), `test/server-api-routes.test.ts` (5, real request/response round-trips through the actual server).

**Known limitation, stated rather than hidden:** `latestRunReport`'s TERMINAL-scenario detection is inferred post-hoc from `eval_runs` rows (a scenario is inferred TERMINAL if any strategy's row shows a nonzero `terminalRetriesProposed`/`Executed`), because the full `Scenario` — including its category — isn't persisted to `eval_runs` by design (it would mean storing the ground-truth answer key alongside the results, in tension with spec §5.2's firewall spirit). This undercounts TERMINAL scenarios where every strategy correctly avoided proposing a retry at all. The HTML page's scoreboard is a convenience view; `npm run eval`'s own stdout — computed from live `Scenario` objects with real categories — remains the authoritative table for the README.

## Block 10 — backfill script + kill-switch demo ✅ done (2026-09-03)

Spec §4.2's whole argument for P10/P11 existing at all: "Run [a backfill] with the wrong dates, or run it twice, and you ingest thousands of stale failures... Only a system-wide cap catches it. This is your kill-switch demo scenario." Either this script exists and actually gets caught by P10/P11/P13, or that's fiction. It exists, and all three are proven by real runs, not just unit tests.

| File | What |
|---|---|
| `src/backfill/ingest.ts` | `ingestBackfill(db, records, strategy, policy, world, log, now)` — the testable core: for each record, the SAME `dedupeAndStore` → `processPaymentFailed` → `assembleEpisodeContext` → `decide()` pipeline a real webhook goes through, then `executeApproved()` for anything approved and execution-bound (a backfill is "catch up now," not "schedule for later" — it doesn't wait for `sendAt`). Returns `BackfillStats` with a per-rule rejection breakdown. |
| `scripts/backfill.ts` | The CLI shell. `--simulate N [--stale-days D]` (synthetic records — the test account is fresh and has no real failure history to pull) or `--from/--to` (real `rzp.payments.all()`, filtered to `status === "failed"`). `KILL_SWITCH=true` env var demos P13. Simulate mode uses an inline `SimulatedWorld` (reports `ok:true` without hitting the network, since simulated order ids don't exist in Razorpay); real mode uses the actual `RazorpayWorld`. |
| `test/backfill-ingest.test.ts` | 7 tests: P11 catches all 20/20 stale (240-day) failures and none of 5 fresh ones; P10 catches exactly `12 - 5 = 7` rejections with the cap set to 5 (12 fresh, distinct-order records — proving P1 alone does nothing here, every order is on attempt 1); with the cap effectively disabled all 50 pass, proving P1's blindness to this failure shape is real, not assumed; running the same 10 records twice dedupes to 0 new ingestion the second time; P13 rejects all 8 outright; a real order+failure row is actually persisted per record. |

### Three layered bugs, found in the order P10/P11 actually depend on them

Getting the P10/P11 test suite green required fixing three separate, stacked timestamp bugs — each one hid the next until the previous was fixed:

**1. `processPaymentFailed` stamped every failure's `occurredAt` with processing time (`now`), not the webhook's own `created_at`.** Harmless for a real live webhook (the two times are near-identical), but it silently defeated P11's staleness check for anything backdated — exactly what a backfill does on purpose. Fixed in `src/webhooks/handler.ts`: `occurredAt` now derives from `body.created_at` (Unix seconds) when present, falling back to `now` only if it's missing.

**2. After fixing #1, the P10 test still failed (`expected 12 to be 5`).** `makeEpisodeLogger` (`src/persistence/episode-logger.ts`) always used real wall-clock `new Date()` for `episodes.createdAt`/`intents.createdAt`, on both the decision-time insert and the execution-time update. A backfill test running against a fixed past `NOW` had its rows stamped with today's real date — so P10's "executions in the last hour relative to `now`" window never matched any of them, undercounting every time. Fixed by using `entry.execResult?.executedAt ?? entry.proposal.proposedAt` instead — whatever "now" the caller is actually operating on (matters equally for the block 7/8 eval's `VirtualScheduler`, which this same logger serves).

**3. After both fixes, the P10 test STILL failed with the identical numbers.** Root cause: `ingestBackfill` originally only called `decide()`, never `executeApproved()` — so no execution ever had `execResult.ok === true`, and `gatherSnapshot`'s "was this really executed" filter excluded every single row from P10's count, regardless of the first two fixes. Fixed by giving `ingestBackfill` a `World` parameter and calling `executeApproved()` for every approved, execution-bound decision (`BackfillStats` gained a separate `executed` field, distinct from `approved`, since MARK_TERMINAL/ESCALATE proposals are "approved" but never execution-bound).

### A fourth thing, caught live rather than by a test

The first live run of `scripts/backfill.ts --simulate 30` (default demo, meant to show P10) came back with **all 30 rejected via P4**, not P10. Root cause: the default synthetic `errorReason` (`gateway_technical_error`) classifies as TRANSIENT, whose rules-engine proposal fails closed to a +6h delay when downtime status is unknown (`src/strategies/rules.ts`) — and the script happened to run at 18:47 IST, so +6h landed at 00:47 IST, squarely inside P4's 22:00–08:00 blackout window. Correct policy behavior, but wall-clock-dependent and useless as a repeatable P10 demo. Fixed by switching the demo's synthetic `errorReason` to `authentication_failed` (AUTH_ABANDONED), whose NUDGE proposal's `sendAt` is explicitly clamped to the 10:00–20:00 IST window regardless of what time the script runs — makes the P10/P11/P13 demos deterministic at any hour.

### Verified — three real live runs, not asserted

```
npx tsx scripts/backfill.ts --simulate 30                  # P10: 20 approved/executed, 10 rejected — all via P10
npx tsx scripts/backfill.ts --simulate 30 --stale-days 240  # P11: 0 approved, 30 rejected — all via P11
KILL_SWITCH=true npx tsx scripts/backfill.ts --simulate 30  # P13: 0 approved, 30 rejected — all via P13
```

All three ran against the real dev SQLite DB through the real CLI process (not `.inject()`, not a unit test), each producing exactly the rejection pattern spec §4.2 predicts for that scenario. `npx tsc --noEmit` clean. **182/184 tests passing** (up from 175; 2 gated behind live-credential env vars, unchanged) — new: `test/backfill-ingest.test.ts` (7). Demo SQLite artifacts (`salvage.sqlite*`) deleted after verification, consistent with block 9's cleanup pattern.

## Block 11 — README + demo rehearsal ✅ done (2026-09-04)

Spec §6 block 11, §9's README structure. The final block — and the one that forced the build's biggest real detour: getting an actual, live-generated benchmark table required solving a genuine LLM-provider infrastructure problem discovered only by trying to run the headline eval for real.

| File | What |
|---|---|
| `README.md` | The spec §9 structure, all 12 sections, with real data everywhere a placeholder would otherwise be — see below for how each real number was obtained |
| `src/llm/ollama-client.ts` | A third `LlmClient` implementation — local, free, no quota — added specifically because Gemini's real daily quota blocked finishing the headline eval |
| `src/llm/factory.ts` | `llmClientFromEnv()` gained `LLM_PROVIDER=ollama` |
| `.env.example` | Documents the real (corrected) Gemini quota number and the new Ollama option |
| `.gitignore` | `!salvage-eval.sqlite` exception added — the eval DB (with its LLM cache) is now committed, per spec §5.8 |

### The chain of real problems, in the order they were actually hit

**1. Gemini's free-tier daily quota is 500 requests/day, not 1,500.** The 1,500/day figure recorded in block 6/8 was wrong (or the limit changed) — found by attempting the real 120×3 headline eval twice and watching it die. First attempt (`nohup ... &` detached from the tool's own background tracking) got silently killed by an environment quirk around 490/1800 episodes with no error — a process-lifecycle problem, not a code bug, fixed by using the Bash tool's native `run_in_background` instead of manual `nohup`/`disown`. The second attempt, run correctly, hit a real wall: a direct API call confirmed `429 RESOURCE_EXHAUSTED`, `quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier`, `quotaValue: 500`. Exhausted for the day by this build's own cumulative smoke-testing (blocks 6/8/9/10) plus the two eval attempts.

**2. Local Ollama was the obvious fallback — and the first model tried genuinely failed.** `llama3.2:3b` (already present locally) passes a single-call tool-use test but **cannot sustain this build's multi-turn, schema-strict agent loop**: verified live, it reliably drops out of tool-calling mode into plain prose by turn 2–3, and — more fundamentally — invents wrong field names (`template`/`variables` instead of the schema's `templateId`/`vars`) even after being shown the exact Zod validation error naming the missing field. Ollama also does not support forcing tool choice at the API level (`tool_choice: "required"` is silently ignored, unlike Gemini's `mode: "ANY"` or Anthropic's `tool_choice: {type: "any"}`) — confirmed by direct API test, not assumed. Two mitigations were built into `ollama-client.ts` regardless (a textual "call a tool now" reminder appended to every tool result; a last-resort regex extractor for a JSON-shaped tool call embedded in a prose response) since they're standard, honest practice for local models and meaningfully reduce — without ever fully fixing — this failure mode for a 3B model.

**3. `qwen2.5:7b` (pulled after checking real hardware: RTX 4050 laptop GPU, 6GB VRAM via `nvidia-smi` — `AdapterRAM` via WMI is a known-unreliable source for cards over 4GB, confirmed different/wrong) passed cleanly.** 4/4 consecutive live runs of the same test that broke `llama3.2:3b`: no fallback, valid proposals, substantive timing-aware reasoning genuinely referencing the injected customer history. This became the model actually used for the reported numbers.

**4. Real-world throughput was much slower than a single isolated call suggested.** One live call: ~6–7s. Under real full-eval load (accumulating multi-turn context across genuinely varied scenarios): degraded to ~17–34s/episode. A full 120×3 (1,800-episode) run was projected at 5–6+ hours on this hardware — not workable in the time remaining. Cut to a **20-scenario, 1-seed** reduced run instead, per the user's explicit instruction and consistent with spec §10's own pre-approved cut-list philosophy ("say plainly you ran out of time").

**5. A real, serious bug found while sanity-checking the reduced run's first result: every strategy, including the oracle, showed exactly 0.0% recovery.** Not plausible — an oracle that recovers *nothing* across 20 scenarios contradicts its own design (argmax over a `wouldSucceed` function with category base rates of 35–75%). Root-caused by direct DB inspection, not guesswork: `salvage-eval.sqlite` is a **persistent, intentionally-never-wiped file** (it carries the committed LLM cache, spec §5.8) that had accumulated **10,292 episode rows** — including **2,823 P10 rejections** — from the earlier killed full-scale attempts. P10 (global execution cap) queries system-wide `episodes` state with no `runId` scoping (correct, intentional design for *production*, spec §4.1: the cap must see every execution regardless of which code path proposed it) — but every accumulated episode was timestamped around the same fixed `EVAL_ANCHOR_TIME`, so the cap was already blown before the reduced run's own first episode was ever evaluated. Confirmed via a controlled A/B: config B against a **fresh** DB gave sane, reproducible numbers (rules-engine 40%, oracle 15%, twice, byte-identical) on the very same 20 scenarios; the same config against the **polluted** file gave 0% for everyone. **Not a code bug** — P10 did exactly its job — but a real operational gap: repeatedly re-running `npm run eval` against the one persistent, committed eval DB file eventually starves every future run via its own historical executions. Fixed pragmatically for this submission: wiped `episodes`/`intents`/`orders`/`failures`/`webhook_events`/`customers`/`subscriptions`/`eval_runs` while explicitly preserving `llm_cache` (1,490 real cached responses kept, zero re-spent quota) — the policy-relevant state resets, the expensive-to-regenerate LLM cache doesn't. **Flagged here rather than quietly fixed**: a real headline-scale run, done once without interruption, would never hit this — it's an artifact specific to this build's own repeated killed-and-restarted attempts, not a latent flaw a reviewer would hit running the committed reproduction command once.

### The result actually reported

Config B, 20 scenarios, seed 1, real `qwen2.5:7b` calls (not scripted/mocked): rules-engine 40.0% recovery / ₹6,066 net; salvage-agent 15.0% / ₹1,005; oracle (ceiling) 15.0% / ₹1,276. Paired bootstrap, agent vs. rules: −₹253.05/episode, 95% CI [−₹522.85, −₹34.20] — **excludes zero, rules-engine wins at this sample size**. Reported as-is, per spec's explicit instruction not to tune the generator until the agent wins — README §10 gives a data-grounded theory (contacts/recovery: 4.00 for the agent vs. 2.25 for rules — the agent isn't failing to recover, it's spending nearly 2x the customer touches per success) rather than hiding the result. Also documented honestly: rules-engine's ₹6,066 exceeding the oracle's ₹1,276 produces a >100% "oracle headroom" figure (475.4%) — not a bug (confirmed: `oracleHeadroomPct = strategyNet / oracleNet * 100`, uncapped by design), but exactly the oracle limitation spec §5.6 pre-warns about and asks to be owned in the README, not hidden.

### Two more real bugs, found by actually running the demo path — both in the production entrypoint

Writing the demo seeder meant running `npx tsx src/server.ts` (what `npm run dev` runs, and what README §6/§11 tell a reviewer to run) for the first time as a *process* rather than via `buildServer()` in a test. It did not work, for two stacked reasons — the second hidden entirely behind the first:

**1. The main-module guard never fires on Windows, so `npm run dev` silently starts nothing.** `src/server.ts` used the common idiom `import.meta.url === \`file://${process.argv[1]}\``. On Windows `import.meta.url` is `file:///D:/razorpay/src/server.ts` while `process.argv[1]` is `D:\razorpay\src\server.ts` — different separators, different slash count, so the comparison is *always* false. The server exited 0 with no output and no error, which is the worst possible failure mode: it looks like it worked. Proven directly (a 4-line script printing both values and both comparisons) rather than assumed, then fixed with `node:url`'s `pathToFileURL`, which normalises drive letters and separators on every platform. **Every block-9 "real HTTP" verification had gone through `buildServer()` or `app.listen()` directly, so nothing had ever exercised this line.**

**2. The entrypoint never loaded `.env`.** Only visible once the guard was fixed and the block actually ran: it died on ``Error: `key_id` or `oauthToken` is mandatory`` because `RAZORPAY_KEY_ID` was never read. `eval/run.ts` and `scripts/backfill.ts` both call `process.loadEnvFile(".env")`; the production entrypoint alone did not. Fixed to match.

Together these meant the single command the README hands a reviewer for the live demo could not start. Now verified end to end: real server listening on :3000, real `curl` against `/api/orders` and `/api/orders/:id` returning all three seeded decision chains with correct verdicts.

### Demo assets (spec §6 block 11's other half: "rehearse twice")

| File | What |
|---|---|
| `scripts/seed-demo.ts` (`npm run seed:demo`) | Seeds spec §8's beats **through the real pipeline** — real `processPaymentFailed` classification, real `RulesPolicyEngine`, real `decide()`/`executeApproved()` — never hand-written rows. Three beats: the 1:30–3:00 TERMINAL trap (`debit_instrument_blocked`, deliberately the most "dressed as recoverable" TERMINAL reason, with `FixedIntervalStrategy` proposing a retry anyway and **P3 rejecting it**); a normal TRANSIENT→link recovery; and the **P8 race** (order marked paid between `decide()` and `executeApproved()`, caught by the pre-execution recheck — spec §8 calls this "the most convincing of the three"). Idempotent: re-running dedupes at the webhook layer. |
| `DEMO.md` | The 5-minute runbook: every beat with its command and what to say, plus the three graceful failures and four sharp-edged questions with honest answers — explicitly including "my agent loses to the rules engine," the n=20 caveat, the oracle-is-my-own-generator caveat, and the fact that the offer trap reads **0/20 proposed** in this sample rather than the "6 attempts blocked" spec §8's template optimistically assumes. |

Real run output, all three beats behaving as designed: TERMINAL→`PAYMENT_LINK` proposed→`REJECT (P3)`; TRANSIENT→`PAYMENT_LINK`→`APPROVE (P0)`→`executed ok=true`; and the race→`APPROVE (P0)`→`executed ok=false — P8 recheck: order already paid, execution skipped`.

### Verified

`npx tsc --noEmit` clean. **186/188 tests passing** (up from 182; 2 gated behind live-credential env vars, unchanged) — new: `test/eval-reset-state.test.ts` (4). The reduced-scope eval command in README §11 was run for real four times across this block (twice exposing the P10-pollution bug, twice clean and byte-identical), and the full demo path — seed → `npm run dev` → real `curl` against the live server — was exercised end to end after the two entrypoint fixes.

### The starvation bug, fixed in code — and a wrong diagnosis corrected

Re-running the exact reproduction command initially did **not** replay from cache, and my first diagnosis was **wrong**: I attributed it to `qwen2.5:7b`'s sampling not being pinned to zero temperature, and softened the README's reproducibility claim accordingly. That was the wrong root cause. The real one is the P10 pollution described above, one step further down the chain: with a polluted database, P10 **rejects** proposals it would otherwise approve → different verdicts → a different `turns` array fed back to the model on the next turn → a different cache key → a miss, cascading through the rest of the episode. The cache was never the problem; the decisions upstream of it were.

Fixed properly rather than documented as a limitation:

| File | What |
|---|---|
| `src/eval/reset-state.ts` | `resetEvalState(db)` — clears every policy-relevant table (`intents`, `episodes`, `eval_runs`, `failures`, `orders`, `subscriptions`, `webhook_events`, `customers`) while explicitly preserving `llm_cache`. Deliberately NOT wired into `makeEvalDb`, so a mis-set `EVAL_DB` can never implicitly destroy a real database — only the eval CLI calls it. |
| `eval/run.ts` | Calls it at the start of every run and reports what it cleared |
| `test/eval-reset-state.test.ts` | 4 tests. The two load-bearing ones don't test the delete statement — they run `runFullEval` **twice against the same database** and assert the real property: without a reset the second run's oracle recovers **exactly 0** (the bug, reproduced in a test), and with a reset the second run's full per-strategy recovered-vector is **identical** to the first (the fix). |

**Verified after the fix, by running the committed reproduction command twice back to back**: each run completes in **1 second making zero LLM calls**, and the two reports are byte-for-byte identical — every recovery rate, every ₹ figure, the paired-bootstrap CI — differing only in the run id and the count of rows cleared. That is spec §5.8's actual bar ("a reviewer reruns the identical table with no API key"), now met with a local model and no network access at all. README §11's claim was restored to the strong version because it is now true and tested, not because it reads better.

---

## Open questions / blockers for the user

- **`ANTHROPIC_API_KEY`** not set in `.env` — needed before block 6. Add whenever convenient; not on the critical path yet.
- **Subscriptions entitlement** — requested, unconfirmed. Re-check: `curl -s -u "$RAZORPAY_KEY_ID:$RAZORPAY_KEY_SECRET" https://api.razorpay.com/v1/plans?count=1` (200 = unblocked).
