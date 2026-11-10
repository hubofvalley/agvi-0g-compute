/**
 * Pure cost helpers for the 0G Compute catalog. No runtime imports, so the
 * opt-in tools and tests can use them without loading the OpenClaw SDK.
 * Rates are USD per one million tokens, matching OpenClaw's `cost` fields.
 */

export type TierRates = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type PricingTier = TierRates & { range: readonly number[] };

export type ModelCost = TierRates & { tieredPricing?: readonly PricingTier[] };

export type TokenUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type TokenClass = keyof TokenUsage;

export type CostEstimate = {
  /** Always an estimate: provider billing is the source of truth. */
  estimated: true;
  usd: number;
  /** Token classes that had tokens but no usable rate; excluded from `usd`. */
  unknownRateClasses: TokenClass[];
  /** Input length used for tier selection (input + cacheRead + cacheWrite). */
  tierInputTokens: number;
};

const TOKEN_CLASSES: readonly TokenClass[] = ["input", "output", "cacheRead", "cacheWrite"];

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * OpenClaw tier ranges are half-open [start, end); an omitted end is open-ended.
 * 0G applies the tier to the WHOLE request, not only the excess tokens.
 */
export function selectTierRates(cost: ModelCost, requestInputTokens: number): TierRates {
  for (const tier of cost.tieredPricing ?? []) {
    const [start, end] = tier.range;
    if (requestInputTokens >= start && (end === undefined || requestInputTokens < end)) {
      return tier;
    }
  }
  return cost;
}

/**
 * Estimates USD cost for one request. Tier selection counts cached tokens in
 * the input length; whether 0G counts cached tokens toward the 100,000 threshold
 * is NOT verified, so treat tier-boundary results as estimates.
 */
export function estimateCost(cost: ModelCost, usage: TokenUsage): CostEstimate {
  const tierInputTokens = tokens(usage.input) + tokens(usage.cacheRead) + tokens(usage.cacheWrite);
  const rates = selectTierRates(cost, tierInputTokens);
  let usd = 0;
  const unknownRateClasses: TokenClass[] = [];
  for (const cls of TOKEN_CLASSES) {
    const count = tokens(usage[cls]);
    if (count === 0) continue;
    const rate = rates[cls];
    if (typeof rate !== "number" || !Number.isFinite(rate)) {
      unknownRateClasses.push(cls);
      continue;
    }
    usd += (count * rate) / 1_000_000;
  }
  return { estimated: true, usd, unknownRateClasses, tierInputTokens };
}
