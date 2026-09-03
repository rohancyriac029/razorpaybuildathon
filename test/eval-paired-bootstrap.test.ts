import { describe, it, expect } from "vitest";
import { pairedBootstrap } from "../src/eval/paired-bootstrap.js";

describe("pairedBootstrap", () => {
  it("is deterministic: same diffs and seed produce the same CI", () => {
    const diffs = [100, 200, -50, 300, 150, 0, -100, 400];
    const a = pairedBootstrap(diffs, 500, 42);
    const b = pairedBootstrap(diffs, 500, 42);
    expect(a).toEqual(b);
  });

  it("reports significant=true when the difference is consistently positive", () => {
    const diffs = Array.from({ length: 50 }, () => 500 + Math.random() * 100); // always positive, tight spread
    const result = pairedBootstrap(diffs, 1000, 1);
    expect(result.meanDiffPaise).toBeGreaterThan(0);
    expect(result.significant).toBe(true);
    expect(result.ci95LowPaise).toBeGreaterThan(0);
  });

  it("reports significant=false when differences straddle zero with high variance", () => {
    const diffs = [1000, -1000, 800, -900, 1100, -1050, 950, -1000]; // mean near zero, wide spread
    const result = pairedBootstrap(diffs, 2000, 7);
    expect(Math.abs(result.meanDiffPaise)).toBeLessThan(100);
    expect(result.significant).toBe(false);
  });

  it("handles an empty diffs array without throwing", () => {
    const result = pairedBootstrap([]);
    expect(result.n).toBe(0);
    expect(result.significant).toBe(false);
  });

  it("mean of bootstrap resamples approximates the true mean of diffs for a large n", () => {
    const diffs = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 100 : 300)); // true mean = 200
    const result = pairedBootstrap(diffs, 3000, 99);
    expect(result.meanDiffPaise).toBeCloseTo(200, 0);
  });
});
