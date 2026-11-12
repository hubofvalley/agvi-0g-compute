import { describe, it, expect, vi } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import entry, { DEFAULT_REQUEST_TIMEOUT_SECONDS } from "./index.js";
import { resetDiscoveryCachesForTests } from "./discovery.js";
import { MODEL_CATALOG } from "./catalog.js";

describe("agvi-0g-compute", () => {
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
    });
    expect(await provider.catalog!.run(context(undefined))).toBeNull();
    resetDiscoveryCachesForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "gpt-5.6-sol", type: "chatbot", supported_formats: ["openai"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      const result = await provider.catalog!.run(context("test-key"));
      expect(result?.provider?.baseUrl).toBe("https://router-api.0g.ai/v1");
      expect(result?.provider?.timeoutSeconds).toBe(DEFAULT_REQUEST_TIMEOUT_SECONDS);
      expect(result?.provider?.models?.map((m) => [m.id, m.api, m.reasoning])).toEqual([
        ["gpt-5.6-sol", "openai-completions", false],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      resetDiscoveryCachesForTests();
    }
  });

  it("falls back to curated rows when live catalog refresh fails", async () => {
    const providers: ProviderPlugin[] = [];
    entry.register({ registerProvider: (p: ProviderPlugin) => providers.push(p), pluginConfig: {} } as unknown as OpenClawPluginApi);
    resetDiscoveryCachesForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new Error("router unavailable"); }) as typeof fetch;
    try {
      const provider = providers[0];
      const result = await provider.catalog!.run({
        config: { models: { providers: {} } },
        env: {},
        resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      } as never);
      expect(result?.provider?.models?.map((model) => model.id)).toEqual(MODEL_CATALOG.map((model) => model.id));
    } finally {
      globalThis.fetch = originalFetch;
      resetDiscoveryCachesForTests();
    }
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
