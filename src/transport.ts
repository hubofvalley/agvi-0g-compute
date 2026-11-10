import type { ZeroGTransport } from "./config.js";

export type ConcreteZeroGTransport = Exclude<ZeroGTransport, "auto">;

export const TRANSPORT_TO_API = {
  "chat-completions": "openai-completions",
  messages: "anthropic-messages",
  responses: "openai-responses",
} as const;

export const TRANSPORT_TO_FORMAT = {
  "chat-completions": "openai",
  messages: "anthropic",
  responses: "responses",
} as const;

const API_TO_TRANSPORT: Record<string, ConcreteZeroGTransport> = {
  "openai-completions": "chat-completions",
  "anthropic-messages": "messages",
  "openai-responses": "responses",
};

const AUTO_PREFERENCE: Record<string, ConcreteZeroGTransport[]> = {
  "claude-haiku-5.5": ["messages", "chat-completions", "responses"],
  "deepseek-v4.1-flash": ["chat-completions", "responses", "messages"],
  "qwen3.7-flash": ["chat-completions", "responses", "messages"],
  "glm-5.3-flash": ["chat-completions", "messages", "responses"],
  "glm-5.3": ["chat-completions", "messages", "responses"],
};

export const STATIC_SUPPORTED_FORMATS: Record<string, string[]> = {
  "claude-haiku-5.5": ["openai", "anthropic"],
  "deepseek-v4.1-flash": ["openai", "responses"],
  "qwen3.7-flash": ["openai", "responses"],
  "glm-5.3-flash": ["openai", "anthropic", "responses"],
  "glm-5.3": ["openai", "responses", "anthropic"],
};

export type ResolvedTransport = {
  transport: ConcreteZeroGTransport;
  api: typeof TRANSPORT_TO_API[ConcreteZeroGTransport];
  source: "explicit" | "auto" | "model-api";
};

function supports(transport: ConcreteZeroGTransport, formats: readonly string[] | undefined): boolean {
  return !formats || formats.includes(TRANSPORT_TO_FORMAT[transport]);
}

export function resolveTransport(
  modelId: string,
  requested: ZeroGTransport,
  remoteFormats?: readonly string[],
  currentApi?: string,
): ResolvedTransport {
  const formats = remoteFormats?.length ? remoteFormats : STATIC_SUPPORTED_FORMATS[modelId];
  if (requested !== "auto") {
    if (!supports(requested, formats)) {
      throw new Error(
        `0G transport ${requested} is not advertised for ${modelId}; available formats: ${(formats ?? []).join(",") || "unknown"}`,
      );
    }
    return { transport: requested, api: TRANSPORT_TO_API[requested], source: "explicit" };
  }

  const preferred = AUTO_PREFERENCE[modelId] ?? [];
  for (const transport of preferred) {
    if (supports(transport, formats)) return { transport, api: TRANSPORT_TO_API[transport], source: "auto" };
  }

  const fromModelApi = currentApi ? API_TO_TRANSPORT[currentApi] : undefined;
  if (fromModelApi && supports(fromModelApi, formats)) {
    return { transport: fromModelApi, api: TRANSPORT_TO_API[fromModelApi], source: "model-api" };
  }

  for (const transport of ["chat-completions", "messages", "responses"] as const) {
    if (supports(transport, formats)) return { transport, api: TRANSPORT_TO_API[transport], source: "auto" };
  }
  throw new Error(`0G model ${modelId} has no supported text transport available`);
}
