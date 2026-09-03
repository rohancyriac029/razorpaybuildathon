// Spec §5.4: "Cost per ₹100 recovered, including LLM tokens (a payments
// company thinks in unit economics and will notice if you don't)."
// Prices and FX rate verified live 2026-09-02 — re-verify before quoting
// in a demo, both move.
export const GEMINI_FLASH_LITE_PRICE_USD_PER_M_INPUT_TOKENS = 0.3;
export const GEMINI_FLASH_LITE_PRICE_USD_PER_M_OUTPUT_TOKENS = 2.5;
// Source: openrouter.ai/google/gemini-3.5-flash-lite, fetched 2026-09-02.

export const USD_TO_INR = 95; // Source: exchangerates.org.uk, 2026-09-01 spot ~94.83-94.94; rounded.

export function tokenCostPaise(inputTokens: number, outputTokens: number): number {
  const usd =
    (inputTokens / 1_000_000) * GEMINI_FLASH_LITE_PRICE_USD_PER_M_INPUT_TOKENS +
    (outputTokens / 1_000_000) * GEMINI_FLASH_LITE_PRICE_USD_PER_M_OUTPUT_TOKENS;
  return Math.round(usd * USD_TO_INR * 100); // USD -> INR -> paise
}
