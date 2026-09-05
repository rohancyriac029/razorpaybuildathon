# Demo runbook — ~6:30

Spec §8's beat table (recovery) plus the v3 commerce beats (spec §9), with the exact commands, the exact things to say, and — deliberately — the places where the honest answer is "that didn't happen." Rehearse twice.

## Before you start (2 minutes, do it every time)

```bash
npm run db:push                # fresh dev schema
npx tsx scripts/seed-demo.ts        # seeds §8's recovery beats through the REAL pipeline
npx tsx scripts/seed-buyer-demo.ts  # seeds §9's commerce beats through the REAL pipeline (real Razorpay + real LLM)
npm run dev                    # server on :3000
```

Open **http://localhost:3000**. You should see three recovery orders plus three buyer orders. Verify all six are there before you present — if a seed script prints "already seeded (deduped)", the database already has them and you're fine.

> **What both seed scripts are and aren't.** Neither inserts fabricated rows. `seed-demo.ts` feeds real `payment.failed` payloads through the real taxonomy classifier and the real `decide()`/`executeApproved()` pipeline; `seed-buyer-demo.ts` runs a real Gemini-backed `BuyerAgent` through real `createPurchaseOrder`/`decidePurchase`/`executePurchase` against the real Razorpay test API. The verdicts on screen were genuinely decided, not typed in. Say this if asked; it's the difference between a demo and a mockup.

**If you have a tunnel + browser and want the fully live version** of the recovery beat instead of the seeded one, see README §6's recipe (cloudflared → dashboard webhook → test card). It needs a browser because Razorpay test mode has no headless failure trigger — that's README §4, and it's worth saying out loud rather than hiding.

---

## 0:00–0:30 — The problem, one line

> "Agents are starting to move real money without a human confirming each step. Razorpay's own Agent Studio demo showed why that's dangerous unsupervised: an abandoned-cart agent offered a ₹500 discount, then **doubled it** when that didn't convert — live, on stage. The question isn't whether an agent can transact. It's who bounds it."

## 0:30–2:00 — The buyer agent, and the money beat

Open the catalog first: `curl localhost:3000/api/catalog` — *"the merchant is agent-readable."*

> "This is a buyer agent with a spending mandate — ₹5,000 per purchase. It doesn't enforce that itself. A deterministic policy engine does, after it proposes — the same 14-rule engine, no new logic written for this."

Click the **Basic plan** order (the first buyer beat).

> "It wanted the Basic plan, ₹499, well inside mandate. Policy approves — **P0** — and it executes: real Razorpay order, real payment link."

Click the **Enterprise plan** order (the mandate-breach beat — **this is the money beat**).

> "Now it wants Enterprise — ₹7,500. Watch the proposal type change: it proposed a **PURCHASE**, and the verdict is **MODIFY, P9** — the *exact same rule* that caps recovery's auto-execution ceiling. The engine didn't error. It **rewrote** the buyer's proposal into an escalation to a human, and kept the agent's own reasoning attached so you can see what it wanted and why it got overruled.
>
> That's my answer to the Agent Studio criticism: the agent that tries to spend past its authority doesn't get a second attempt to try harder. It gets escalated, with a rule id, on the first try."

Click the **out-of-stock** order, quickly.

> "One more safety net, and I'm labelling it honestly: this is *not* P8. P8 checks whether a payment already went through. This checks a catalog fact — is the item even in stock. Policy approved it, execution caught it. Different rule, same discipline: check right before you spend, not just at proposal time."

## 2:00–2:30 — A normal recovery

Click **`order_demo_normal_recovery`**.

> "TRANSIENT failure — gateway-side, the instrument is fine. The strategy proposes a payment link, the policy engine approves it, it executes. That's the happy path, and it's the least interesting minute of this demo."

Point at `sendAt` being **later than** `proposedAt`.

> "The decision happened now; the link goes out when the strategy chose. Execution is scheduled, not immediate — that split is load-bearing, because the whole eval measures timing quality."

## 2:30–4:00 — The adversarial TERMINAL **(this is the recovery half's whole demo)**

Click **`order_demo_terminal_trap`**.

> "This one is a blocked card — `debit_instrument_blocked`. It *reads* like an ordinary card problem you'd retry. The taxonomy classifies it TERMINAL: no retry ever recovers it, and contacting the customer is pure cost and annoyance."

Point at the proposal, then the verdict.

> "The strategy proposed a payment link anyway. The policy engine rejected it — **P3**, right there in the audit log, with the reason. You can see both: what the strategy wanted, and the rule that stopped it.
>
> Everyone else today is going to show you an agent succeeding. This is mine failing, safely, with a receipt. That's the thing I'd want to see if I were hiring for payments."

**The point to land:** the LLM is untrusted by construction. The policy engine is a pure function, no model in it, and it is the only thing that decides whether anything reaches a customer.

## 4:00–5:00 — The benchmark

```bash
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:7b EVAL_SCENARIOS=20 EVAL_SEEDS=1 npm run eval
```

Runs in ~1 second from the committed cache, no API key, no model needed.

