// v3 agentic-commerce surface (spec §5). Mirrors src/agent/tools.ts's shape
// exactly: Zod validation at the LLM boundary, malformed input refused with
// a message fed back to the model, never thrown. Two read tools
// (searchCatalog, getMandate) and two propose tools (proposePurchase,
// escalate) — no markTerminal/proposeNudge analog exists for a buyer.
import { z } from "zod";
import type { LlmToolDef } from "../llm/client.js";
import type { BuyerContext, EscalateProposal, Proposal, PurchaseProposal } from "../types.js";
import { loadCatalog } from "./catalog.js";
import { isPriceBearingVar } from "../messaging/templates.js";

// --- Read tools --------------------------------------------------------

export const SEARCH_CATALOG_TOOL: LlmToolDef = {
  name: "searchCatalog",
  description:
    "List every item the merchant sells: sku, name, price in paise, category, and whether it's in stock. Call this before proposing a purchase.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export const GET_MANDATE_TOOL: LlmToolDef = {
  name: "getMandate",
  description:
    "Your spending mandate: the per-purchase ceiling, your total lifetime budget, how much of it you've already spent, and which catalog categories you're allowed to transact in. You do not enforce this yourself — a policy engine does, after you propose — but knowing it avoids proposing something you already know will be rejected.",
  inputSchema: { type: "object", properties: {}, required: [] },
};

export function searchCatalogResult() {
  return loadCatalog();
}

export function getMandateResult(ctx: BuyerContext) {
  return {
    maxPerOrderPaise: ctx.mandate.maxPerOrderPaise,
    maxTotalPaise: ctx.mandate.maxTotalPaise,
    spentSoFarPaise: ctx.spentSoFarPaise,
    remainingTotalPaise: ctx.mandate.maxTotalPaise - ctx.spentSoFarPaise,
    allowedCategories: ctx.mandate.allowedCategories,
  };
}

// --- Propose tools -------------------------------------------------------
// No price/amount field on proposePurchase — deliberate (mirrors P6/P14's
// discipline for recovery proposals). sku/quantity only; the executor reads
// price from the catalog, never from the model.

const proposePurchaseInput = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().min(1),
  reasoning: z.string().min(1),
});

export const PROPOSE_PURCHASE_TOOL: LlmToolDef = {
  name: "proposePurchase",
  description:
    "Propose buying one catalog item, by sku and quantity. You have no way to express a price, discount, or amount here — there is no such field. A deterministic policy engine checks this against your mandate before anything is charged.",
  inputSchema: {
    type: "object",
    properties: {
      sku: { type: "string", description: "Must match a sku from searchCatalog." },
      quantity: { type: "integer", description: "Number of units, at least 1." },
      reasoning: { type: "string", description: "Why this purchase, now. Logged and shown to reviewers." },
    },
    required: ["sku", "quantity", "reasoning"],
  },
};

const escalateInput = z.object({ reasoning: z.string().min(1), explanation: z.string().min(1) });

export const BUYER_ESCALATE_TOOL: LlmToolDef = {
  name: "escalate",
  description:
    "Propose nothing; route to a human. Always safe. Use when the catalog doesn't have what's needed, when a purchase would need something you have no authority over (a discount, a custom price, a payment plan), or when your mandate clearly can't cover anything relevant.",
  inputSchema: {
    type: "object",
    properties: { reasoning: { type: "string" }, explanation: { type: "string" } },
    required: ["reasoning", "explanation"],
  },
};

export const BUYER_TOOLS: LlmToolDef[] = [
  SEARCH_CATALOG_TOOL,
  GET_MANDATE_TOOL,
  PROPOSE_PURCHASE_TOOL,
  BUYER_ESCALATE_TOOL,
];

export const BUYER_READ_TOOL_NAMES = new Set(["searchCatalog", "getMandate"]);
export const BUYER_PROPOSE_TOOL_NAMES = new Set(["proposePurchase", "escalate"]);

export interface BuyerToolOutcome {
  proposal: Proposal | null;
  /** True iff the model tried to smuggle a price-bearing field into proposePurchase — P14's discipline, applied to the buyer. */
  offerAttempted: boolean;
  refusalMessage: string | null;
}

function refused(message: string): BuyerToolOutcome {
  return { proposal: null, offerAttempted: false, refusalMessage: message };
}

export function buildPurchaseProposalFromToolCall(
  toolName: string,
  rawInput: unknown,
  ctx: BuyerContext,
): BuyerToolOutcome {
  const base = {
    orderId: ctx.order.id,
    attemptNumber: 1, // v3 scope: one purchase attempt per order (no retry loop for a buyer)
    proposedAt: ctx.now.toISOString(),
  };

  switch (toolName) {
    case "proposePurchase": {
      // Structural no-price-authority check, same pattern as agent/tools.ts's
      // P14 enforcement: any key on the RAW input that looks price-bearing
      // is refused before Zod even runs, so a model that invents an extra
      // "discount"/"price" field never gets a Proposal out of it.
      if (rawInput && typeof rawInput === "object") {
        const priceBearingKeys = Object.keys(rawInput as Record<string, unknown>).filter(isPriceBearingVar);
        if (priceBearingKeys.length > 0) {
          return {
            proposal: null,
            offerAttempted: true,
            refusalMessage:
              "You have no price authority. proposePurchase has no price/discount/amount field — remove it and propose sku + quantity only, or escalate if a non-standard price is genuinely what's needed.",
          };
        }
      }

      const parsed = proposePurchaseInput.safeParse(rawInput);
      if (!parsed.success) return refused(parsed.error.message);

      const proposal: PurchaseProposal = { type: "PURCHASE", ...base, ...parsed.data };
      return { proposal, offerAttempted: false, refusalMessage: null };
    }
    case "escalate": {
      const parsed = escalateInput.safeParse(rawInput);
      if (!parsed.success) return refused(parsed.error.message);
      const proposal: EscalateProposal = { type: "ESCALATE", ...base, ...parsed.data };
      return { proposal, offerAttempted: false, refusalMessage: null };
    }
    default:
      return refused(`Unknown tool "${toolName}".`);
  }
}
