// Spec §5.8 [v2.1]: "run every strategy over the SAME scenarios and report
// the per-scenario paired difference (agent − rules) with a bootstrap CI."
// Paired comparison eliminates most between-scenario variance, which is
// what makes 120 scenarios enough — a difference of means over unpaired
// samples would need far more to say anything with confidence.
import { mulberry32 } from "./rng.js";

export interface PairedBootstrapResult {
  n: number;
  meanDiffPaise: number;
  ci95LowPaise: number;
  ci95HighPaise: number;
  /** True if the 95% CI excludes zero — i.e. the difference is not explainable by noise at this confidence level. */
  significant: boolean;
}

/**
 * `diffs` = one entry per matched (scenario, seed) pair: strategyA's net
 * recovered minus strategyB's, in paise. Resamples with replacement
 * `iterations` times, seeded for reproducibility (spec's own bar: a
 * reviewer re-running this must get the same CI, not a new one each time).
 */
export function pairedBootstrap(diffs: number[], iterations = 2000, seed = 12345): PairedBootstrapResult {
  if (diffs.length === 0) {
    return { n: 0, meanDiffPaise: 0, ci95LowPaise: 0, ci95HighPaise: 0, significant: false };
  }

  const rand = mulberry32(seed);
  const n = diffs.length;
  const meanDiffPaise = diffs.reduce((a, b) => a + b, 0) / n;

  const bootstrapMeans: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rand() * n);
      sum += diffs[idx]!;
    }
    bootstrapMeans.push(sum / n);
  }
  bootstrapMeans.sort((a, b) => a - b);

  const loIdx = Math.floor(iterations * 0.025);
  const hiIdx = Math.floor(iterations * 0.975);
  const ci95LowPaise = bootstrapMeans[loIdx]!;
  const ci95HighPaise = bootstrapMeans[hiIdx]!;

  return {
    n,
    meanDiffPaise,
    ci95LowPaise,
    ci95HighPaise,
    significant: ci95LowPaise > 0 || ci95HighPaise < 0,
  };
}
