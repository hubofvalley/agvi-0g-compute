import { createHash } from "node:crypto";
import { ROUTER_BASE_URL } from "./identifiers.js";
export { ROUTER_BASE_URL };
let modelCache;
let modelRefreshInFlight;
const providerCache = new Map();
const providerRefreshInFlight = new Map();
const MAX_PROVIDER_CACHE_ENTRIES = 128;
function pruneProviderCache(now = Date.now()) {
    for (const [key, cached] of providerCache) {
        if (cached.expiresAt <= now)
            providerCache.delete(key);
    }
    while (providerCache.size >= MAX_PROVIDER_CACHE_ENTRIES) {
        const oldest = providerCache.keys().next().value;
        if (oldest === undefined)
            break;
        providerCache.delete(oldest);
    }
}
export function resetDiscoveryCachesForTests() {
    modelCache = undefined;
    modelRefreshInFlight = undefined;
    providerCache.clear();
    providerRefreshInFlight.clear();
}
function ttlMs(config) {
    return Math.max(1, config.ttlSeconds) * 1_000;
}
function providerCacheKey(modelId, apiKey) {
    const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
    return `${modelId}:${fingerprint}`;
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
async function refreshModels(config, signal) {
    if (modelRefreshInFlight)
        return modelRefreshInFlight;
    const refresh = (async () => {
        const raw = await fetchJson(`${ROUTER_BASE_URL}/models`, { signal }, config.timeoutMs);
        const map = new Map();
        for (const row of raw.data ?? [])
            if (row?.id)
                map.set(row.id, row);
        modelCache = { expiresAt: Date.now() + ttlMs(config), value: map };
    })();
    modelRefreshInFlight = refresh.finally(() => {
        modelRefreshInFlight = undefined;
    });
    return modelRefreshInFlight;
}
/**
 * Fast-path capability lookup for ordinary inference. Fresh cache is returned
 * immediately. Expired cache is served stale while exactly one refresh runs in
 * the background. A cold miss also starts a background refresh but returns
 * undefined so callers can fall back to plugin-owned static capabilities
 * instead of delaying TTFT on discovery I/O.
 */
export function discoverModelSWR(modelId, config, onRefreshError) {
    if (!config.enabled)
        return undefined;
    const now = Date.now();
    const cached = modelCache?.value.get(modelId);
    if (modelCache && modelCache.expiresAt > now)
        return cached;
    void refreshModels(config).catch((error) => onRefreshError?.(error));
    return cached;
}
/** Return the cached/live 0G model inventory in router order. */
export async function discoverModels(config, signal) {
    if (!config.enabled)
        return [];
    const now = Date.now();
    if (!modelCache || modelCache.expiresAt <= now)
        await refreshModels(config, signal);
    return [...(modelCache?.value.values() ?? [])];
}
export async function discoverModel(modelId, config) {
    if (!config.enabled)
        return undefined;
    const now = Date.now();
    if (!modelCache || modelCache.expiresAt <= now) {
        await refreshModels(config);
    }
    return modelCache?.value.get(modelId);
}
async function refreshProviders(modelId, apiKey, config) {
    const cacheKey = providerCacheKey(modelId, apiKey);
    const existing = providerRefreshInFlight.get(cacheKey);
    if (existing)
        return existing;
    pruneProviderCache();
    const refresh = (async () => {
        const url = `${ROUTER_BASE_URL}/providers?model=${encodeURIComponent(modelId)}`;
        const raw = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } }, config.timeoutMs);
        const rows = Array.isArray(raw) ? raw : raw.data ?? [];
        providerCache.set(cacheKey, { expiresAt: Date.now() + ttlMs(config), value: rows });
        return rows;
    })();
    providerRefreshInFlight.set(cacheKey, refresh);
    try {
        return await refresh;
    }
    finally {
        providerRefreshInFlight.delete(cacheKey);
    }
}
export async function discoverProviders(modelId, apiKey, config) {
    if (!config.enabled)
        return [];
    const now = Date.now();
    pruneProviderCache(now);
    const cached = providerCache.get(providerCacheKey(modelId, apiKey));
    if (cached && cached.expiresAt > now)
        return cached.value;
    return refreshProviders(modelId, apiKey, config);
}
