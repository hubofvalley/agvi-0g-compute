/**
 * Pure cost helpers for the 0G Compute catalog. No runtime imports, so the
 * opt-in tools and tests can use them without loading the OpenClaw SDK.
 * Rates are USD per one million tokens, matching OpenClaw's `cost` fields.
 */
const TOKEN_CLASSES = ["input", "output", "cacheRead", "cacheWrite"];
function tokens(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
/**
 * OpenClaw tier ranges are half-open [start, end); an omitted end is open-ended.
 * 0G applies the tier to the WHOLE request, not only the excess tokens.
 */
export function selectTierRates(cost, requestInputTokens) {
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
export function estimateCost(cost, usage) {
    const tierInputTokens = tokens(usage.input) + tokens(usage.cacheRead) + tokens(usage.cacheWrite);
    const rates = selectTierRates(cost, tierInputTokens);
    let usd = 0;
    const unknownRateClasses = [];
    for (const cls of TOKEN_CLASSES) {
        const count = tokens(usage[cls]);
        if (count === 0)
            continue;
        const rate = rates[cls];
        if (typeof rate !== "number" || !Number.isFinite(rate)) {
            unknownRateClasses.push(cls);
            continue;
        }
        usd += (count * rate) / 1_000_000;
    }
    return { estimated: true, usd, unknownRateClasses, tierInputTokens };
}
