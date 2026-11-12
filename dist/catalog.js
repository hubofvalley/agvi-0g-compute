import { MODEL_IDS, normalizeModelId } from "./identifiers.js";
const { HAIKU, DEEPSEEK, QWEN, GLM, GLM_FULL } = MODEL_IDS;
export const MODEL_METADATA = {
    [HAIKU]: {
        preferredTransports: ["messages", "chat-completions", "responses"],
        supportedFormats: ["openai", "anthropic"],
        rateNotes: [
            "cacheRead rate not in public router listing (unverified)",
            "tieredPricing above 100k input not in public router listing (unverified)",
        ],
    },
    [DEEPSEEK]: {
        preferredTransports: ["chat-completions", "responses", "messages"],
        supportedFormats: ["openai", "responses"],
        unknownRateClasses: ["cacheWrite"],
        rateNotes: [
            "cacheWrite has no published rate (unknown, not free); cacheRead verified at $0.0416/M",
        ],
    },
    [QWEN]: {
        preferredTransports: ["chat-completions", "responses", "messages"],
        supportedFormats: ["openai", "responses"],
        unknownRateClasses: ["cacheRead", "cacheWrite"],
        rateNotes: ["cacheRead and cacheWrite rates are not published (unknown, not free)"],
    },
    [GLM]: {
        preferredTransports: ["chat-completions", "messages", "responses"],
        supportedFormats: ["openai", "anthropic", "responses"],
        unknownRateClasses: ["cacheRead", "cacheWrite"],
        rateNotes: ["cacheRead and cacheWrite rates are not published (unknown, not free)"],
        thinkingProfile: {
            levels: [{ id: "high", label: "always on" }],
            defaultLevel: "high",
        },
    },
    [GLM_FULL]: {
        preferredTransports: ["chat-completions", "messages", "responses"],
        supportedFormats: ["openai", "responses", "anthropic"],
        teeCapable: true,
        unknownRateClasses: ["cacheRead", "cacheWrite"],
        rateNotes: ["cacheRead and cacheWrite rates are not published (unknown, not free)"],
        thinkingProfile: {
            levels: [{ id: "off" }, { id: "high" }],
            defaultLevel: "high",
        },
    },
};
export const MODEL_CATALOG = [
    {
        id: HAIKU,
        name: "Claude Haiku 5.5 (0G Compute, native Messages)",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        cost: {
            input: 0.0999,
            output: 0.5,
            cacheRead: 0.01,
            cacheWrite: 0.125,
            tieredPricing: [
                { range: [0, 100_001], input: 0.0999, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
                { range: [100_001], input: 0.5, output: 2.5, cacheRead: 0.0499, cacheWrite: 0.625 },
            ],
        },
        contextWindow: 1_000_000,
        maxTokens: 128_000,
    },
    {
        id: DEEPSEEK,
        name: "DeepSeek V4.1 Flash (0G Compute)",
        api: "openai-completions",
        reasoning: true,
        // This exact 0G listing exposes text input. Do not advertise the separate
        // DeepSeek vision variant as an ability of this provider route.
        input: ["text"],
        compat: { supportsDeveloperRole: false },
        // Verified: pc.0g.ai/models/deepseek-v4.1-flash "Cache Read / 1M $0.0416".
        // Route caches prefixes automatically. cacheWrite has no published rate: kept 0 and treated as unknown.
        cost: { input: 0.4166, output: 1.6666, cacheRead: 0.0416, cacheWrite: 0 },
        contextWindow: 1_000_000,
        // The router publishes 393,216 tokens, i.e. 384 Ki tokens.
        maxTokens: 393_216,
    },
    {
        id: QWEN,
        name: "Qwen 3.7 Flash (0G Compute)",
        // 0G advertises both Chat Completions and Responses. Live diagnostics on
        // 2026-11-10 reproduced the same first-event stall on both, so keep the
        // existing Chat Completions route rather than changing protocol without a
        // demonstrated reliability benefit.
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        // Live /v1/models currently publishes these input/output rates. Cache
        // pricing is not published, so zero here means "not billable by our cost
        // estimator", not a claim that 0G cache reads/writes are free.
        cost: { input: 0.029167, output: 0.116667, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        // The public listing currently omits max_completion_tokens for Qwen.
        // Preserve AGVI's already-deployed conservative cap until 0G publishes one.
        maxTokens: 262_144,
    },
    {
        id: GLM,
        name: "GLM 5.3 Flash (0G Compute)",
        api: "openai-completions",
        reasoning: true,
        input: ["text", "image"],
        thinkingLevelMap: { off: null, high: "high" },
        compat: {
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ["high"],
            reasoningEffortMap: { high: "high" },
        },
        cost: { input: 0.09015, output: 0.3153, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_179_648,
        maxTokens: 131_072,
    },
    {
        id: GLM_FULL,
        name: "GLM 5.3 (0G Compute, TEE-capable)",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        thinkingLevelMap: { high: "high" },
        compat: {
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ["high"],
            reasoningEffortMap: { high: "high" },
        },
        cost: { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_179_648,
        maxTokens: 131_072,
    },
];
const STATIC_CATALOG_BY_ID = new Map(MODEL_CATALOG.map((model) => [normalizeModelId(model.id), model]));
const DYNAMIC_DEFAULT_MAX_TOKENS = 32_768;
const NON_TEXT_PROVIDER_TYPES = new Set([
    "text-to-image",
    "video-generation",
    "text-to-speech",
    "speech-to-text",
    "embedding",
    "decisions",
]);
function positiveNumber(value) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}
function pricingPerMillion(row, key) {
    const value = positiveNumber(row.pricing_usd?.[key]);
    return value === undefined ? 0 : value * 1_000_000;
}
function isTextChatModel(row) {
    if (!row.id || (row.type !== undefined && NON_TEXT_PROVIDER_TYPES.has(row.type)))
        return false;
    const inputs = row.architecture?.input_modalities ?? ["text"];
    const outputs = row.architecture?.output_modalities ?? ["text"];
    const formats = row.supported_formats ?? ["openai"];
    return inputs.includes("text") && outputs.includes("text") &&
        formats.some((format) => ["openai", "responses", "anthropic"].includes(format));
}
function selectDynamicApi(row) {
    const formats = row.supported_formats ?? ["openai"];
    const label = `${row.id} ${row.name ?? ""} ${row.description ?? ""}`.toLowerCase();
    if (formats.includes("anthropic") && /claude|anthropic/.test(label))
        return "anthropic-messages";
    if (formats.includes("openai"))
        return "openai-completions";
    if (formats.includes("responses"))
        return "openai-responses";
    return formats.includes("anthropic") ? "anthropic-messages" : "openai-completions";
}
export function buildModelFromRemote(row) {
    if (!isTextChatModel(row))
        return undefined;
    const staticModel = STATIC_CATALOG_BY_ID.get(normalizeModelId(row.id));
    if (staticModel)
        return staticModel;
    const input = (row.architecture?.input_modalities ?? ["text"])
        .filter((modality) => modality === "text" || modality === "image");
    if (!input.includes("text"))
        return undefined;
    const supportedParameters = new Set(row.supported_parameters ?? []);
    const supportsReasoningEffort = supportedParameters.has("reasoning_effort");
    const supportsThinking = supportedParameters.has("thinking");
    const contextWindow = positiveNumber(row.context_length);
    const maxTokens = positiveNumber(row.max_completion_tokens) ??
        Math.min(contextWindow ?? DYNAMIC_DEFAULT_MAX_TOKENS, DYNAMIC_DEFAULT_MAX_TOKENS);
    const compat = supportsReasoningEffort
        ? {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
            supportedReasoningEfforts: ["high"],
            reasoningEffortMap: { high: "high" },
        }
        : { supportsDeveloperRole: false };
    return {
        id: row.id,
        name: `${row.name ?? row.id} (0G Compute)`,
        api: selectDynamicApi(row),
        reasoning: supportsReasoningEffort || supportsThinking,
        ...(supportsThinking ? { thinkingLevelMap: { high: "high" } } : {}),
        input,
        compat,
        cost: {
            input: pricingPerMillion(row, "prompt"),
            output: pricingPerMillion(row, "completion"),
            cacheRead: pricingPerMillion(row, "cache_read"),
            cacheWrite: pricingPerMillion(row, "cache_write"),
        },
        ...(contextWindow ? { contextWindow } : {}),
        maxTokens,
    };
}
/**
 * Merge the live router inventory with curated overrides. Unsupported 0G
 * modalities are intentionally omitted from the text-provider catalog; their
 * IDs remain available to capability-specific adapters when those are added.
 */
export function buildModelCatalog(rows) {
    const models = [...MODEL_CATALOG];
    const seen = new Set(models.map((model) => normalizeModelId(model.id)));
    for (const row of rows) {
        const model = buildModelFromRemote(row);
        if (!model || seen.has(normalizeModelId(model.id)))
            continue;
        seen.add(normalizeModelId(model.id));
        models.push(model);
    }
    return models;
}
export function getModelMetadata(modelId) {
    return MODEL_METADATA[normalizeModelId(modelId)];
}
