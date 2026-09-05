// v3 agentic-commerce surface (spec §5). Mirrors src/agent/agent-strategy.ts's
// multi-turn loop closely, with one deliberate asymmetry: AgentStrategy
// falls back to RulesStrategy.propose() on any error, because a sensible
// default recovery action exists (wait, or nudge later). There is no
// equivalent safe default purchase — buying the wrong thing is not a safer
// failure mode than buying nothing — so BuyerAgent's fallback is to
// ESCALATE, never to guess a purchase. Does NOT implement the Strategy
// port (see decide-purchase.ts and the BuyerContext comment in types.ts
// for why).
import type { LlmClient, LlmTurn } from "../llm/client.js";
import type { BuyerContext, EscalateProposal, Proposal } from "../types.js";
import { BUYER_SYSTEM_PROMPT } from "./buyer-system-prompt.js";
import {
  BUYER_TOOLS,
  BUYER_READ_TOOL_NAMES,
  BUYER_PROPOSE_TOOL_NAMES,
  searchCatalogResult,
  getMandateResult,
  buildPurchaseProposalFromToolCall,
} from "./buyer-tools.js";
import type { BuyerAgentLike } from "./decide-purchase.js";

function kickoffMessage(ctx: BuyerContext): string {
  return `${ctx.intent} Investigate using your tools, then propose exactly one action. Call searchCatalog and getMandate first, always.`;
}

export class BuyerAgent implements BuyerAgentLike {
  readonly name = "buyer-agent";

  /** Mirrors AgentStrategy's instance fields — read by the demo seeder / any future eval for the same metrics. */
  lastOfferAttempted = false;
  lastFellBackToEscalate = false;
  lastFallbackReason: string | null = null;
  lastUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(
    private readonly llm: LlmClient,
    private readonly maxSteps: number = 8,
  ) {}

  async propose(ctx: BuyerContext): Promise<Proposal> {
    this.lastOfferAttempted = false;
    this.lastFellBackToEscalate = false;
    this.lastFallbackReason = null;
    this.lastUsage = { inputTokens: 0, outputTokens: 0 };

    try {
      return await this.runLoop(ctx);
    } catch (err) {
      // No safe default purchase exists — a buyer that cannot think must
      // not spend. Escalate, don't guess.
      this.lastFellBackToEscalate = true;
      this.lastFallbackReason = err instanceof Error ? err.message : String(err);
      const escalation: EscalateProposal = {
        type: "ESCALATE",
        orderId: ctx.order.id,
        attemptNumber: 1,
        reasoning: "buyer agent failed to produce a valid proposal",
        proposedAt: ctx.now.toISOString(),
        explanation: `Buyer agent error, routed to a human rather than guessing a purchase: ${this.lastFallbackReason}`,
      };
      return escalation;
    }
  }

  private async runLoop(ctx: BuyerContext): Promise<Proposal> {
    const turns: LlmTurn[] = [];

    for (let step = 0; step < this.maxSteps; step++) {
      const { toolCall, usage } = await this.llm.complete({
        systemPrompt: BUYER_SYSTEM_PROMPT,
        userMessage: kickoffMessage(ctx),
        tools: BUYER_TOOLS,
        turns,
      });
      this.lastUsage.inputTokens += usage.inputTokens;
      this.lastUsage.outputTokens += usage.outputTokens;
      turns.push({ role: "assistant", toolCall });

      if (BUYER_READ_TOOL_NAMES.has(toolCall.name)) {
        const result = toolCall.name === "searchCatalog" ? searchCatalogResult() : getMandateResult(ctx);
        turns.push({ role: "tool_result", toolCallId: toolCall.id, toolName: toolCall.name, content: JSON.stringify(result) });
        continue;
      }

      if (BUYER_PROPOSE_TOOL_NAMES.has(toolCall.name)) {
        const outcome = buildPurchaseProposalFromToolCall(toolCall.name, toolCall.input, ctx);
        if (outcome.offerAttempted) this.lastOfferAttempted = true;
        if (outcome.proposal) return outcome.proposal;

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
        content: `Unknown tool "${toolCall.name}". Available: ${BUYER_TOOLS.map((t) => t.name).join(", ")}.`,
      });
    }

    throw new Error(`buyer agent exceeded ${this.maxSteps} steps without producing a valid proposal`);
  }
}
