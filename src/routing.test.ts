import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { resetDiscoveryCachesForTests } from "./discovery.js";
import { setPluginConfigForTests, wrapZeroGProviderStream } from "./index.js";

function message(modelId: string) {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "agvi-0g-compute",
    model: modelId,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never;
}

function stream(modelId: string) {
  return {
    result: async () => message(modelId),
    async *[Symbol.asyncIterator]() {
      yield { type: "done", reason: "stop", message: message(modelId) };
    },
  } as never;
}

function model(id: string) {
  return { id, api: "openai-completions", provider: "agvi-0g-compute" } as never;
}

describe("0G routing / trust request shaping", () => {
  beforeEach(() => resetDiscoveryCachesForTests());

  it("injects provider routing headers and preserves caller headers", async () => {
    setPluginConfigForTests({
      defaults: {
        capabilityDiscovery: { enabled: false },
        observability: { enabled: false },
        routing: { enabled: true, address: "0xabc", identity: "upstream-a", sort: "latency", allowFallbacks: false },
        trust: { mode: "verified", allowDowngrade: false },
      },
    });
    let seen: any;
    const base = vi.fn((effectiveModel, _context, options) => {
      seen = { effectiveModel, options };
      return stream(effectiveModel.id);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    await wrapped(model("glm-5.3-flash"), {} as never, { headers: { "X-Custom": "yes" } });
    expect(seen.options.headers).toMatchObject({
      "X-Custom": "yes",
      "X-0G-Provider-Address": "0xabc",
      "X-0G-Provider-Identity": "upstream-a",
      "X-0G-Provider-Sort": "latency",
      "X-0G-Provider-Allow-Fallbacks": "false",
      "X-0G-Provider-Trust-Mode": "verified",
    });
  });

  it("switches the effective OpenClaw API per model override", async () => {
    setPluginConfigForTests({
      defaults: { capabilityDiscovery: { enabled: false }, observability: { enabled: false } },
      models: { "glm-5.3-flash": { transport: "responses" } },
    });
    let effectiveApi = "";
    const base = vi.fn((effectiveModel) => {
      effectiveApi = effectiveModel.api;
      return stream(effectiveModel.id);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    await wrapped(model("glm-5.3-flash"), {} as never, {});
    expect(effectiveApi).toBe("openai-responses");
  });

  it("injects verify_tee only when TEE verification is enabled", async () => {
    setPluginConfigForTests({
      defaults: { capabilityDiscovery: { enabled: false }, observability: { enabled: false } },
      models: {
        "glm-5.3": {
          trust: { mode: "private", allowDowngrade: false },
          teeVerification: { enabled: true, required: false },
          capabilityDiscovery: { enabled: false },
        },
      },
    });
    let shaped: any;
    const base = vi.fn((effectiveModel, _context, options) => {
      shaped = options?.onPayload?.({ model: effectiveModel.id }, effectiveModel);
      return stream(effectiveModel.id);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    await wrapped(model("glm-5.3"), {} as never, {});
    expect(await shaped).toMatchObject({ model: "glm-5.3", verify_tee: true });
  });

  it("rejects an unsealed response when private trust is requested", async () => {
    setPluginConfigForTests({
      defaults: { capabilityDiscovery: { enabled: false }, observability: { enabled: false } },
      models: {
        "glm-5.3": {
          trust: { mode: "private", allowDowngrade: false },
          capabilityDiscovery: { enabled: false },
        },
      },
    });
    const base = vi.fn(async (effectiveModel, _context, options) => {
      await options?.onResponse?.({ status: 200, headers: { "x-0g-e2ee": "none" } }, effectiveModel);
      return stream(effectiveModel.id);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    await expect(wrapped(model("glm-5.3"), {} as never, {})).rejects.toThrow(/did not return sealed E2EE/);
  });
});
