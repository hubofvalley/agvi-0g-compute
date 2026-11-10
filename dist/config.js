export const BUILTIN_POLICY = {
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
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function copyPolicy(policy) {
    return {
        ...policy,
        routing: { ...policy.routing },
        trust: { ...policy.trust },
        teeVerification: { ...policy.teeVerification },
        capabilityDiscovery: { ...policy.capabilityDiscovery },
        observability: { ...policy.observability },
    };
}
function applyOverride(base, override) {
    if (!override)
        return copyPolicy(base);
    const next = copyPolicy(base);
    if (override.transport !== undefined)
        next.transport = override.transport;
    if (override.routing)
        next.routing = { ...next.routing, ...override.routing };
    if (override.trust)
        next.trust = { ...next.trust, ...override.trust };
    if (override.teeVerification)
        next.teeVerification = { ...next.teeVerification, ...override.teeVerification };
    if (override.capabilityDiscovery)
        next.capabilityDiscovery = { ...next.capabilityDiscovery, ...override.capabilityDiscovery };
    if (override.observability)
        next.observability = { ...next.observability, ...override.observability };
    if (next.teeVerification.required)
        next.teeVerification.enabled = true;
    return next;
}
/**
 * Parse only the plugin-owned config surface. The manifest JSON schema remains
 * the primary structural validator; this defensive parser keeps runtime startup
 * deterministic when invoked by tests or older hosts.
 */
export function parsePluginConfig(raw) {
    const record = asRecord(raw);
    if (!record)
        return {};
    const defaults = asRecord(record.defaults);
    const rawModels = asRecord(record.models);
    const models = {};
    for (const [id, value] of Object.entries(rawModels ?? {})) {
        const entry = asRecord(value);
        if (entry)
            models[id] = entry;
    }
    return {
        ...(defaults ? { defaults } : {}),
        ...(Object.keys(models).length ? { models } : {}),
    };
}
export function resolveModelPolicy(config, modelId) {
    const modelOverride = config.models?.[modelId];
    const base = modelOverride?.inheritDefaults === false
        ? copyPolicy(BUILTIN_POLICY)
        : applyOverride(BUILTIN_POLICY, config.defaults);
    return applyOverride(base, modelOverride);
}
