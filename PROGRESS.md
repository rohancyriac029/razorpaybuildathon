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
| `src/db/schema.ts` | 8 tables: `customers`, `orders`, `webhook_events` (dedupe), `failures`, `episodes`, `intents`, `eval_runs`, `llm_cache` |
| `src/db/client.ts` | better-sqlite3 + Drizzle, WAL mode, FKs on |
| `drizzle.config.ts`, `npm run db:push` | Reviewer setup: one command, zero external services |

**Verified:** `npx tsc --noEmit` clean. `npm run db:push` created all 8 tables against a fresh `salvage.sqlite`.

**Deliberate scope cut vs. spec:** no `contacts_log`/`executions_log` tables — P5/P10/P11/P12 caps will be computed by querying `episodes`/`intents` directly in block 2. Revisit only if that query becomes a measured bottleneck (it won't, at hackathon scale).

## Block 1 — taxonomy mapper + tests — not started

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
