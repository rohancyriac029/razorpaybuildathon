# Demo runbook

A 5:00 script you can deliver as written, plus fallback material for extra time and hard questions.

## Before you start (every time)

```bash
npm run db:push       # fresh dev schema (first run only)
npm run demo:prep     # clears rehearsal rows, seeds beats, loads the scoreboard
npm run dev           # http://localhost:3000
```

Confirm **7 orders** in the left list and **5 strategies** on the Eval scoreboard before you present. Every submission through the request form adds a row, so re-run `demo:prep` if the list has grown — a cluttered list costs you time on stage.

The buyer beats need Razorpay test credentials and an LLM provider; they're already seeded in the committed database, but to regenerate them: `npm run seed:buyer`.

> **What the seeds are and aren't.** Nothing is a fabricated row. `seed-demo.ts` pushes real `payment.failed` payloads through the real taxonomy classifier and the real `decide()`/`executeApproved()` pipeline; `seed-buyer-demo.ts` runs a real LLM-backed buyer agent against the real Razorpay test API. Every verdict on screen was genuinely decided. Say this if challenged — it's the difference between a demo and a mockup.

---

# The 5-minute script

## 0:00–0:25 — The problem

> "Agents are starting to move real money without a human confirming each step. Razorpay's own Agent Studio demo showed the failure mode live on stage: an abandoned-cart agent offered a ₹500 discount, then **doubled it** when that didn't convert. The question isn't whether an agent can transact. It's who bounds it."

Gesture at the pipeline banner across the top.

> "Seven stages. Blue is the LLM — it proposes, and that's all it can do. Green is deterministic. Stage 4 is the only thing that can authorise an action reaching a customer or a card."

## 0:25–1:25 — Safety, shown not asserted

Click **`order_demo_terminal_trap`**.

> "A blocked card — `debit_instrument_blocked`. It *reads* like an ordinary card problem you'd retry. The taxonomy classifies it TERMINAL: no retry will ever recover it, and contacting the customer is pure cost."

Let the flow animate, then point at the dashed tail.

> "The strategy proposed a payment link anyway. **P3 rejected it.** Stages 5, 6 and 7 never happened — nothing scheduled, nothing sent, no customer contacted. You can see both halves: what the agent wanted, and the rule that stopped it.
>
> Everyone else today will show you an agent succeeding. This is mine failing safely, with a receipt."

## 1:25–2:05 — The race no model could win

Click **`order_demo_p8_race`**.

> "Same start: transient failure, agent proposes a link, policy approves, it gets scheduled. Then — between the decision and the send time — the customer pays on their own."

Point at stage 6, amber.

> "The system rechecks live payment status immediately before executing, and skips. No duplicate charge, no pointless message. **No model could have reasoned about this** — at decision time it hadn't happened yet. Only a check at the boundary catches it."

## 2:05–2:50 — The money beat

Click **`order_TYRGzWLRQuExxK`** (₹7,500, escalated).

> "Different agent — a buyer agent with a ₹5,000 per-order spending mandate. It wants the ₹7,500 Enterprise plan."

Point at the verdict: `MODIFY P9`.

> "The engine didn't error and didn't obey. It **rewrote** the purchase into a human escalation, and kept the agent's own reasoning attached so a reviewer sees what it wanted and why it was overruled. That's **P9 — the same rule that caps auto-execution on the recovery side.** One engine, two unrelated agents, no new rules."

Now read the agent's own reasoning off the screen — the strongest line in the demo:

> "And read what the model said: *'…and falls within my spending mandate.'* It doesn't. ₹7,500 against a ₹5,000 limit — 50% over. **The model asserted it was compliant and was simply wrong**, and the deterministic engine caught it anyway. That is the entire argument for why the model doesn't get to enforce its own limits."

## 2:50–4:20 — Does the AI actually earn its place?

Switch to the **Eval scoreboard** tab.

| Strategy | Recovery | Net recovered |
|---|---:|---:|
| Rules engine | 32.5% | ₹8,607 |
| **Salvage agent** | **40.0%** | **₹12,204** |
| Oracle (ceiling) | 55.0% | ₹11,324 |

> "Five strategies, same scenarios, same policy engine, same execution path. Only the decision-maker changes. The agent beats a 150-line deterministic rules engine — 40% against 32.5% — with *fewer* wasted attempts and better contact efficiency."

Then immediately give away how hard that was:

> "That took three attempts, and the first two failed.
>
> **One:** the rules engine was wired in as a fallback and never fired. On abandoned-auth failures the agent chose a payment link 68 times and a nudge **zero** times out of 84 — against a ground-truth model that rates a link at half a nudge's effectiveness there. It lost that category significantly.
>
> **Two:** so I handed it the baseline's recommendation. It copied it exactly — 99 times out of 99. Byte-identical to the rules engine, mean difference exactly ₹0.00. A rules engine with a token bill. I measure that directly; it's called deviation rate, and 0% means the LLM is contributing nothing.
>
> **Three:** split the anchor. The rules engine is right about **which lever** — nudge versus link — because that's fixed domain knowledge. It's wrong about **when**, because timing is customer-specific and only the model sees that history. The agent now keeps the lever 100% of the time and re-times 84% of attempts. That's the split that made it win."

**Say the caveat before anyone asks:**

> "n=40, one seed. The paired bootstrap is +₹89.92 per episode, 95% CI [−₹20.25, +₹220.15] — it crosses zero. Strong point estimate, **not** a significant result. I'm not claiming otherwise."

## 4:20–5:00 — Close

