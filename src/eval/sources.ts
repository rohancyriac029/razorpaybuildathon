// Spec §5.2 point 1: "Publish the generator; parameterise it from cited
// sources... Then the generator is a stated model, not a hunch."
//
// Every numeric constant in generator-config.ts traces back to one of the
// citations below, OR is explicitly marked as this build's own estimate
// where no single citable source gave a clean number. Both are stated
// honestly — claiming a citation for a number a source didn't actually
// give would be worse than not having one; the existing pattern in this
// build (economics/constants.ts, block 3) is the same: cite what's real,
// flag what's estimated, never blur the two.
//
// Fetched live, 2026-09-02. Re-verify before quoting in a demo — these are
// blog/report pages, not academic papers, and can change.

export const SOURCES = {
  retentionLensStateOfInvoluntaryChurn2026: {
    url: "https://retentionlens.com/state-of-involuntary-churn",
    findings: [
      "20-40% of total SaaS churn is involuntary (failed payments)",
      "Recovery rate by approach: no retries ~0-10%; basic fixed-interval retries ~20-40%; industry median ~47.6%; smart retries + card-updater + email 70-85%",
      "Smart/timing-aware retry lifts recovery roughly 25% (relative) over fixed intervals",
      "Card-updater services recover up to 20% of invoices before a retry is even attempted",
      "Credit cards fail at an average rate near 15%; ACH/direct-debit failures are lower, ~3-5%",
    ],
  },
  baremetricsWhySubscriptionPaymentsFail: {
    url: "https://baremetrics.com/blog/why-subscription-payments-fail",
    findings: [
      "Average company loses ~9% of monthly recurring revenue to failed payments",
      "Most soft declines resolve within 24-48 hours via smart retries",
      "Median 12.7% attempted-recovery rate across a sample of 119 B2B SaaS companies",
    ],
  },
  recurlyChurnRateBenchmarks: {
    url: "https://recurly.com/research/churn-rate-benchmarks/",
    findings: [
      "Expired/reissued cards are described as the single largest cause of involuntary churn",
      "Other common causes, in the order given: outdated billing credentials, bank-level fraud flags, credit limit hits/insufficient funds at renewal",
      "Explicitly does NOT give a percentage breakdown by decline reason — checked directly, not assumed",
      "Median annual total churn by industry (Jul 2026): SaaS 3.22%, B2B services 3.44%, travel/hospitality 3.91%, digital media 4.14%, ecommerce 4.25%, education 4.99%",
    ],
  },
} as const;

// What is NOT cited, stated plainly: no source found gave a clean
// percentage breakdown across this taxonomy's five categories (TRANSIENT/
// FUNDS/AUTH_ABANDONED/INSTRUMENT/TERMINAL) — industry reporting groups by
// card-network decline code, which doesn't map 1:1 onto this taxonomy
// (AUTH_ABANDONED in particular is a UPI/India-specific pattern the
// US-centric SaaS-dunning sources above don't cover at all). The category
// MIX in generator-config.ts is this build's own estimate, informed by the
// qualitative claims above (expired-card/INSTRUMENT is the largest single
// cause; FUNDS is a major soft-decline category) — not a lifted number.
// Same for the payroll/salary-cycle liquidity-window mechanism: widely
// assumed in payments-industry discussion, but no single source found here
// quantified it, so it is modeled as a stated assumption, not a citation.
export const UNCITED_ASSUMPTIONS = [
  "Category mix (% TRANSIENT/FUNDS/AUTH_ABANDONED/INSTRUMENT/TERMINAL): this build's estimate, informed by but not lifted from the sources above.",
  "Salary-cycle liquidity windows (days 1-7 concentration): industry-common assumption, not independently quantified by any source checked.",
  "AUTH_ABANDONED prevalence: no US-centric SaaS-dunning source covers UPI-style OTP/collect abandonment at all; this is a domain judgment call, not a citation.",
] as const;
