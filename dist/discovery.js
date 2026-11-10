export const ROUTER_BASE_URL = "https://router-api.0g.ai/v1";
let modelCache;
const providerCache = new Map();
export function resetDiscoveryCachesForTests() {
    modelCache = undefined;
    providerCache.clear();
}
function ttlMs(config) {
    return Math.max(1, config.ttlSeconds) * 1_000;
}
async function fetchJson(url, init, timeoutMs) {
    const signal = init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { ...init, signal });
    if (!response.ok)
        throw new Error(`0G discovery HTTP ${response.status}`);
    return response.json();
}
export async function discoverModel(modelId, config) {
    if (!config.enabled)
        return undefined;
    const now = Date.now();
    if (!modelCache || modelCache.expiresAt <= now) {
        const raw = await fetchJson(`${ROUTER_BASE_URL}/models`, {}, config.timeoutMs);
        const map = new Map();
        for (const row of raw.data ?? [])
            if (row?.id)
                map.set(row.id, row);
        modelCache = { expiresAt: now + ttlMs(config), value: map };
    }
    return modelCache.value.get(modelId);
}
export async function discoverProviders(modelId, apiKey, config) {
    if (!config.enabled)
        return [];
    const now = Date.now();
    const cached = providerCache.get(modelId);
    if (cached && cached.expiresAt > now)
        return cached.value;
    const url = `${ROUTER_BASE_URL}/providers?model=${encodeURIComponent(modelId)}`;
    const raw = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } }, config.timeoutMs);
    const rows = Array.isArray(raw) ? raw : raw.data ?? [];
    providerCache.set(modelId, { expiresAt: now + ttlMs(config), value: rows });
    return rows;
}
