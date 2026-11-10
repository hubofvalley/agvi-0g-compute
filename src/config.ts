import { normalizeModelId } from "./identifiers.js";

export type ZeroGTransport = "auto" | "chat-completions" | "messages" | "responses";
export type ConcreteZeroGTransport = Exclude<ZeroGTransport, "auto">;
export type ZeroGTrustMode = "key-default" | "verified" | "private";

export type RoutingConfig = {
  enabled: boolean;
  address?: string;
  identity?: string;
  sort?: "latency";
  allowFallbacks: boolean;
};

export type TrustConfig = {
  mode: ZeroGTrustMode;
  allowDowngrade: boolean;
};

export type TeeVerificationConfig = {
  enabled: boolean;
  required: boolean;
};

export type CapabilityDiscoveryConfig = {
  enabled: boolean;
  ttlSeconds: number;
  timeoutMs: number;
};

export type ObservabilityConfig = {
  enabled: boolean;
};

export type ModelPolicy = {
  transport: ZeroGTransport;
  routing: RoutingConfig;
  trust: TrustConfig;
  teeVerification: TeeVerificationConfig;
  capabilityDiscovery: CapabilityDiscoveryConfig;
  observability: ObservabilityConfig;
};

export type ModelPolicyOverride = Partial<Omit<ModelPolicy, "routing" | "trust" | "teeVerification" | "capabilityDiscovery" | "observability">> & {
  inheritDefaults?: boolean;
  routing?: Partial<RoutingConfig>;
  trust?: Partial<TrustConfig>;
  teeVerification?: Partial<TeeVerificationConfig>;
  capabilityDiscovery?: Partial<CapabilityDiscoveryConfig>;
  observability?: Partial<ObservabilityConfig>;
};

export type ZeroGPluginConfig = {
  defaults?: ModelPolicyOverride;
  models?: Record<string, ModelPolicyOverride>;
};

export const BUILTIN_POLICY: ModelPolicy = {
  transport: "auto",
  routing: {
    enabled: false,
    allowFallbacks: true,
  },
  trust: {
    // 0G documents only `verified` and `private` as per-request overrides.
    // Omitting the header delegates to the API key's configured default.
    mode: "key-default",
    allowDowngrade: false,
  },
  teeVerification: {
    enabled: false,
    required: false,
  },
  capabilityDiscovery: {
    enabled: true,
    ttlSeconds: 300,
    timeoutMs: 5_000,
  },
  observability: {
    enabled: true,
  },
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function copyPolicy(policy: ModelPolicy): ModelPolicy {
  return {
    ...policy,
    routing: { ...policy.routing },
    trust: { ...policy.trust },
    teeVerification: { ...policy.teeVerification },
    capabilityDiscovery: { ...policy.capabilityDiscovery },
    observability: { ...policy.observability },
  };
}

function applyOverride(base: ModelPolicy, override: ModelPolicyOverride | undefined): ModelPolicy {
  if (!override) return copyPolicy(base);
  const next = copyPolicy(base);
  if (override.transport !== undefined) next.transport = override.transport;
  if (override.routing) next.routing = { ...next.routing, ...override.routing };
  if (override.trust) next.trust = { ...next.trust, ...override.trust };
  if (override.teeVerification) next.teeVerification = { ...next.teeVerification, ...override.teeVerification };
  if (override.capabilityDiscovery) next.capabilityDiscovery = { ...next.capabilityDiscovery, ...override.capabilityDiscovery };
  if (override.observability) next.observability = { ...next.observability, ...override.observability };
  if (next.teeVerification.required) next.teeVerification.enabled = true;
  return next;
}

/**
 * Parse only the plugin-owned config surface. The manifest JSON schema remains
 * the primary structural validator; this defensive parser keeps runtime startup
 * deterministic when invoked by tests or older hosts.
 */
export function parsePluginConfig(raw: unknown): ZeroGPluginConfig {
  const record = asRecord(raw);
  if (!record) return {};
  const defaults = asRecord(record.defaults) as ModelPolicyOverride | undefined;
  const rawModels = asRecord(record.models);
  const models: Record<string, ModelPolicyOverride> = {};
  for (const [id, value] of Object.entries(rawModels ?? {})) {
    const entry = asRecord(value);
    if (entry) models[normalizeModelId(id)] = entry as ModelPolicyOverride;
  }
  return {
    ...(defaults ? { defaults } : {}),
    ...(Object.keys(models).length ? { models } : {}),
  };
}

export function resolveModelPolicy(config: ZeroGPluginConfig, modelId: string): ModelPolicy {
  const normalizedModelId = normalizeModelId(modelId);
  const modelOverride = config.models?.[normalizedModelId];
  const base = modelOverride?.inheritDefaults === false
    ? copyPolicy(BUILTIN_POLICY)
    : applyOverride(BUILTIN_POLICY, config.defaults);
  return applyOverride(base, modelOverride);
}
