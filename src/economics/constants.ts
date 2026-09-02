// Placeholder cost estimates for the "net ₹ recovered" metric (spec §5.4:
// "Net ₹ recovered (recovered − attempt cost − estimated churn cost of
// contacts)"). These are round-number stand-ins, not sourced figures —
// unlike the taxonomy (block 1), there's no equivalent published number
// for "cost of one payment-link send" or "goodwill cost of a contact."
// Revisit with a cited source before the eval's headline numbers are final;
// until then, every number downstream of these is honest only as a
// *relative* comparison between strategies, never as an absolute rupee claim.
export const ATTEMPT_COST_PAISE = 200; // ₹2 — rough gateway/messaging cost per attempt
export const CONTACT_GOODWILL_COST_PAISE = 500; // ₹5 — proxy cost of spent customer goodwill per contact
