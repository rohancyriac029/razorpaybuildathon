# Salvage

Salvage is a policy-controlled platform for agentic money movement. An AI agent can propose a payment recovery action or a purchase, but it cannot execute the action directly. Every proposal passes through a deterministic policy engine that can approve, reject, modify, or escalate it.

The project includes two agent surfaces:

- **Payment recovery:** classifies failed payments, selects a recovery channel, and schedules customer contact based on payment and customer context.
- **Agentic commerce:** proposes purchases from a merchant catalog under a per-order spending mandate.

Both surfaces use the same policy engine, execution boundary, and audit trail.

## Capabilities

- AI-assisted recovery timing and channel selection
- Catalog-aware purchase proposals
- Deterministic approval, rejection, modification, and escalation decisions
- Payment-status and catalog checks immediately before execution
- Idempotency, attempt, contact, staleness, value, and system-wide limits
- Structural refusal of discounts and other price-bearing proposal fields
- Kill switch for execution-bound actions
- Full decision chain: model proposal, policy verdict, rule ID, execution result
- Razorpay test-mode integration with signed webhook handling
- Simulation environment for repeatable evaluation without live payments
- Static dashboard for decision chains and evaluation results
- Provider-independent LLM interface with Gemini and Ollama implementations

## Design

The central flow is deliberately small:

```text
Strategy.propose(context)
        |
        v
PolicyEngine.decide(proposal, context)
        |
        v
World.execute(approved intent)
```

The model is used for proposal generation and rationale. It is not part of the policy decision or execution authority.

Production and evaluation share the same decision and execution pipeline:

```text
assemble context -> decide -> schedule -> recheck -> execute -> audit
```

The production path uses `RazorpayWorld` and a real scheduler. The evaluation path uses `SimWorld` and a virtual scheduler. This keeps the measured behavior close to the live behavior while avoiding live charges during evaluation.

### Repository layout

```text
src/agent/          Recovery agent, tools, and system prompt
src/commerce/       Buyer agent, catalog tools, and purchase execution
src/policy/         Deterministic policy rules and verdicts
src/run.ts          Shared decide and execute pipeline
src/world/          Razorpay and simulation worlds
src/eval/           Scenario generation, orchestration, and reporting
src/audit/          Decision-chain persistence and queries
scripts/            Demo, seeding, backfill, and evaluation utilities
public/             Static audit and evaluation dashboard
test/               Unit, integration, and end-to-end tests
```

## Policy controls

The policy engine evaluates rules in order and records the first matching rule ID.

| Rule | Control |
| --- | --- |
| P0 | Approve when no rule objects |
| P1 | Maximum recovery attempts per order |
| P2 | Minimum delay between attempts |
| P3 | Never retry terminal failures |
| P4 | No customer contact during restricted IST hours |
| P5 | Maximum customer contacts per order |
| P6 | Executor-owned amount integrity |
| P7 | Idempotency for repeated events |
| P8 | Live payment-status recheck before execution |
| P9 | Value ceiling and human escalation |
| P10 | System-wide execution and contact caps |
| P11 | Staleness cutoff for old failures |
| P12 | One live payment link per order |
| P13 | Global kill switch |
| P14 | Structural refusal of price-bearing message variables |

For purchases, P9 is configured from the buyer mandate. A purchase above the mandate is rewritten into a human escalation. The executor reads prices from the catalog rather than from model input and checks stock immediately before creating the order.

## Evaluation

The committed pilot uses 40 synthetic scenarios and one seed. It compares the recovery agent with deterministic baselines on the same scenarios and execution path.

| Strategy | Recovery | Net recovered | Wasted attempts | Contacts per recovery |
| --- | ---: | ---: | ---: | ---: |
| No retry | 0.0% | ₹0 | 0 | - |
| Fixed 24h | 0.0% | ₹0 | 0 | - |
| Rules engine | 32.5% | ₹8,607 | 27 | 3.08 |
| **Salvage agent** | **40.0%** | **₹12,204** | **24** | **2.50** |
| Oracle, recovery-count ceiling | 55.0% | ₹11,324 | 0 | 1.00 |

