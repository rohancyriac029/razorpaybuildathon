# salvage v3 — Agentic Commerce surface (Track A pivot)

**Status:** spec, not yet built. Written 2026-09-05.
**Budget:** ~5 focused hours of a <12h remaining window.
**Prime directive:** the existing recovery build is FROZEN and must stay shippable. Everything here is additive. If this runs out of time, `git stash` the incomplete work and submit the recovery build as-is (Option A fallback).

---

## 0. Where the repo actually is right now

Read `PROGRESS.md` first — it documents blocks 0–11 in detail. Summary of what exists and works:

| Thing | Path | State |
|---|---|---|
| Three ports | `src/ports/{strategy,policy-engine,world,scheduler}.ts` | done |
| Pipeline | `src/run.ts` — `decide()`, `executeApproved()`, `run()` | done |
| Policy engine P0–P14 | `src/policy/{rules,engine,gather-snapshot,snapshot}.ts` | done, 42 tests |
| Taxonomy (110 reasons) | `src/taxonomy/classify.ts` | done |
| Webhooks (HMAC, dedupe) | `src/webhooks/`, `src/server.ts` | done, live-verified |
| Agent loop + 7 tools | `src/agent/{agent-strategy,tools,system-prompt}.ts` | done |
| LLM providers | `src/llm/{client,factory,gemini-client,ollama-client,anthropic-client,cache}.ts` | Gemini + Ollama verified live; Anthropic untested |
| Worlds | `src/world/{razorpay-world,sim-world}.ts` | Razorpay live-verified (orders, payment links) |
| Audit trail | `src/persistence/episode-logger.ts`, `src/audit/decision-chain.ts` | done |
| HTML page | `public/index.html` (Decisions + Eval tabs) | done, served at `/` |
| Eval harness | `src/eval/*` (~800 LOC) | done, reproducible |
| Demo | `DEMO.md`, `scripts/seed-demo.ts` (`npm run seed:demo`) | done |

**Tests: 190 passing / 2 skipped. `npx tsc --noEmit` clean. Last commits: `c3f26ca`, `2f68dbf`.**

A background eval may still be running (`salvage-eval-g60.sqlite`, log `eval-g60.log`, 60 scenarios × 1 seed on Gemini). It is optional and can be killed. It writes to its **own** DB — the committed `salvage-eval.sqlite` artifact is not at risk.

### Gotchas already paid for — do not rediscover these

- **Windows main-module guard**: use `pathToFileURL(process.argv[1])`, never `` `file://${process.argv[1]}` `` (silently starts nothing).
- **`.env` loading**: entrypoints must call `process.loadEnvFile(".env")` themselves. `src/server.ts`, `eval/run.ts`, `scripts/backfill.ts` do.
- **`TaskStop` doesn't kill child node processes on Windows** — `kill -9 <pid>` after.
- **P10 counts system-wide executions with no run scoping.** Eval runs call `resetEvalState()` first (`src/eval/reset-state.ts`) or every later run reads 0.0%.
- **LLM cache key includes the model**, so an Ollama cache serves no Gemini run.
- **Gemini free tier is 500 req/day**, not 1,500.

---

## 1. Thesis

The pitch is **not** "we also do commerce." It is:

> **An LLM must never be the last word on money. Here is the engine that enforces that — demonstrated on two different agents, one spending and one recovering.**

Recovery stops being the product and becomes **evidence**: the same policy engine, already measured against 5 strategies with a paired bootstrap and a reproducible eval. The new buyer surface is what makes this a Track A entry rather than a costume.

Track A's stated bar, mapped to deliverables:

| Bar | Deliverable |
|---|---|
| "Every money action explainable, bounded and gated" | Every purchase passes `decide()` → P0–P14, verdict logged with rule id |
| "Show the audit trail" | Existing decision-chain page at `/`, extended to purchase episodes |
| "One failure handled gracefully" | **P9**: buyer exceeds its mandate → proposal rewritten to `ESCALATE` → human review, not a blocked error |
| "makes a merchant transactable by an AI buyer end to end" | Buyer agent → catalog → order → payment link, all on real Razorpay test mode |
| "Agent-readable catalog" (example direction) | `catalog.json` + `GET /api/catalog` |

---

## 2. Scope

### In
1. An **agent-readable catalog** served over HTTP.
2. A **`BuyerAgent`** — an LLM agent with a spending mandate that selects items and proposes purchases.
3. A **`PURCHASE` proposal type** flowing through the *existing* policy engine.
4. Real execution against Razorpay test mode (create order + payment link) via the existing `RazorpayWorld`.
5. The **P9 mandate-breach beat** — the graceful failure.
6. A **seed/demo script** + DEMO.md beats for the buyer surface.
7. README repositioned around the thesis above.

