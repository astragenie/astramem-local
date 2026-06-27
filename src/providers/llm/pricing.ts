/**
 * Azure OpenAI pricing table — placeholder rates.
 *
 * UPDATE THESE with actual prices from:
 * https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/
 *
 * Rates are in USD per 1,000,000 tokens (per-1M).
 * Last checked: 2026-06-27 (prices change — verify before production use).
 */
export interface ModelPricing {
  /** USD per 1M input (prompt) tokens */
  in_per_1m_usd: number;
  /** USD per 1M output (completion) tokens */
  out_per_1m_usd: number;
}

export const PRICING: Record<string, ModelPricing> = {
  // PLACEHOLDER: verify at https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/
  'gpt-4.1': { in_per_1m_usd: 2.50, out_per_1m_usd: 10.00 },
  // PLACEHOLDER: verify pricing
  'gpt-4.1-mini': { in_per_1m_usd: 0.15, out_per_1m_usd: 0.60 },
  // PLACEHOLDER: verify pricing
  'gpt-4o': { in_per_1m_usd: 2.50, out_per_1m_usd: 10.00 },
  // PLACEHOLDER: verify pricing
  'gpt-4o-mini': { in_per_1m_usd: 0.15, out_per_1m_usd: 0.60 },
};

/**
 * Compute USD cost from token counts.
 * Returns 0 if the model is not in the pricing table.
 */
export function computeCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const entry = PRICING[model];
  if (!entry) return 0;
  return (
    (promptTokens / 1_000_000) * entry.in_per_1m_usd +
    (completionTokens / 1_000_000) * entry.out_per_1m_usd
  );
}