The paired bootstrap estimate is **+₹89.92 per episode**, with a 95% confidence interval of **[−₹20.25, +₹220.15]**. The interval crosses zero, so this pilot is not a statistically significant result.

The oracle maximizes recovery probability per scenario, not portfolio value. Consequently, the reported 107.8% oracle-headroom value is not evidence that the agent exceeded a theoretical value ceiling. A value-weighted oracle is required for that comparison.

The anchoring analysis measured the agent's contribution as timing adaptation: 0 deviations, 76 retimed attempts, and 15 endorsements. The agent retained the baseline action lever while changing timing on 84% of measured attempts.

All evaluation results are synthetic simulator results, not production recovery estimates. The buyer surface is demonstrated but does not have a comparable ground-truth conversion benchmark.

## Dashboard demo

The dashboard has two views:

- **Decisions:** production-style audit chains, including a normal recovery, a terminal failure rejected by P3, and a payment-status race caught by P8.
- **Eval scoreboard:** the committed pilot results above.

The Decisions view also includes **Run a recovery request**. Choose a failure reason, amount, and execution mode, then watch the configured agent classify the request, propose an action, pass through the policy engine, and record the result. **Simulated** mode uses the real backend pipeline without external side effects. **Razorpay test mode** creates a real test-mode order and creates a real test payment link only when the policy approves a `PAYMENT_LINK`; notifications are disabled and no live customer is charged.

The demo preparation command seeds the decision chains through the real pipeline and copies the committed pilot results into the local dashboard database. The SQLite files are demo/evaluation fixtures, not production data.

```bash
npm install
npm run db:push
npm run demo:prep
npm run dev
```

Open <http://localhost:3000>. The complete presentation script is in [DEMO.md](DEMO.md).

The optional buyer demo requires Razorpay test credentials and an LLM provider:

```bash
npm run seed:buyer
```

## Evaluation commands

Run the test suite and typecheck:

```bash
npm test
npm run typecheck
```

The committed evaluation cache can reproduce the pilot without an API key or a running model:

```bash
LLM_PROVIDER=ollama OLLAMA_MODEL=qwen2.5:7b EVAL_SCENARIOS=40 EVAL_SEEDS=1 npm run eval
```

The full evaluation uses 120 scenarios across three seeds and requires a live model:

```bash
npm run eval
EVAL_CONFIG=A npm run eval
```

The blackout check demonstrates that time-of-day policy rules are applied before execution:

```bash
npm run demo:blackout
```

## Live Razorpay setup

Copy `.env.example` to `.env` and provide test-mode credentials. For webhook testing, expose the local server through a tunnel and register the public webhook URL in the Razorpay dashboard.

The live path supports:

1. A signed `payment.failed` webhook.
2. Failure classification and agent proposal.
3. Policy evaluation and audit logging.
4. Scheduled execution through the configured Razorpay world.
5. A final payment-status recheck before any payment action.

The repository does not claim live mandate-token execution. The `TOKEN_RETRY` implementation is typed against the Razorpay SDK but requires Subscriptions entitlement and a real mandate token to verify.

## Scope and limitations

- Evaluation scenarios and recovery economics are synthetic.
- The pilot is small and its confidence interval crosses zero.
- The buyer agent is demonstrated, not benchmarked against production conversion data.
- Standard agent commerce transports such as UAP, ACP, AP2, and x402 are not implemented; the buyer currently uses an in-process interface.
- The scheduler is process-local and does not survive a restart. A durable queue is required for production deployment.
- Category distributions and attempt/contact costs are configurable simulator assumptions.
- The local SQLite database and committed evaluation cache are suitable for the demo, not production storage.

## License and status

This repository is a working prototype for controlled agentic commerce and payment recovery. It is intended for test-mode evaluation and demonstration, not unattended production money movement.
