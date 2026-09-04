# salvage

Razorpay AI Buildathon submission — AI Revenue Recovery track.

## 1. The problem

Involuntary churn — a subscription payment that fails silently — accounts for 20–40% of total SaaS churn, and the median company loses ~9% of MRR to it. Razorpay retries a subscription charge automatically and halts after four consecutive failures, but *when* and *how* to re-engage the customer once that happens is left to the merchant. `salvage` is a decision layer that sits on top of that gap: it classifies why a payment failed, decides whether and when to re-approach the customer, and enforces hard limits on that decision so an LLM is never the last word on whether money moves or a customer gets contacted.

## 2. What this is, honestly

`salvage` is an LLM agent that proposes a recovery action, in front of a deterministic policy engine (14 rules, zero LLM involvement) that alone decides whether that action executes. Verified live against **Gemini** (`gemini-3.5-flash-lite`) and, once Gemini's free-tier daily quota ran out mid-build, against a **local Ollama model** (`qwen2.5:7b`) — both behind the same provider-agnostic interface, proving the "swap providers in one line" design claim for real, under real pressure, not just in theory. **The rules-engine baseline — no LLM at all — recovers most of the achievable value on its own.** The honest headline is below, in the first screen, not buried:

<!-- BENCHMARK_TABLE -->

**Sample size, stated plainly**: 20 scenarios, 1 seed — not the full 120×3 headline config. Gemini's free-tier daily quota (500 requests/day for this model, confirmed live via a real `429 RESOURCE_EXHAUSTED` response) was exhausted by this build's own smoke-testing before a full run could complete; the local fallback works but is slow enough (~30s/episode under real multi-turn load) that a full 1,800-episode run would take several hours on this hardware. Rather than either wait it out or fabricate a bigger sample, this table is what the LLM actually produced, honestly labeled as a smaller n. See §11 for the exact commands to reproduce or extend it.

The LLM earns its place in two places: picking a timing/channel that fits a specific customer's payment history (config B's shifted liquidity window is designed to test exactly this), and writing a merchant-facing rationale a human can audit. Everything else — the actual retry/nudge/link decision boundaries, every safety limit — is deterministic rules, on purpose. Overclaiming what the model actually contributes is the fastest way to lose an argument about a system that moves money; the rules engine existing as a real, measured competitor (not a strawman) is the point, not a hedge.

## 3. Architecture

Three ports, one shared pipeline, used identically by production and the eval:

```
Strategy.propose(ctx) -> Proposal          # LLM agent OR one of 4 deterministic baselines
PolicyEngine.decide(proposal, ctx) -> Verdict   # 14 rules, pure function, no LLM
World.execute(intent) -> ExecResult        # real Razorpay API, or SimWorld for the eval
```

`src/run.ts` is the one place these compose: `decide()` (PROPOSE → GATE → LOG) and `executeApproved()` (P8 live-status recheck → EXECUTE → LOG). Production calls both immediately via `run()`; the eval calls them separately, driven by a `Scheduler` (`RealScheduler` in production, `VirtualScheduler` in the eval) that fires execution at the proposal's own `sendAt` — not immediately. That split exists because **the eval's entire claim is about timing quality**, and if execution always happened "now," that claim would be structurally unmeasurable.

The eval does not reimplement the pipeline for speed or convenience — it runs `assembleEpisodeContext` → `decide` → `executeApproved` through the identical functions production uses, against a `SimWorld` instead of `RazorpayWorld`. A bug in the real pipeline shows up in the eval; a bug found by the eval is a bug in production.

## 4. The constraint I found

Razorpay's Payments API cannot re-charge a failed one-time payment — there is no "retry this card" endpoint. What actually executes:

- **A confirmed recurring-payment mandate token** (subscriptions): retry via create-order + create-recurring-payment. This is the one case where `salvage` silently re-attempts a charge.
- **Everything else**: a fresh Payment Link, or a nudge containing one — the customer re-enters the flow, `salvage` never re-presents old card data.

The sharper version: Razorpay already retries a subscription charge daily and halts after four consecutive failures — by the time a subscription reaches `halted`, the customer has been silently auto-debited three times and Razorpay has given up. **`subscription.pending → halted` is exactly the window `salvage` lives in.** Razorpay owns the debits; `salvage` owns when and through which channel the re-payment path appears in front of the customer. That's a narrow scope, and it's the true one.