> "Five strategies on the same scenarios. Lead with the two that matter: the **rules engine** — 150 lines of `if`, no LLM — and the **oracle**, which is the ceiling."

Then, before anyone asks:

> "**My agent loses.** Rules engine recovers 40%, the agent 15%, and the paired bootstrap says that gap is real, not noise — the CI excludes zero. My theory is in README §10: the agent isn't failing to recover, it's spending 4 contacts per recovery against the rules engine's 2.25.
>
> Two caveats I'd rather say than be asked. **One:** the oracle is my own generator played perfectly — so 'percent of oracle headroom' measures how well a strategy reverse-engineered *my* world model, not anything about production. **Two:** this is n=20, one seed, not the 120×3 I designed for. Gemini's free tier is 500 requests a day and I burned it; the local model works but needs about six hours for a full run. I'd rather show you a small honest number than a big invented one."

## 5:00–5:30 — No price authority, on the recovery side too

> "Same discipline you already saw on the buyer agent, other side of the ledger. This one's message-template based — the agent can see a template with a discount variable, and the tool layer refuses it structurally before it ever becomes a proposal. No propose tool has an amount parameter, on either agent, so there is no `Proposal` that can carry a price."

**Be honest about the number:**

> "The offer-trap template is in the catalogue and the agent can see it. In this 20-scenario sample it never reached for one — so that column reads 0/20 proposed, not '6 attempts blocked.' The trap firing is proven in `test/agent-strategy.test.ts` with a model scripted to reach for it, not in this run's data."

*(Optional, ten seconds — the kill switch, if you have time or get asked about blast radius:)*

```bash
KILL_SWITCH=true npm run backfill -- --simulate 30    # 30/30 rejected via P13
npm run backfill -- --simulate 30 --stale-days 240    # 30/30 rejected via P11
```

## 6:00–6:30 — Two more weeks

README §12. Lead with the two genuinely unfinished things across both agents: a real wire protocol (UAP/ACP/AP2/x402) for the buyer's transport instead of an in-process call, and — on the recovery side — the `TOKEN_RETRY` path, written and typed against the real SDK but **never run against a live mandate token** (Subscriptions entitlement never arrived), plus the full 120×3 eval.

---

## Three graceful failures, loaded and ready

Spec §8 wants these available if asked. Ranked by how convincing they are:

**1. The P8 race — the best one.** Click **`order_demo_p8_race`**.
> "Approved, then the customer paid on their own between the decision and the send. The pre-execution recheck caught it and skipped — `ok=false`, 'order already paid'. No model could have reasoned about this; it hadn't happened yet at decision time. Only a recheck at the boundary catches it."

**2. The P10 global cap.** `npm run backfill -- --simulate 30` — approves up to the hourly cap, rejects the rest via P10.
> "Every one of those orders is on attempt 1, so per-order limits do nothing. Only a system-wide cap catches a runaway backfill. That's why P10 exists, and this script is why I can say that instead of just asserting it."

**3. Malformed model output → validation → rules fallback.** *Say this one is fault-injected.*
> "With tool use the model rarely emits malformed arguments naturally, so this is injected in tests rather than something I caught in the wild. Volunteering that is worth more than the beat is."

---

## Questions with sharp edges

**"Did the LLM actually do anything?"**
> Honestly: marginally, and the README says so in the first screen. It picks timing and channel from customer history, and writes the merchant-facing rationale. Every safety boundary is deterministic. At n=20 it lost to the rules engine.

**"Why not Anthropic / why a local model?"**
> The provider is one env var behind an interface. Gemini is wired and verified live; the daily free-tier quota is 500 requests and I exhausted it mid-build, so the reported numbers come from a local `qwen2.5:7b`. `AnthropicClient` is written but has never run — no key — and I haven't claimed otherwise anywhere.

**"Is the eval reproducible?"**
> Yes, and it's tested: two consecutive runs are byte-for-byte identical, in ~1 second, with zero LLM calls. Getting there required fixing a real bug — P10's global cap counted the *previous* run's executions and starved every later run to 0.0%. `test/eval-reset-state.test.ts` reproduces the bug and proves the fix.

**"What's the weakest part?"**
> Sample size, and I'd say it before you find it. n=20, one seed, one config. The distribution-shift claim (config A → B) is the finding I'd defend in principle, but I only measured the agent on config B — so right now it's a design, not a result.

**"Isn't the buyer agent just recovery with different words?"**
> No — it's a different agent with a different mandate, gated through a genuinely parallel entry point (`decidePurchase()`, not `decide()`), because `Strategy` requires a non-null failure and a purchase has none. What's shared is the *engine*, deliberately: the buyer's ceiling is recovery's own P9 rule, not a new one. I'd rather defend "the same 14-rule engine holds up under a second, unrelated caller" than pretend I wrote two engines.

**"Is the commerce surface benchmarked like recovery is?"**
> No, and I'm not going to pretend it is. There's no defensible ground truth for "would this purchase have happened" the way the recovery eval has `wouldSucceed()` — inventing one would undercut the honest-metrics posture the recovery eval earns. It's demonstrated live, with real Razorpay calls and a real model, not benchmarked. Said plainly in README §12, not discovered by a judge.
