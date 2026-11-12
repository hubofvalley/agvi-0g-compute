import { describe, expect, it } from "vitest";
import { buildModelCatalog, buildModelFromRemote, getModelMetadata, MODEL_CATALOG } from "./catalog.js";
import type { RemoteModelCapability } from "./discovery.js";

const row = (overrides: Partial<RemoteModelCapability>): RemoteModelCapability => ({
  id: "example-chat",
  type: "chatbot",
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_formats: ["openai"],
  ...overrides,
});

describe("live 0G model catalog", () => {
  it("converts a generic text model using router metadata", () => {
    const model = buildModelFromRemote(row({
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      supported_formats: ["openai", "responses"],
      supported_parameters: ["tools", "reasoning_effort"],
      context_length: 1_000_000,
      max_completion_tokens: 65_536,
      pricing_usd: { prompt: "0.000001", completion: "0.000004" },
    }));

    expect(model).toMatchObject({
      id: "gemini-3.7-flash",
      api: "openai-completions",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
    });
    expect(getModelMetadata("gemini-3.7-flash")?.unknownRateClasses).toEqual(["cacheRead", "cacheWrite"]);
    expect(getModelMetadata("gemini-3.7-flash")?.rateNotes).toEqual([
      "cacheRead rate not published by the 0G Router (unknown, not free)",
      "cacheWrite rate not published by the 0G Router (unknown, not free)",
    ]);
  });

  it("uses Anthropic Messages for Claude rows that advertise it", () => {
    const model = buildModelFromRemote(row({
      id: "claude-sonnet-5.5",
      name: "Claude Sonnet 5.5",
      supported_formats: ["openai", "anthropic"],
    }));
    expect(model?.api).toBe("anthropic-messages");
  });

  it("keeps curated metadata for existing models", () => {
    const model = buildModelFromRemote(row({ id: "glm-5.3", max_completion_tokens: 1 }));
    expect(model).toEqual(MODEL_CATALOG.find((entry) => entry.id === "glm-5.3"));
  });

  it("rejects unknown or incomplete model capability rows", () => {
    expect(buildModelFromRemote(row({ type: "experimental-chat" }))).toBeUndefined();
    expect(buildModelFromRemote({ id: "missing-capabilities", type: "chatbot" })).toBeUndefined();
  });

  it("does not expose non-text output models through the text provider", () => {
    for (const type of ["text-to-image", "video-generation", "text-to-speech", "embedding", "decisions"]) {
      expect(buildModelFromRemote(row({
        id: type + "-model",
        type,
        architecture: { input_modalities: ["text"], output_modalities: [type === "embedding" ? "embedding" : "image"] },
      }))).toBeUndefined();
    }
  });

  it("does not retain a curated model omitted by a successful live inventory", () => {
    const catalog = buildModelCatalog([row({ id: "gpt-5.6-sol" })], { includeMissingCurated: false });
    expect(catalog.map((model) => model.id)).toEqual(["gpt-5.6-sol"]);
    expect(catalog.some((model) => model.id === "glm-5.3")).toBe(false);
  });

  it("merges live chat rows while retaining all curated fallback rows", () => {
    const catalog = buildModelCatalog([
      row({ id: "gpt-5.6-sol" }),
      row({ id: "qwen3.8-flash" }),
      row({ id: "image-model", type: "text-to-image", architecture: { output_modalities: ["image"] } }),
    ]);
    expect(catalog).toHaveLength(MODEL_CATALOG.length + 2);
    expect(catalog.map((model) => model.id)).toEqual(expect.arrayContaining([
      ...MODEL_CATALOG.map((model) => model.id),
      "gpt-5.6-sol",
      "qwen3.8-flash",
    ]));
  });
});