A second, unplanned constraint surfaced while building the live path: there is no fully headless, API-only way to trigger a real test-mode payment failure on a fresh account. The S2S direct-card API (`/v1/payments/create/json`) is 404 on this account (a separate entitlement gap, same shape as Subscriptions below); UPI Collect — the mechanism the original build plan assumed — was deprecated by Razorpay in Feb 2026. Test mode is built around the hosted checkout page with documented test cards, not a scriptable failure trigger, so triggering a real failure needs a browser (see §6 below) — this is what test mode is designed around, not a shortfall in this build.

## 5. Benchmark table [synthetic]

Config B (three named, cited perturbations from config A: liquidity mass shifts to days 25–31, category mix shifts toward `AUTH_ABANDONED`, downtime pattern shifts uniform→bursty). **n=20 scenarios, 1 seed** — a reduced sample, not the full 120×3 headline run; see §2's caveat for why. Live model: local `qwen2.5:7b` via Ollama.

| Strategy | Recovery rate | Net ₹ recovered | Wasted attempts | `TERMINAL` proposed | `TERMINAL` executed | Offers proposed | Offers sent | Contacts/recovery | % oracle headroom |
|---|---|---|---|---|---|---|---|---|---|
| No retry | 0.0% | ₹0.00 | 0 | 0/1 | 0/1 | 0/20 | **0** | — | 0.0% |
| Fixed 24h × 3 | 0.0% | ₹0.00 | 0 | 1/1 | 0/1 | 0/20 | **0** | — | 0.0% |
| **Rules engine** | 40.0% | ₹6,066.00 | 10 | 0/1 | 0/1 | 0/20 | **0** | 2.25 | 475.4% |
| **salvage agent** | 15.0% | ₹1,005.00 | 13 | 0/1 | 0/1 | 0/20 | **0** | 4.00 | 78.8% |
| *Oracle (ceiling)* | 15.0% | ₹1,276.00 | 0 | 0/1 | 0/1 | 0/20 | **0** | 1.00 | 100% |

**On rules-engine's 475.4% "headroom"**: this is real, not a rendering bug. §7 explains why — the oracle here is a bounded heuristic search, not a brute-force optimum, and can legitimately be beaten in raw ₹ terms by a real strategy on a small sample. Read it as "rules-engine happened to outperform this build's own approximate ceiling at n=20," not as rules-engine exceeding some absolute maximum.

**TERMINAL split** (spec §5.5 — "worth ten times a zero"): every strategy proposed 0/1 TERMINAL retries except `fixed-24h` (1/1 proposed, 0/1 executed — caught by P3, exactly the trap this metric exists to catch). No strategy, including the LLM, ever let a TERMINAL retry actually execute.

**Discount/offer split** (spec §5.5.1, P14): 0/20 offers proposed by any strategy at this sample size — the `retry_with_offer_v1` trap template exists in the catalogue and is structurally blocked (§9), but no episode in this particular 20-scenario sample happened to reach for it. Not evidence P14 is untested — `test/agent-strategy.test.ts` exercises the trap directly with a scripted model that does reach for it.

**Cost, including LLM tokens** (spec §5.4):

| Strategy | LLM cost (total) | Cost per ₹100 recovered |
|---|---|---|
| No retry / Fixed 24h / Rules engine / Oracle | ₹0.00 | — |
| **salvage agent** | ₹9.45 (notional) | ₹0.88 (notional) |

**On the "notional" label**: this run's actual LLM (`qwen2.5:7b`) runs locally — its real marginal cost is ₹0.00. The ₹9.45 figure is `qwen2.5:7b`'s real token counts priced at Gemini's per-token rate (`src/eval/llm-pricing.ts` has no local-model pricing table), computed purely so this column stays comparable to a paid-API run. Stated honestly rather than left ambiguous: this number answers "what would this have cost on Gemini," not "what did this cost."

**salvage-agent vs rules-engine — paired bootstrap** (spec §5.8): over 20 matched (scenario, seed) pairs, mean difference **−₹253.05 per episode**, 95% CI **[−₹522.85, −₹34.20]**. The interval excludes zero — **rules-engine wins at this sample size**, distinguishably from noise, not just on the point estimate.

**This is being reported, not tuned away.** Per spec's own instruction: "if salvage does not beat the rules engine, report it... interviewers can smell a rigged benchmark." §10 gives the real, data-grounded theory for why.

**Every number above is [synthetic]** — generated by this repo's own ground-truth simulator, not observed production data. That distinction matters and is not softened anywhere in this document.

