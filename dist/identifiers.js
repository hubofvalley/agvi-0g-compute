export const PROVIDER_ID = "agvi-0g-compute";
export const ROUTER_BASE_URL = "https://router-api.0g.ai/v1";
export const MODEL_IDS = {
    HAIKU: "claude-haiku-5.5",
    DEEPSEEK: "deepseek-v4.1-flash",
    QWEN: "qwen3.7-flash",
    GLM: "glm-5.3-flash",
    GLM_FULL: "glm-5.3",
};
export function normalizeModelId(modelId) {
    return (modelId ?? "unknown").trim().toLowerCase();
}
