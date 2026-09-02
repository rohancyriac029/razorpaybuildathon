import { describe, it, expect } from "vitest";
import { generateScenarios } from "../src/eval/generator.js";
import { CONFIG_A, CONFIG_B } from "../src/eval/generator-config.js";
import { wouldSucceed } from "../src/eval/ground-truth.js";
import { taxonomyTable } from "../src/taxonomy/classify.js";

const ANCHOR = new Date("2026-09-02T10:00:00Z"); // fixed, not new Date() — see generator.ts's anchorTime doc

describe("generateScenarios", () => {
  it("is deterministic: the same seed always produces the same scenarios", () => {
    const a = generateScenarios(CONFIG_A, 50, 123, ANCHOR);
    const b = generateScenarios(CONFIG_A, 50, 123, ANCHOR);
    expect(a).toEqual(b);
  });

  it("a different seed produces a different scenario set", () => {
    const a = generateScenarios(CONFIG_A, 50, 1, ANCHOR);
    const b = generateScenarios(CONFIG_A, 50, 2, ANCHOR);
    expect(a).not.toEqual(b);
  });

  it("category mix roughly tracks the config's proportions (n=1000, generous tolerance)", () => {
    const scenarios = generateScenarios(CONFIG_A, 1000, 7, ANCHOR);
    const counts: Record<string, number> = {};
    for (const s of scenarios) counts[s.category] = (counts[s.category] ?? 0) + 1;

    for (const [category, expectedShare] of Object.entries(CONFIG_A.categoryMix)) {
      const actualShare = (counts[category] ?? 0) / 1000;
      expect(actualShare).toBeGreaterThan(expectedShare - 0.08);
      expect(actualShare).toBeLessThan(expectedShare + 0.08);
    }
  });

  it("config B's AUTH_ABANDONED perturbation is reflected in generated scenarios", () => {
    const scenariosA = generateScenarios(CONFIG_A, 1000, 7, ANCHOR);
    const scenariosB = generateScenarios(CONFIG_B, 1000, 7, ANCHOR);
    const shareA = scenariosA.filter((s) => s.category === "AUTH_ABANDONED").length / 1000;
    const shareB = scenariosB.filter((s) => s.category === "AUTH_ABANDONED").length / 1000;
    expect(shareB).toBeGreaterThan(shareA); // config B deliberately shifts toward AUTH_ABANDONED
  });

  it("every generated errorReason is a real taxonomy key that classifies back to the same category", () => {
    const scenarios = generateScenarios(CONFIG_A, 200, 3, ANCHOR);
    const table = new Map(taxonomyTable().map((r) => [r.reason, r.category]));
    for (const s of scenarios) {
      expect(table.get(s.errorReason)).toBe(s.category);
    }
  });

  it("first-time customers get no history; repeat customers get 1-5 entries", () => {
    const scenarios = generateScenarios(CONFIG_A, 300, 9, ANCHOR);
    for (const s of scenarios) {
      if (s.isFirstTime) {
        expect(s.history).toHaveLength(0);
      } else {
        expect(s.history.length).toBeGreaterThanOrEqual(1);
        expect(s.history.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it("TERMINAL scenarios never succeed regardless of proposal or timing", () => {
    const scenarios = generateScenarios(CONFIG_A, 300, 11, ANCHOR).filter((s) => s.category === "TERMINAL");
    expect(scenarios.length).toBeGreaterThan(0);
    for (const s of scenarios) {
      const proposal = {
        type: "PAYMENT_LINK" as const,
        orderId: "x",
        attemptNumber: 1,
        reasoning: "",
        proposedAt: "",
        sendAt: "",
        channel: "whatsapp" as const,
      };
      expect(wouldSucceed(s, proposal, new Date(), CONFIG_A)).toBe(false);
    }
  });

  it("FUNDS scenarios succeed meaningfully more often when the proposal lands in the customer's true window than when it doesn't", () => {
    const scenarios = generateScenarios(CONFIG_A, 300, 21, ANCHOR).filter((s) => s.category === "FUNDS");
    let wellTimed = 0;
    let badlyTimed = 0;
    for (const s of scenarios) {
      const proposal = {
        type: "PAYMENT_LINK" as const,
        orderId: "x",
        attemptNumber: 1,
        reasoning: "",
        proposedAt: "",
        sendAt: "",
        channel: "whatsapp" as const,
      };
      const [lo] = CONFIG_A.liquidityDaysOfMonth;
      const good = new Date(s.occurredAt);
      good.setUTCDate(lo);
      good.setUTCHours(s.liquidityHourIst - 5, 30, 0, 0);
      if (wouldSucceed(s, proposal, good, CONFIG_A)) wellTimed++;

      const bad = new Date(s.occurredAt);
      bad.setUTCDate(15);
      bad.setUTCHours(((s.liquidityHourIst + 8) % 24) - 5, 30, 0, 0);
      if (wouldSucceed(s, proposal, bad, CONFIG_A)) badlyTimed++;
    }
    // Real timing sensitivity, not a token difference — this is the signal
    // the whole project's timing claim depends on being genuinely present.
    expect(wellTimed).toBeGreaterThan(badlyTimed * 2);
  });
});