## 6. Live test-mode recoveries [live test-mode]

Real API calls verified against a real Razorpay test account, 2026-09-02–03 (not mocked, not `.inject()`-only):

| Call | Result |
|---|---|
| `POST /v1/orders` | 200, real order created |
| `GET /v1/orders/:id` | 200, `status` field (`created`\|`attempted`\|`paid`) — this is P8's entire mechanism |
| `POST /v1/payment_links` | 200, real `short_url` (`rzp.io/...`) |
| Real signed webhook → classify → decide → schedule → execute at `sendAt` | End-to-end, through the actual production entrypoint, real HMAC signature |

**Live demo recipe** (needs a browser — see §4's note on why):
1. Tunnel `localhost:3000` (cloudflared/ngrok), register the webhook URL in the Razorpay dashboard, copy the webhook secret into `.env`.
2. `npm run dev` — real server, wired to `AgentStrategy` (LLM primary, `RulesStrategy` fallback) + `RazorpayWorld` + `RealScheduler`.
3. Create a real order + Payment Link, open it, pay with one of the documented test cards below, submit.
4. Real `payment.failed` webhook fires → real classification → real decision, logged immediately, scheduled for the strategy's chosen `sendAt` — not executed yet.

| Card number | `error_reason` | Taxonomy category |
|---|---|---|
| `4100 2800 0008 0001` | `insufficient_fund` | FUNDS |
| `4100 2800 0006 0003` | `card_declined` | TRANSIENT |
| `4100 2800 0000 0009` | `authentication_failed` | AUTH_ABANDONED |
| `4100 2800 0001 0008` | `card_number_invalid` | INSTRUMENT |
| `4100 2800 0002 0007` | `gateway_technical_error` | TRANSIENT |

Any future expiry date, any CVV. No card here produces `TERMINAL` — that path is exercised via the test suite, not live.

**Subscriptions/recurring-payments entitlement was requested but never confirmed on this test account** (`plans`/`subscriptions` return 401 with a distinct error envelope — a product gate, not a bad key). `RazorpayWorld.chargeToken()` (the `TOKEN_RETRY` path) is built from the real SDK's own type definitions but has never been exercised against a real mandate token. **Labeled `[synthetic]` in this README rather than silently claimed as live** — this is the discipline this build tries to hold itself to everywhere else, applied to its own gap.

## 7. The eval generator: parameters, sources, and what it cannot tell you

Parameters are cited, not invented, where a citable source exists — full citations in `src/eval/sources.ts`:

- Recovery-rate bands (no-retry ~0–10%, fixed-interval ~20–40%, industry median ~47.6%, smart+card-updater+email 70–85%) and the "smart timing lifts recovery ~25% relative to fixed intervals" claim: RetentionLens, *State of Involuntary Churn* (2026).
- ~9% of MRR lost to failed payments; most soft declines resolve within 24–48h: Baremetrics.
- Expired/reissued cards as the single largest cause of involuntary churn: Recurly churn-rate benchmarks.

**What is not cited, stated plainly**: no source found gives a percentage breakdown across this taxonomy's five categories — industry reporting groups by card-network decline code, which doesn't map 1:1 onto TRANSIENT/FUNDS/AUTH_ABANDONED/INSTRUMENT/TERMINAL (AUTH_ABANDONED in particular is a UPI-specific pattern the US-centric sources above don't cover at all). The category mix and the salary-cycle liquidity-window mechanism are this build's own estimates, informed by but not lifted from the sources above (`UNCITED_ASSUMPTIONS` in `sources.ts`).

**What test mode cannot give you a realistic distribution of**: `error_reason` values. A real test-mode failure comes from a mock bank page with Success/Failure buttons — there is no way to sample a realistic decline-reason distribution from it. The taxonomy mapping itself (110 real `error_reason` values → 5 categories) is sourced from Razorpay's own docs; the *distribution* the generator samples from is synthetic by necessity, and is labeled as such everywhere it appears.

**The oracle is the generator played perfectly** — `argmax` over the same `wouldSucceed` ground-truth function the generator itself uses, bounded by the same policy engine every other strategy answers to. "% of oracle headroom" measures how well each strategy reverse-engineered *this build's own world model* — it is a **between-strategy comparison inside one simulator**, never an absolute claim about production. The system prompt is never given the generator's parameters (`categoryMix`, `baseRecoveryProb`, etc. — grepped for in CI-equivalent discipline before every commit touching either file); the agent has to infer patterns from context the same way a production system would have to infer them from real signals.

The absolute recovery rate above is a property of this generator, not a production estimate. The *relative ordering* between strategies under distribution shift (config A → config B) is the only finding this build would defend.

## 8. Policy engine: the 14 rules

Evaluation order (first match wins, logged as one rule id): **P7 → P13 → P3 → P1 → P2 → P11 → P4 → P5 → P12 → P6/P14 → P9 → P10 → P0**.

| Rule | What it checks |
|---|---|
| P0 | Approve — no rule objected |
| P1 | Max 3 recovery attempts per order, lifetime |
| P2 | Minimum 6h between attempts on the same order |
| P3 | `TERMINAL`-classified failures are never retried or contacted, regardless of what the model proposed — the rule the demo hinges on |
| P4 | No customer contact 22:00–08:00 IST, keyed off the proposal's *sendAt*, not decision time |
| P5 | Max 2 customer contacts per order, lifetime, all channels |
| P6 | Amount integrity — the executor always reads the charge amount from the order, never from the proposal; this rule is defense-in-depth against a schema regression that would let a proposal smuggle a different amount |
| P7 | Idempotency — `hash(orderId, attemptNumber)`; duplicates dropped before every other check, including the kill switch |
| P8 | Live-status recheck immediately before execution — if the order is already paid, execution is skipped, not fired blindly |
| P9 | Value ceiling (₹5,000 default) — at/above, auto-execution is rewritten into an `ESCALATE` to a human, never auto-fired |
| P10 | System-wide execution and contact caps, independent of any single order — catches a runaway backfill that per-order rules structurally cannot (every backfilled order is on attempt 1) |
| P11 | Staleness cutoff (7 days default) — refuses to act on a failure that happened long enough ago that the data is stale |
| P12 | One live, unpaid payment link per order at a time |
| P13 | Kill switch — halts every execution-bound action instantly; `markTerminal`/`escalate` keep working, so triage continues during an incident |
| P14 | Structural refusal of price-bearing template variables (discount %, waived fee) on any customer-facing proposal — see §9 |

`markTerminal` and `escalate` bypass every rule except P7: both are always-safe by the system prompt's own hard rules, and blocking either during an incident would break triage for no safety benefit.

**Backfill script proves P10/P11 are not rhetorical.** `npm run backfill -- --simulate 30` demonstrates P10 catching a volume runaway; `--stale-days 240` demonstrates P11 catching backdated data; `KILL_SWITCH=true npm run backfill -- --simulate 30` demonstrates P13. See `src/backfill/ingest.ts` and `PROGRESS.md` block 10 for the three real bugs found building this (all timestamp-semantics bugs: processing-time vs. event-time, wall-clock vs. simulated-now, and a missing execution call — each hid the next until fixed in order).

## 9. No price authority

The agent can see a template with a `discount_pct` variable (`retry_with_offer_v1`) — it is deliberately left in the catalogue, not hidden. `buildProposalFromToolCall` checks every customer-facing proposal against a *pattern* match (`isPriceBearingVar`, not a hardcoded template id) on both the template's declared variables and whatever the model actually supplied, catching a smuggled price-bearing variable on an otherwise-legitimate template too. A match produces **no `Proposal` at all** — refused with an explanation fed back to the model as a tool result. "Offers proposed" (the model reached for the trap) and "offers sent" (structurally always 0) are reported as separate columns in the benchmark table above specifically so this can't be hidden inside a single "success" number.

This is a **structural** refusal, not an instruction the model could be prompted around: the policy layer never sees a `Proposal` carrying pricing, because `tools.ts` never constructs one.

## 10. Where the agent loses to the rules engine, and my theory why

At n=20, rules-engine beat salvage-agent on net ₹ recovered by a margin the paired bootstrap says is real, not noise (§5). The clearest signal in the data: **contacts per recovery — 2.25 for rules-engine vs. 4.00 for salvage-agent.** The agent isn't failing to recover payments; it's spending nearly twice as many customer touches per success. Two theories, both grounded in what's actually in the data rather than speculation:

1. **Config B specifically stress-tests an assumption the rules engine gets wrong on purpose.** `RulesStrategy`'s FUNDS branch hardcodes a salary-cycle window of days 1–7 (`src/strategies/rules.ts`); config B deliberately shifts real liquidity to days 25–31 — the exact ablation spec §5.7 designs for. The agent has the customer-history tool to *discover* the shifted window; the rules engine cannot, by construction. That rules-engine still won at this sample size suggests either the agent needs more attempts/history per customer to detect and exploit that shift than a 1-seed sample gives it room to demonstrate, or —
2. **A smaller local model's edge is reliable tool-calling, not sharp timing judgment.** `qwen2.5:7b` was chosen specifically because it clears the bar for structurally valid, schema-correct tool calls (§6/§11) — a real, necessary, and non-trivial capability this build verified the hard way (see `src/llm/ollama-client.ts`'s module doc). But calling the *right* tool with valid arguments is a different skill from judging *when* a nudge will land, and a 7B model plausibly reasons less sharply about a multi-factor timing decision than the rules engine's simple, direct category → offset mapping gets essentially for free.

Both theories point the same direction: the agent's theoretical advantage (adapting to a shifted world the rules engine can't see) needs either a larger sample to show up reliably, or a stronger model to actually capitalize on the information it gathers. Neither is proven here — this is a stated theory against a real result, not a claim being smuggled past the benchmark.

