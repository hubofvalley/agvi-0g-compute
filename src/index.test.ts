import { describe, it, expect } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import entry, { DEFAULT_REQUEST_TIMEOUT_SECONDS, MODEL_CATALOG } from "./index.js";

describe("agvi-0g-compute", () => {
  it("publishes all five AGVI 0G models and accurately marks reasoning", () => {
    expect(MODEL_CATALOG.map((m) => [m.id, m.api, m.reasoning])).toEqual([
      ["claude-haiku-5.5", "anthropic-messages", true],
      ["deepseek-v4.1-flash", "openai-completions", true],
      ["qwen3.7-flash", "openai-completions", true],
      ["glm-5.3-flash", "openai-completions", true],
      ["glm-5.3", "openai-completions", true],
    ]);
    expect(MODEL_CATALOG[0].input).toContain("image");
    expect(MODEL_CATALOG[0].contextWindow).toBe(1_000_000);
    expect(MODEL_CATALOG[0].maxTokens).toBe(128_000);
    expect(MODEL_CATALOG[0].cost.tieredPricing).toEqual([
      { range: [0, 100_001], input: 0.0999, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      { range: [100_001], input: 0.5, output: 2.5, cacheRead: 0.0499, cacheWrite: 0.625 },
    ]);
    expect(MODEL_CATALOG[1].input).toEqual(["text"]);
    expect(MODEL_CATALOG[1].maxTokens).toBe(393_216);
    expect(MODEL_CATALOG[2].input).toEqual(["text"]);
    expect(MODEL_CATALOG[2].contextWindow).toBe(1_000_000);
    expect(MODEL_CATALOG[2].maxTokens).toBe(262_144);
    expect(MODEL_CATALOG[3].contextWindow).toBe(1_179_648);
    expect(MODEL_CATALOG[3].maxTokens).toBe(131_072);
    expect(MODEL_CATALOG[3].thinkingLevelMap).toEqual({ off: null, high: "high" });
    expect(MODEL_CATALOG[3].compat?.supportedReasoningEfforts).toEqual(["high"]);
    expect(MODEL_CATALOG[4].contextWindow).toBe(1_179_648);
    expect(MODEL_CATALOG[4].maxTokens).toBe(131_072);
  });

  it("registers a keyed provider without publishing unauthenticated credentials", async () => {
    const providers: ProviderPlugin[] = [];
    const api = { registerProvider: (p: ProviderPlugin) => providers.push(p) } as Partial<OpenClawPluginApi>;
    entry.register(api as OpenClawPluginApi);
    expect(providers).toHaveLength(1);
    const provider = providers[0];
    expect(provider.id).toBe("agvi-0g-compute");
    expect(provider.auth).toMatchObject([{ id: "api-key", kind: "api_key" }]);
    expect(provider.catalog).toBeDefined();
    const context = (apiKey?: string) => ({
      config: { models: { providers: {} } },
      env: {},
      resolveProviderApiKey: () => ({ apiKey }),
      resolveProviderAuth: () => ({ apiKey, mode: "api_key", source: "env" }),
    });
    expect(await provider.catalog!.run(context(undefined))).toBeNull();
    const result = await provider.catalog!.run(context("test-key"));
    expect(result?.provider?.baseUrl).toBe("https://router-api.0g.ai/v1");
    expect(result?.provider?.timeoutSeconds).toBe(DEFAULT_REQUEST_TIMEOUT_SECONDS);
    expect(result?.provider?.models?.map((m) => m.id)).toEqual([
      "claude-haiku-5.5", "deepseek-v4.1-flash", "qwen3.7-flash", "glm-5.3-flash", "glm-5.3",
    ]);
  });

  it("owns the GLM thinking profile so OpenClaw accepts high for the always-thinking Flash route", () => {
    const providers: ProviderPlugin[] = [];
    entry.register({ registerProvider: (p: ProviderPlugin) => providers.push(p), pluginConfig: {} } as unknown as OpenClawPluginApi);
    const resolve = providers[0].resolveThinkingProfile!;
    expect(resolve({ provider: "agvi-0g-compute", modelId: "glm-5.3-flash" })).toEqual({
      levels: [{ id: "high", label: "always on" }],
      defaultLevel: "high",
    });
    expect(resolve({ provider: "agvi-0g-compute", modelId: "glm-5.3" })).toEqual({
      levels: [{ id: "off" }, { id: "high" }],
      defaultLevel: "high",
    });
  });
});