### Out — do not build
- Any wire protocol (UAP / ACP / AP2 / x402). Name them in the README as "what I'd do next"; implementing one is a multi-day job and judges will not expect it from a hackathon build.
- A second eval. The buyer surface is demonstrated, not benchmarked. There is no defensible ground truth for "would this purchase have happened" and inventing one would undercut the honest-metrics posture the recovery eval earns.
- Auth, multi-merchant, a real storefront UI, payments beyond test mode.
- Any change to `src/eval/*` or the recovery strategies. Frozen.

---

## 3. Domain model

Add to `src/types.ts` (do not create a parallel type system — reusing the `Proposal` union is what lets the policy engine work unchanged):

```ts
export interface PurchaseProposal {
  type: "PURCHASE";
  orderId: string;          // internal order id, minted before decide()
  attemptNumber: number;    // 1 for a first purchase attempt
  reasoning: string;        // model-written, shown in the audit trail
  proposedAt: string;       // ISO
  sku: string;              // MUST match a catalog entry
  quantity: number;         // integer >= 1
  // NOTE: deliberately NO price/amount field. Same discipline as the recovery
  // proposals (P6/P14): the executor reads price from the catalog, never from
  // the model. This is the schema-level enforcement, not a policy check.
}
```

Add `PurchaseProposal` to the `Proposal` union. Add `"PURCHASE"` to `EXECUTION_BOUND` in `src/policy/rules.ts`. Do **not** add it to `CUSTOMER_FACING` (a purchase is not an outbound contact — P4 blackout hours and P5 contact caps should not apply).

### Buyer mandate

```ts
export interface BuyerMandate {
  buyerId: string;
  maxPerOrderPaise: number;   // per-purchase ceiling
  maxTotalPaise: number;      // lifetime budget for this mandate
  allowedCategories: string[]; // catalog categories the buyer may transact in
}
```

### Catalog

`catalog.json` at repo root (agent-readable, also served at `GET /api/catalog`):

```json
{
  "currency": "INR",
  "items": [
    { "sku": "PLAN-BASIC",  "name": "Basic plan",   "pricePaise": 49900,  "category": "subscription", "inStock": true },
    { "sku": "PLAN-PRO",    "name": "Pro plan",     "pricePaise": 199900, "category": "subscription", "inStock": true },
    { "sku": "ADDON-SEATS", "name": "5 extra seats","pricePaise": 99900,  "category": "addon",        "inStock": true },
    { "sku": "PLAN-ENT",    "name": "Enterprise",   "pricePaise": 750000, "category": "subscription", "inStock": true },
    { "sku": "ADDON-OOS",   "name": "Legacy addon", "pricePaise": 29900,  "category": "addon",        "inStock": false }
  ]
}
```

`PLAN-ENT` at ₹7,500 sits **above** the default P9 ceiling (₹5,000 / `500000` paise) — that is the mandate-breach beat. `ADDON-OOS` is out of stock — that is the pre-execution catalog beat.

### Precondition: the order row must exist before `decidePurchase()`

Verified from `src/db/schema.ts`: `orders.customerId` is **NOT NULL** with an FK to `customers.id`, and `orders.razorpayOrderId` is **NOT NULL UNIQUE**. And P9 gates on `ctx.order.amount`. So the order must be created, with the catalog price already on it, *before* gating.

`src/commerce/create-purchase-order.ts`:

```ts
export async function createPurchaseOrder(db, rzp, buyerId: string, sku: string, qty: number): Promise<Order>
// 1. upsert a customers row for buyerId (reuse the pattern in src/webhooks/handler.ts)
// 2. amount = priceOf(sku) * qty      <- from catalog, NEVER from the model
// 3. create a REAL Razorpay order (rzp.orders.create) -> razorpayOrderId
// 4. insert the orders row, status "created"
// 5. return it
```

**Why this ordering is the point, not an implementation detail:** the amount reaching the policy engine comes from the catalog, never from the LLM. That is what makes P6/P14 structurally true for purchases, exactly as it is for recovery. Say this out loud in the demo.

---

## 4. Policy mapping — the intellectual core

The whole point is that **the existing engine gates purchases with no new safety logic**. Map, don't rewrite:

