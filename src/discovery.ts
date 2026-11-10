import { createHash } from "node:crypto";
import type { CapabilityDiscoveryConfig } from "./config.js";

export const ROUTER_BASE_URL = "https://router-api.0g.ai/v1";

export type RemoteModelCapability = {
  id: string;
  context_length?: number;
  max_completion_tokens?: number;
  supported_formats?: string[];
  supported_parameters?: string[];
  provider_count?: number;
  verifiability?: string | null;
  tee_attested?: boolean | null;
  tee_verifier?: string | null;
};

export type RemoteProviderCapability = {
  address?: string;
  provider_identity?: string;
  provider_name?: string;
  provider_country?: string;
  is_healthy?: boolean;
  trust_mode?: string;
  tee_acknowledged?: boolean;
  tee_attested?: boolean;
  tee_type?: string;
  tee_verifier?: string;
};

type Timed<T> = { expiresAt: number; value: T };

let modelCache: Timed<Map<string, RemoteModelCapability>> | undefined;
let modelRefreshInFlight: Promise<void> | undefined;
const providerCache = new Map<string, Timed<RemoteProviderCapability[]>>();
const providerRefreshInFlight = new Map<string, Promise<RemoteProviderCapability[]>>();

export function resetDiscoveryCachesForTests(): void {
  modelCache = undefined;
  modelRefreshInFlight = undefined;
  providerCache.clear();
  providerRefreshInFlight.clear();
}

function ttlMs(config: CapabilityDiscoveryConfig): number {
  return Math.max(1, config.ttlSeconds) * 1_000;
}

function providerCacheKey(modelId: string, apiKey: string): string {
  const fingerprint = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  return `${modelId}:${fingerprint}`;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) throw new Error(`0G discovery HTTP ${response.status}`);
  return response.json();
}

async function refreshModels(config: CapabilityDiscoveryConfig): Promise<void> {
  if (modelRefreshInFlight) return modelRefreshInFlight;
  const refresh = (async () => {
    const raw = await fetchJson(`${ROUTER_BASE_URL}/models`, {}, config.timeoutMs) as { data?: RemoteModelCapability[] };
    const map = new Map<string, RemoteModelCapability>();
    for (const row of raw.data ?? []) if (row?.id) map.set(row.id, row);
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
export function discoverModelSWR(
  modelId: string,
  config: CapabilityDiscoveryConfig,
  onRefreshError?: (error: unknown) => void,
): RemoteModelCapability | undefined {
  if (!config.enabled) return undefined;
  const now = Date.now();
  const cached = modelCache?.value.get(modelId);
  if (modelCache && modelCache.expiresAt > now) return cached;

  void refreshModels(config).catch((error) => onRefreshError?.(error));
  return cached;
}

export async function discoverModel(
  modelId: string,
  config: CapabilityDiscoveryConfig,
): Promise<RemoteModelCapability | undefined> {
  if (!config.enabled) return undefined;
  const now = Date.now();
  if (!modelCache || modelCache.expiresAt <= now) {
    await refreshModels(config);
  }
  return modelCache?.value.get(modelId);
}

async function refreshProviders(
  modelId: string,
  apiKey: string,
  config: CapabilityDiscoveryConfig,
): Promise<RemoteProviderCapability[]> {
  const cacheKey = providerCacheKey(modelId, apiKey);
  const existing = providerRefreshInFlight.get(cacheKey);
  if (existing) return existing;
  const refresh = (async () => {
    const url = `${ROUTER_BASE_URL}/providers?model=${encodeURIComponent(modelId)}`;
    const raw = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } }, config.timeoutMs) as { data?: RemoteProviderCapability[] } | RemoteProviderCapability[];
    const rows = Array.isArray(raw) ? raw : raw.data ?? [];
    providerCache.set(cacheKey, { expiresAt: Date.now() + ttlMs(config), value: rows });
    return rows;
  })();
  providerRefreshInFlight.set(cacheKey, refresh);
  try {
    return await refresh;
  } finally {
    providerRefreshInFlight.delete(cacheKey);
  }
}

export async function discoverProviders(
  modelId: string,
  apiKey: string,
  config: CapabilityDiscoveryConfig,
): Promise<RemoteProviderCapability[]> {
  if (!config.enabled) return [];
  const now = Date.now();
  const cached = providerCache.get(providerCacheKey(modelId, apiKey));
  if (cached && cached.expiresAt > now) return cached.value;
  return refreshProviders(modelId, apiKey, config);
}