## 11. How to run it

Test keys are free, no KYC. The LLM cache is committed — a reviewer reproduces the table above with **no API key**.

```bash
npm install
npm run db:push                          # SQLite schema, zero external services
npm test                                 # 186 tests, no live credentials needed
```

**To see it decide something**, seed the demo decision chains and open the page — the verdicts shown are produced by the real pipeline (real classifier, real policy engine), not fixture rows:

```bash
npm run seed:demo                        # TERMINAL trap caught by P3, a normal recovery, and a P8 race
npm run dev                              # then open http://localhost:3000
```

[`DEMO.md`](DEMO.md) is the 5-minute runbook for these, including what to say and where the honest answer is "that didn't happen."

Reproduce §5's table (`salvage-eval.sqlite`, committed, carries the real cached responses behind it — no API key needed):

```bash
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:7b EVAL_SCENARIOS=20 EVAL_SEEDS=1 npm run eval
```

`.env`'s own `LLM_PROVIDER` default is `gemini` (this build's Gemini key is quota-exhausted for the day — see §2) — override it as above. **Verified, not claimed**: two consecutive runs of that exact command each complete in **~1 second making zero LLM calls**, and their reports are **byte-for-byte identical** (every rate, every ₹ figure, the paired-bootstrap CI) apart from the run id. Ollama does not need to be installed or running to reproduce the table — the committed cache carries every response. To run the full headline config instead (this *does* need a live model):

