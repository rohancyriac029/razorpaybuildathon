// Spec §6 block 6 Phase 5: the agent loop. Episode = the order (spec §3):
// on each invocation the agent receives its prior reasoning, proposal,
// verdict, and outcome via getFailureContext's priorAttempts — that's what
// turns this from a single-step classifier into a genuine multi-step
// trajectory with feedback.
//
// Fallback (spec §3.1.1): malformed output, an LLM error, a timeout, or the
// loop exceeding its step budget all fall back to RulesStrategy.propose()
// rather than escalating into a queue nobody drains. Same code, dual use —
// RulesStrategy is both the ablation baseline (block 5) and this.
import type { Strategy } from "../ports/strategy.js";
import type { LlmClient, LlmTurn } from "../llm/client.js";
import type { RulesStrategy } from "../strategies/rules.js";
import type { EpisodeContext, Proposal } from "../types.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import {
  ALL_TOOLS,
  READ_TOOL_NAMES,
  PROPOSE_TOOL_NAMES,
  getFailureContextResult,
  getCustomerHistoryResult,
  buildProposalFromToolCall,
} from "./tools.js";

const KICKOFF_MESSAGE =
  "A payment has failed. Investigate using your tools, then propose exactly one action. Call getFailureContext first, always.";

export class AgentStrategy implements Strategy {
  readonly name = "salvage-agent";

  /** Set by the most recent propose() call — the eval (block 8) reads these for the §5.5.1 offer-attempt metric, the fallback-rate metric, and the §5.4 cost-per-₹100-recovered metric (llm-pricing.ts prices lastUsage). Not part of the Strategy port's return type; adding fields there would ripple through every strategy for metrics only the agent needs. */
  lastOfferAttempted = false;
  lastFellBackToRules = false;
  lastFallbackReason: string | null = null;
  lastUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(
    private readonly llm: LlmClient,
    private readonly fallback: RulesStrategy,
    private readonly maxSteps: number = 8,
  ) {}

  async propose(ctx: EpisodeContext): Promise<Proposal> {
    this.lastOfferAttempted = false;
    this.lastFellBackToRules = false;
    this.lastFallbackReason = null;
    this.lastUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      return await this.runLoop(ctx);
    } catch (err) {
      this.lastFellBackToRules = true;
      this.lastFallbackReason = err instanceof Error ? err.message : String(err);
      return this.fallback.propose(ctx);
    }
  }

  private async runLoop(ctx: EpisodeContext): Promise<Proposal> {
    const turns: LlmTurn[] = [];

    for (let step = 0; step < this.maxSteps; step++) {
      const { toolCall, usage } = await this.llm.complete({
        systemPrompt: SYSTEM_PROMPT,
        userMessage: KICKOFF_MESSAGE,
        tools: ALL_TOOLS,
        turns,
      });
      this.lastUsage.inputTokens += usage.inputTokens;
      this.lastUsage.outputTokens += usage.outputTokens;
      turns.push({ role: "assistant", toolCall });

      if (READ_TOOL_NAMES.has(toolCall.name)) {
        const result =
          toolCall.name === "getFailureContext" ? getFailureContextResult(ctx) : getCustomerHistoryResult(ctx);
        turns.push({ role: "tool_result", toolCallId: toolCall.id, toolName: toolCall.name, content: JSON.stringify(result) });
        continue;
      }

      if (PROPOSE_TOOL_NAMES.has(toolCall.name)) {
        const outcome = buildProposalFromToolCall(toolCall.name, toolCall.input, ctx);
        if (outcome.offerAttempted) this.lastOfferAttempted = true;
        if (outcome.proposal) return outcome.proposal;

        // Refused (bad template, disallowed var, failed Zod validation) —
        // feed the reason back and let the model correct itself within the
        // same episode, rather than failing the whole thing on one bad call.
        turns.push({
          role: "tool_result",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: outcome.refusalMessage ?? "refused",
        });
        continue;
      }

      turns.push({
        role: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: `Unknown tool "${toolCall.name}". Available: ${ALL_TOOLS.map((t) => t.name).join(", ")}.`,
      });
    }

    throw new Error(`agent exceeded ${this.maxSteps} steps without producing a valid proposal`);
  }
}
