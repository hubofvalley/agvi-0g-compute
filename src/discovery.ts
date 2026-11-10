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
const providerCache = new Map<string, Timed<RemoteProviderCapability[]>>();

export function resetDiscoveryCachesForTests(): void {
  modelCache = undefined;
  providerCache.clear();
}

function ttlMs(config: CapabilityDiscoveryConfig): number {
  return Math.max(1, config.ttlSeconds) * 1_000;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) throw new Error(`0G discovery HTTP ${response.status}`);
  return response.json();
}

export async function discoverModel(
  modelId: string,
  config: CapabilityDiscoveryConfig,
): Promise<RemoteModelCapability | undefined> {
  if (!config.enabled) return undefined;
  const now = Date.now();
  if (!modelCache || modelCache.expiresAt <= now) {
    const raw = await fetchJson(`${ROUTER_BASE_URL}/models`, {}, config.timeoutMs) as { data?: RemoteModelCapability[] };
    const map = new Map<string, RemoteModelCapability>();
    for (const row of raw.data ?? []) if (row?.id) map.set(row.id, row);
    modelCache = { expiresAt: now + ttlMs(config), value: map };
  }
  return modelCache.value.get(modelId);
}

export async function discoverProviders(
  modelId: string,
  apiKey: string,
  config: CapabilityDiscoveryConfig,
): Promise<RemoteProviderCapability[]> {
  if (!config.enabled) return [];
  const now = Date.now();
  const cached = providerCache.get(modelId);
  if (cached && cached.expiresAt > now) return cached.value;
  const url = `${ROUTER_BASE_URL}/providers?model=${encodeURIComponent(modelId)}`;
  const raw = await fetchJson(url, { headers: { Authorization: `Bearer ${apiKey}` } }, config.timeoutMs) as { data?: RemoteProviderCapability[] } | RemoteProviderCapability[];
  const rows = Array.isArray(raw) ? raw : raw.data ?? [];
  providerCache.set(modelId, { expiresAt: now + ttlMs(config), value: rows });
  return rows;
}
