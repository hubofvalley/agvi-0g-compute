export const TRANSPORT_TO_API = {
    "chat-completions": "openai-completions",
    messages: "anthropic-messages",
    responses: "openai-responses",
};
export const TRANSPORT_TO_FORMAT = {
    "chat-completions": "openai",
    messages: "anthropic",
    responses: "responses",
};
const API_TO_TRANSPORT = {
    "openai-completions": "chat-completions",
    "anthropic-messages": "messages",
    "openai-responses": "responses",
};
const AUTO_PREFERENCE = {
    "claude-haiku-5.5": ["messages", "chat-completions", "responses"],
    "deepseek-v4.1-flash": ["chat-completions", "responses", "messages"],
    "qwen3.7-flash": ["chat-completions", "responses", "messages"],
    "glm-5.3-flash": ["chat-completions", "messages", "responses"],
    "glm-5.3": ["chat-completions", "messages", "responses"],
};
export const STATIC_SUPPORTED_FORMATS = {
    "claude-haiku-5.5": ["openai", "anthropic"],
    "deepseek-v4.1-flash": ["openai", "responses"],
    "qwen3.7-flash": ["openai", "responses"],
    "glm-5.3-flash": ["openai", "anthropic", "responses"],
    "glm-5.3": ["openai", "responses", "anthropic"],
};
function supports(transport, formats) {
    return !formats || formats.includes(TRANSPORT_TO_FORMAT[transport]);
}
export function resolveTransport(modelId, requested, remoteFormats, currentApi) {
    const formats = remoteFormats?.length ? remoteFormats : STATIC_SUPPORTED_FORMATS[modelId];
    if (requested !== "auto") {
        if (!supports(requested, formats)) {
            throw new Error(`0G transport ${requested} is not advertised for ${modelId}; available formats: ${(formats ?? []).join(",") || "unknown"}`);
        }
        return { transport: requested, api: TRANSPORT_TO_API[requested], source: "explicit" };
    }
    const preferred = AUTO_PREFERENCE[modelId] ?? [];
    for (const transport of preferred) {
        if (supports(transport, formats))
            return { transport, api: TRANSPORT_TO_API[transport], source: "auto" };
    }
    const fromModelApi = currentApi ? API_TO_TRANSPORT[currentApi] : undefined;
    if (fromModelApi && supports(fromModelApi, formats)) {
        return { transport: fromModelApi, api: TRANSPORT_TO_API[fromModelApi], source: "model-api" };
    }
    for (const transport of ["chat-completions", "messages", "responses"]) {
        if (supports(transport, formats))
            return { transport, api: TRANSPORT_TO_API[transport], source: "auto" };
    }
    throw new Error(`0G model ${modelId} has no supported text transport available`);
}