```bash
npm run eval                                    # config B, full 120 scenarios x 3 seeds (hours on a 7B local model)
EVAL_CONFIG=A npm run eval                      # config A, for comparison
```

To run live (needs your own test-mode keys in `.env`, see `.env.example`):

```bash
npm run dev                              # real server: webhook -> agent/rules -> real Razorpay calls
npm run backfill -- --simulate 30        # P10 demo (no live keys needed, uses a stub World)
```

Package manager is **npm, not pnpm** — `corepack prepare pnpm` failed with `EPERM` on the build machine (no admin rights); functionally identical, `package.json` scripts are the source of truth over the spec's `pnpm` references.

## 12. What I'd do with two more weeks

- **Confirm Subscriptions/recurring-payments entitlement** and run the `TOKEN_RETRY` path live at least once — it's built and typed against the real SDK but genuinely unverified.
- **Consume `payment.downtime.*` for real.** It's received and stored today but not wired into the TRANSIENT-timing decision (`UnknownDowntimeChecker` defaults pessimistic instead) — real per-rail downtime data would sharpen the +90m/+6h split materially.
- **Source `ATTEMPT_COST_PAISE`/`CONTACT_GOODWILL_COST_PAISE`** — currently round-number placeholders (`src/economics/constants.ts`), unlike the taxonomy's cited figures. "Net ₹ recovered" is honest only as a relative comparison until these are backed by something real.
- **A durable scheduler.** `RealScheduler` is `setTimeout`-based and doesn't survive a process restart — fine for a continuously-running demo, not for production. BullMQ/Redis is the documented next step, deliberately deferred (spec: "Redis becomes optional infrastructure," not required for this scope).
- **A real category-mix source.** The generator's category distribution is this build's own estimate because no source found gives one for this exact taxonomy — worth a targeted literature search or, better, real anonymized decline data if a merchant partnership made that possible.