> "One more thing, because it's why I trust these numbers. Before reporting them I attacked my own benchmark. Every scenario fires at 05:30 IST, and P4 blocks customer contact between 22:00 and 08:00 — so the industry-standard fixed-24-hour retry had **100% of its proposals rejected before it ever acted.** That 0% row isn't a baseline I beat; it's a strategy that never got to play. My own rules engine was blocked on 47% of cases and was being *rewarded* for it, because a rejected proposal costs nothing.
>
> I fixed it, and fixing it made my own baseline **stronger** — 16.7% up to 19.2%. I made the competition harder before claiming to beat it.
>
> The policy engine is the product. It's what lets you put any decision-maker behind it — rules today, this model now, a better one tomorrow — and know none of them can move money, offer a discount, or message a customer outside the rules. The agent is a benchmark entry I can audit down to the individual wrong decision, not an article of faith."

---

# If you get more time

**A normal recovery** — `order_demo_normal_recovery`. TRANSIENT → link → approved → executed. The happy path, and the least interesting minute you have. Point at `sendAt` being later than `proposedAt`: deciding and acting are deliberately separate, because the whole eval measures timing quality.

**Out of stock** — `order_TYRH7XACDAdrW5` (₹299). Policy **approved** it — P0, nothing objected, well inside mandate — and the executor stopped it anyway because the catalog says out of stock. Label it honestly: **this is not P8.** P8 checks payment status; this checks a catalog fact. Same discipline, different rule: verify at the moment of action, because the world changes between deciding and acting. Two independent gates had to agree before money moved.

**No price authority** — the agent can see a template carrying a `discount_pct` variable, and the tool layer refuses it structurally before it can become a proposal. No propose tool has an amount parameter on either agent, so no `Proposal` can carry a price. Be honest about the number: in this sample the agent never reached for it, so the column reads 0 proposed — the trap firing is proven in `test/agent-strategy.test.ts` with a model scripted to reach for it, not in this run's data.

**Live interaction** — the **Run a recovery request** form runs the real pipeline end to end. Pick `debit_instrument_blocked` + **Simulated**, submit, and the flow renders live. A good answer to "is this pre-baked?" Use Simulated unless you have network headroom; Razorpay test mode makes real API calls and is slower.

**Kill switch / blast radius** (~10s):

```bash
KILL_SWITCH=true npm run backfill -- --simulate 30    # 30/30 rejected via P13
npm run backfill -- --simulate 30 --stale-days 240    # 30/30 rejected via P11
```

**The blackout probe**, if they want to see the self-red-team rather than hear it (~2s, no LLM, no database):

```bash
npm run demo:blackout
```

---

# Questions with sharp edges

**"Did the LLM actually do anything?"**
> Yes, and I can show you how much. It keeps the baseline's lever on 100% of attempts and re-times 84% of them — worth +7.5 points of recovery and about ₹3,600 over the rules engine on this sample. It's a first-class metric: endorsed / retimed / deviated. When I first anchored it, that table read 0% deviation and the agent was byte-identical to the rules engine. The metric exists to catch an LLM that isn't earning its tokens.

**"Is 40% good?"**
> The oracle — which cheats by reading ground truth — recovers 55%, so the agent is capturing roughly 73% of the achievable recovery rate on this set. Quote the recovery rates, not the "% oracle headroom" column: that column is computed on net value, and the oracle doesn't optimise for value (see the next question).

**"Your agent beat the oracle on rupees — isn't that impossible?"**
> Good catch, and no — it's a flaw in that metric, not a result. The oracle maximises recovery *probability per scenario*, not portfolio value, so it's a recovery-count ceiling, not a value ceiling. The agent recovered fewer orders but higher-value ones. A value-weighted oracle is the fix. I'm not claiming to have beaten a theoretical maximum.

**"Is the benchmark realistic?"**
> No. It's a synthetic simulator and every recovery figure is a simulator result, not a production forecast. Attempt and contact costs are round-number placeholders, so the rupee figures are only meaningful as *relative* comparisons between strategies. What's real is the Razorpay test-mode integration, the policy engine, and the execution path.

**"What's actually live against Razorpay?"**
> Order creation, order-status fetch, payment-link creation — real test-mode calls returning real short URLs. Webhook signature verification and dedupe are real. Message delivery is stubbed and logged, not sent. `TOKEN_RETRY` is typed against the SDK but never verified live — Subscriptions entitlement never arrived, and I don't claim it works.

**"Which model, and why not a frontier one?"**
> Qwen 2.5 7B locally via Ollama, zero marginal cost. A frontier model on the same harness is the obvious next experiment — and the deviation-rate metric is the instrument that would tell you whether it contributes judgment or just copies the baseline.

**"What's the weakest part?"**
> Sample size, and I'd say it before you find it: n=40, one seed, one config, CI crosses zero. Second weakest: the cost constants are made up, so treat every rupee figure as relative. Third: the scheduler is process-local and doesn't survive a restart — a durable queue is required before this is production.

**"Isn't the buyer agent just recovery with different words?"**
> No — different agent, different mandate, a genuinely separate entry point (`decidePurchase()`, not `decide()`), because a purchase has no failure to classify. What's shared is the *engine*, deliberately: the buyer's ceiling is recovery's own P9. I'd rather defend "the same engine holds up under a second, unrelated caller" than pretend I wrote two.

**"Is the commerce surface benchmarked like recovery is?"**
> No, and I won't pretend it is. There's no defensible ground truth for "would this purchase have happened" the way recovery has `wouldSucceed()`. Inventing one would undercut the honest-metrics posture the recovery eval earns. It's demonstrated live, not benchmarked.

---

# If something breaks

- **Scoreboard empty** → `npm run demo:prep`
- **Decisions list empty** → `npm run db:push && npm run demo:prep`
- **Port busy** → `PORT=3001 npm run dev`
- **No model needed** — the demo reads committed results; nothing calls Ollama during the presentation
- **Worst case** — the numbers are in the README's Evaluation section. Present from those.
