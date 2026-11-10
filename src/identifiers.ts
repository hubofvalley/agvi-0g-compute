export const PROVIDER_ID = "agvi-0g-compute" as const;
export const ROUTER_BASE_URL = "https://router-api.0g.ai/v1" as const;

export const MODEL_IDS = {
  HAIKU: "claude-haiku-5.5",
  DEEPSEEK: "deepseek-v4.1-flash",
  QWEN: "qwen3.7-flash",
  GLM: "glm-5.3-flash",
  GLM_FULL: "glm-5.3",
} as const;

export type ModelId = (typeof MODEL_IDS)[keyof typeof MODEL_IDS];

export function normalizeModelId(modelId: string | undefined): string {
  return (modelId ?? "unknown").trim().toLowerCase();
}