| Rule | Recovery meaning | Buyer meaning | Change needed |
|---|---|---|---|
| **P7** idempotency | duplicate retry dropped | duplicate purchase dropped (`hash(orderId, attemptNumber)`) | none |
| **P13** kill switch | halt all execution | halt all buying | none |
| **P3** TERMINAL | never retry a dead instrument | n/a (no failure) | **guard for null failure** |
| **P1/P2** attempts, gap | max 3 attempts, 6h apart | max 3 purchase attempts per order | none |
| **P11** staleness | don't act on old failures | n/a (no failure) | **guard for null failure** |
| **P4** blackout hours | no contact 22:00–08:00 IST | n/a — a purchase is not a contact | excluded via `CUSTOMER_FACING` |
| **P5** contact cap | max 2 contacts | n/a | excluded via `CUSTOMER_FACING` |
| **P6/P14** amount integrity | executor reads amount from order | **executor reads price from catalog** | extend check |
| **P9** value ceiling | ≥₹5,000 → ESCALATE | **buyer exceeds mandate → ESCALATE** ← the demo beat | none |
| **P10** global caps | runaway backfill | runaway buyer agent | none |
| **P8** live recheck | order already paid → skip | order already paid → skip | done in `execute-purchase.ts` (see Change 3) |
| *(new, not P8)* | — | item out of stock → skip | new catalog check — label it as new, not a P-rule |

### The engine changes — verified against the code, not assumed

**Change 1 — `PolicyContext.failure` becomes nullable.** A purchase has no failure:

```ts
export interface PolicyContext {
  order: Order;
  failure: FailureEvent | null;  // null for PURCHASE
  now: Date;
}
```

Guard the two rules in `src/policy/rules.ts` that read it:

```ts
// P3
if (ctx.failure && ctx.failure.category === "TERMINAL") { ... }

// P11
if (ctx.failure) {
  const failureAgeDays = (ctx.now.getTime() - new Date(ctx.failure.occurredAt).getTime()) / 86_400_000;
  ...
}
```

**Run the full suite after this.** All 190 tests must still pass — the recovery path always passes a non-null failure, so nothing should move. If anything breaks, the change is wrong; fix it rather than editing tests.

### Change 2 — do NOT reuse `decide()`. Write `decidePurchase()`.

**This was the blocking hole in the first draft of this spec.** Reusing `decide()` is impossible without lying in the audit trail. Verified:

```ts
export interface Strategy { propose(ctx: EpisodeContext): Promise<Proposal>; }
export interface EpisodeContext { failureContext: FailureContext; history; now; }
export interface FailureContext { order: Order; failure: FailureEvent; ... }  // NOT nullable
```

`decide()` takes `EpisodeContext` too. So a buyer would have to fabricate a fake `FailureEvent` to use either. Making `FailureContext.failure` nullable would ripple into `src/agent/tools.ts`, `src/context/assemble.ts` and the eval — i.e. it un-freezes recovery, which §0 forbids.

**Resolution:** `BuyerAgent` does **not** implement `Strategy`. Write a parallel entry point in `src/commerce/decide-purchase.ts`:

```ts
export interface BuyerContext {
  order: Order;            // already created, amount from catalog
  mandate: BuyerMandate;
  catalog: CatalogItem[];
  spentSoFarPaise: number;
  now: Date;
}

export async function decidePurchase(
  agent: BuyerAgent,
  policyEngine: PolicyEngine,
  ctx: BuyerContext,
  log: EpisodeLogger,
): Promise<DecisionResult>
```

It mirrors `decide()`'s ~30 lines: `hashContext` → `agent.propose(ctx)` → `policyEngine.decide(proposal, {order: ctx.order, failure: null, now: ctx.now})` → apply MODIFY → map verdict to outcome → `log(...)` → return `{proposal, verdict, intentId, contextHash}`.

**What this buys:** the *policy engine* — the part that matters — is reused byte-for-byte and stays under its existing 42 tests. Only the thin orchestration is duplicated. Recovery is never touched.

