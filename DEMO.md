# Demo runbook — 5 minutes

Spec §8's beat table, with the exact commands, the exact things to say, and — deliberately — the places where the honest answer is "that didn't happen." Rehearse twice.

## Before you start (2 minutes, do it every time)

```bash
npm run db:push                # fresh dev schema
npx tsx scripts/seed-demo.ts   # seeds §8's beats through the REAL pipeline
npm run dev                    # server on :3000
```

Open **http://localhost:3000**. You should see three orders. Verify all three are there before you present — if `seed-demo` prints "already seeded (deduped)", the database already has them and you're fine.

> **What `seed-demo.ts` is and isn't.** It does not insert fabricated rows. It feeds real `payment.failed` payloads through the real taxonomy classifier, the real `RulesPolicyEngine`, and the real `decide()`/`executeApproved()` pipeline — the same functions production runs. The verdicts on screen were genuinely decided, not typed in. Say this if asked; it's the difference between a demo and a mockup.

**If you have a tunnel + browser and want the fully live version** of the 0:30–1:30 beat instead of the seeded one, see README §6's recipe (cloudflared → dashboard webhook → test card). It needs a browser because Razorpay test mode has no headless failure trigger — that's README §4, and it's worth saying out loud rather than hiding.

---

## 0:00–0:30 — The problem, one number

> "20–40% of SaaS churn is involuntary — payments that fail silently. Razorpay already retries a subscription charge and gives up after four. What happens *after* that is the merchant's problem, and it's the window this lives in."

## 0:30–1:30 — A normal recovery

Click **`order_demo_normal_recovery`**.

> "TRANSIENT failure — gateway-side, the instrument is fine. The strategy proposes a payment link, the policy engine approves it, it executes. That's the happy path, and it's the least interesting minute of this demo."

Point at `sendAt` being **later than** `proposedAt`.

> "The decision happened now; the link goes out when the strategy chose. Execution is scheduled, not immediate — that split is load-bearing, because the whole eval measures timing quality."

## 1:30–3:00 — The adversarial TERMINAL **(this is the whole demo)**

Click **`order_demo_terminal_trap`**.

> "This one is a blocked card — `debit_instrument_blocked`. It *reads* like an ordinary card problem you'd retry. The taxonomy classifies it TERMINAL: no retry ever recovers it, and contacting the customer is pure cost and annoyance."

Point at the proposal, then the verdict.

> "The strategy proposed a payment link anyway. The policy engine rejected it — **P3**, right there in the audit log, with the reason. You can see both: what the strategy wanted, and the rule that stopped it.
>
> Everyone else today is going to show you an agent succeeding. This is mine failing, safely, with a receipt. That's the thing I'd want to see if I were hiring for payments."

**The point to land:** the LLM is untrusted by construction. The policy engine is a pure function, no model in it, and it is the only thing that decides whether anything reaches a customer.

## 3:00–4:00 — The benchmark

```bash
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:7b EVAL_SCENARIOS=20 EVAL_SEEDS=1 npm run eval
```

Runs in ~1 second from the committed cache, no API key, no model needed.

> "Five strategies on the same scenarios. Lead with the two that matter: the **rules engine** — 150 lines of `if`, no LLM — and the **oracle**, which is the ceiling."

Then, before anyone asks:

> "**My agent loses.** Rules engine recovers 40%, the agent 15%, and the paired bootstrap says that gap is real, not noise — the CI excludes zero. My theory is in README §10: the agent isn't failing to recover, it's spending 4 contacts per recovery against the rules engine's 2.25.
>
> Two caveats I'd rather say than be asked. **One:** the oracle is my own generator played perfectly — so 'percent of oracle headroom' measures how well a strategy reverse-engineered *my* world model, not anything about production. **Two:** this is n=20, one seed, not the 120×3 I designed for. Gemini's free tier is 500 requests a day and I burned it; the local model works but needs about six hours for a full run. I'd rather show you a small honest number than a big invented one."

## 4:00–4:30 — No price authority

> "Razorpay's own Agent Studio demo drew criticism when the abandoned-cart agent offered a ₹500 discount, then doubled it when that didn't convert — price discrimination, dark-pattern concerns. In this system the agent **structurally cannot** discount. The amount isn't policy-checked, it's absent from the schema: no propose tool has an amount parameter, so there is no `Proposal` that can carry a price."

**Be honest about the number:**

> "The offer-trap template is in the catalogue and the agent can see it. In this 20-scenario sample it never reached for one — so that column reads 0/20 proposed, not '6 attempts blocked.' The trap firing is proven in `test/agent-strategy.test.ts` with a model scripted to reach for it, not in this run's data."

*(Optional, ten seconds — the kill switch, if you have time or get asked about blast radius:)*

```bash
KILL_SWITCH=true npm run backfill -- --simulate 30    # 30/30 rejected via P13
npm run backfill -- --simulate 30 --stale-days 240    # 30/30 rejected via P11
```

## 4:30–5:00 — Two more weeks

README §12. Lead with the two genuinely unfinished things: the `TOKEN_RETRY` path is written and typed against the real SDK but **never run against a live mandate token** (Subscriptions entitlement never arrived), and the full 120×3 eval.

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