**Validated assumption (checked, don't re-check):** `src/policy/gather-snapshot.ts` never reads the `failures` table, so `gatherSnapshot` works unchanged for purchases.

### Change 3 — execution, and the P8 recheck

`executeApproved()` in `src/run.ts` has no `PURCHASE` branch, and it is frozen. So `src/commerce/execute-purchase.ts` owns execution — **and must therefore perform the P8 recheck itself**, or the "every money action gated" claim has a hole:

```ts
// P8 equivalent, done explicitly because run.ts is frozen:
const live = await world.getOrder(intent.orderId);
if (live.status === "paid") return { ok: false, detail: "P8 recheck: order already paid, execution skipped", ... };
// Stock is NOT an order status — this is a separate catalog check, do not call it P8:
const item = getItem(proposal.sku);
if (!item.inStock) return { ok: false, detail: "pre-execution catalog check: item out of stock", ... };
```

Label these honestly in the audit trail and the demo. The out-of-stock check is **new logic**, not P8.

### Mandate enforcement

Do **not** invent a new rule. Enforce the mandate through **P9** by constructing the `PolicyConfig` per buyer:

```ts
const config = { ...policyConfigFromEnv(), valueCeilingPaise: mandate.maxPerOrderPaise };
```

That way a mandate breach produces the existing P9 `MODIFY → ESCALATE` verdict, with its existing audit trail and its existing tests. This is the single highest-value design decision in this spec: **the buyer's spending limit is the same rule that already governs recovery.**

---

## 5. Files to create

| File | Contents |
|---|---|
| `catalog.json` | as §3 |
| `src/commerce/catalog.ts` | `loadCatalog()`, `getItem(sku)`, `priceOf(sku)`. Pure, no I/O beyond one read. |
| `src/commerce/buyer-tools.ts` | Zod-validated tools: `searchCatalog`, `getMandate`, `proposePurchase`. Mirror the shape of `src/agent/tools.ts` — refuse malformed input with a message fed back to the model, never throw. **`proposePurchase` must reject any attempt to pass a price/amount/discount field** (reuse `isPriceBearingVar` from `src/messaging/templates.ts`). |
| `src/commerce/buyer-agent.ts` | `BuyerAgent` — **does NOT implement `Strategy`** (see Change 2); it takes a `BuyerContext`. Multi-turn loop modelled on `src/agent/agent-strategy.ts`, including a `lastFellBackToRules`-style flag and `lastUsage`. Fallback: on any LLM error, propose nothing and **escalate** — a buyer that cannot think must not spend. (Note the deliberate asymmetry with recovery, which falls back to a rules proposal: there is no safe default purchase.) |
| `src/commerce/decide-purchase.ts` | `decidePurchase()` — the parallel gate entry point (Change 2) |
| `src/commerce/create-purchase-order.ts` | order/customer precondition (§3) |
| `src/commerce/buyer-system-prompt.ts` | System prompt. **Must state the mandate is enforced externally and the agent has no price authority.** No generator params (no eval here, but keep the discipline). |
| `src/commerce/execute-purchase.ts` | Turns an approved `PurchaseProposal` into a real Razorpay order + payment link via the existing `RazorpayWorld`. Reads price from catalog. |
| `scripts/seed-buyer-demo.ts` | Runs the three beats below through the **real** pipeline (mirror `scripts/seed-demo.ts`). Add `"seed:buyer": "tsx scripts/seed-buyer-demo.ts"` to package.json. |
| `test/commerce-buyer.test.ts` | See §7. |

### Files to modify (minimally)

- `src/types.ts` — add `PurchaseProposal`, `BuyerMandate`, extend `Proposal` union.
- `src/policy/rules.ts` — nullable `failure` guards; add `"PURCHASE"` to `EXECUTION_BOUND`; extend the P6/P14 smuggled-amount check to purchases.
- `src/ports/policy-engine.ts` — `failure: FailureEvent | null`.
- `src/world/razorpay-world.ts` — add `createPurchaseOrder(sku, qty)` (or put it in `execute-purchase.ts` and leave `World` alone — **preferred**, fewer blast radius).
- `src/server.ts` — `GET /api/catalog`.
- `public/index.html` — purchase episodes will already appear in the Decisions tab (they're episodes). Only touch this if the proposal renders badly.

---

## 6. Build order (time-boxed — cut from the bottom)

Two tiers. **Tier 1 is the submission** and must fit in ~3h30. Tier 2 is upside, attempted only if Tier 1 is committed and green.

**Tier 1 — the minimum shippable Track A entry (~3h30)**

| # | Step | Est |
|---|---|---|
| 1 | `catalog.json` + `src/commerce/catalog.ts` + `GET /api/catalog` | 25m |
| 2 | `PurchaseProposal` type, nullable `PolicyContext.failure`, `EXECUTION_BOUND` — **run all 190 tests** | 30m |
| 3 | `create-purchase-order.ts` (§3 precondition) | 25m |
| 4 | `decide-purchase.ts` (Change 2) | 25m |
| 5 | `buyer-tools.ts` + `buyer-system-prompt.ts` + `buyer-agent.ts` | 1h15 |
| 6 | `execute-purchase.ts` incl. the P8 recheck (Change 3) | 20m |
| 7 | `scripts/seed-buyer-demo.ts` — 3 beats, **run for real** | 30m |

**Commit here.** At this point the submission is complete and defensible even if everything below is skipped.

**Tier 2 — upside, in strict priority order**

| # | Step | Est | Notes |
|---|---|---|---|
| 8 | README repositioning (§8) | 45m | Highest value in Tier 2 — do this first |
| 9 | `test/commerce-buyer.test.ts` — the 4 core cases | 40m | |
| 10 | DEMO.md buyer beats | 20m | |
| 11 | Live Razorpay purchase against the real API | 20m | else use the stub and say so |
| 12 | HTML page polish for purchases | 30m | first to drop |

**Hard rule: if Tier 1 is not green at the 4-hour mark, stop and fall back to §11.** A working buyer surface with a rough README beats a polished half-built one.

---

## 7. Tests (minimum bar)

`test/commerce-buyer.test.ts` — mirror the style of `test/backfill-ingest.test.ts` (run the real pipeline, assert on real verdicts, not mocks):

1. **Mandate breach → P9.** Buyer proposes `PLAN-ENT` (₹7,500) under a ₹5,000 mandate → verdict `MODIFY`, ruleId `P9`, proposal rewritten to `ESCALATE`. *The headline test.*
2. **Within mandate → approved and executed.** `PLAN-BASIC` under a ₹5,000 mandate → `APPROVE`/`P0`, executes, real order row persisted.
3. **No price authority.** A `proposePurchase` tool call carrying a `discount`/`price` field is refused, produces **no Proposal at all**, and sets the offer-attempted flag.
4. **Kill switch.** `KILL_SWITCH=true` → `P13` rejects every purchase.
5. *(if time)* **Idempotency.** Same `(orderId, attemptNumber)` twice → second dropped by P7.
6. *(if time)* **Out of stock.** `ADDON-OOS` → P8 recheck skips execution.

Plus: **all 190 existing tests must still pass.**

---

## 8. README repositioning

Rewrite the top of `README.md`. Keep every measured recovery claim — they become evidence, not the pitch.

- **Title/subtitle** → `salvage — a policy engine for agentic money movement`, Track: *AI Growth & Agentic Commerce*.
- **§1 The problem** → reframe: autonomous agents are starting to move real money (UAP, ACP, AP2, x402; Razorpay's own in-app pilots are live). The open question isn't whether an agent can transact — it's **who bounds it**. Cite the Agent Studio criticism (₹500 discount, then doubled) as the concrete failure mode.
- **§2 What this is** → one engine, two agents: a **buyer** that spends and a **recovery** agent that re-approaches. Both pass the same 14 rules. Lead with: *the LLM is never the last word on money.*
- **New §** *"Bounded by construction"* → the P9 mandate beat + P14 no-price-authority, both with real output pasted in.
- **Keep** the benchmark table, the paired bootstrap, the "agent loses to the rules engine" finding, the oracle caveat, §12 future work. Retitle the eval section *"Evidence: the same engine, measured"* — it is now the proof the engine is real, not a marketing table.
- **Add to future work**: implementing UAP/ACP/AP2/x402 as a transport (name it explicitly as not built).

---

## 9. Demo beats (append to DEMO.md)

Buyer surface, ~90 seconds, slotted before the recovery beats:

1. **`GET /api/catalog`** — "the merchant is agent-readable."
2. **Buyer buys within mandate** — agent picks `PLAN-BASIC`, policy approves (`P0`), real Razorpay order + payment link created. Show the audit entry: model reasoning *and* verdict.
3. **Buyer tries to exceed its mandate** — agent reaches for `PLAN-ENT` (₹7,500 vs ₹5,000 mandate) → **P9** rewrites it to `ESCALATE` → human review. *"The buyer wanted to spend. The engine said no, logged why, and routed it to a human. The model never had the authority."* ← **this is the money beat**
4. **No price authority** — "it cannot ask for a discount; there is no field for one."

Then the existing recovery beats become: *"and here's the same engine, measured."*

---

## 10. Definition of done

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — 190 existing + new tests, all passing
- [ ] `npm run seed:buyer` produces all 3 beats through the real pipeline
- [ ] Purchase episodes visible in the decision-chain page at `/`
- [ ] README repositioned; every recovery number still accurate
- [ ] DEMO.md has the buyer beats
- [ ] Committed with a message documenting what's reused vs new

## 11. If it goes wrong

The recovery build is committed at `2f68dbf` and is independently submittable. If the buyer surface isn't finished and working by the 4-hour mark: `git stash`, submit recovery to the Revenue Recovery track (Option A), and lose nothing. **Do not submit a half-built buyer surface** — a visibly incomplete second surface is worse than not having one, because it invites exactly the "bolted-on" critique this pivot exists to avoid.
