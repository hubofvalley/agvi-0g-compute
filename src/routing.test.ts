import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const originalFetch = globalThis.fetch;

  beforeEach(() => resetDiscoveryCachesForTests());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

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

  it("fails closed on an explicit transport until a dynamic model is advertised", async () => {
    setPluginConfigForTests({
      defaults: { capabilityDiscovery: { enabled: true, ttlSeconds: 300, timeoutMs: 5_000 }, observability: { enabled: false } },
      models: { "qwen3.8-flash": { transport: "messages" } },
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "qwen3.8-flash", supported_formats: ["openai", "responses"] }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as typeof fetch;
    const base = vi.fn(() => stream("qwen3.8-flash"));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    await expect(wrapped(model("qwen3.8-flash"), {} as never, {})).rejects.toThrow(/not advertised/);
    expect(base).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("does not add verify_tee when TEE verification is disabled", async () => {
    let shaped: unknown;
    const base = vi.fn((effectiveModel, _context, options) => {
      shaped = options?.onPayload?.({ model: effectiveModel.id }, effectiveModel);
      return stream(effectiveModel.id);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;

    await wrapped(model("glm-5.3-flash"), {} as never, {});
    expect(await shaped).not.toHaveProperty("verify_tee");
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

  it("accepts a sealed response when private trust is requested", async () => {
    setPluginConfigForTests({
      defaults: { capabilityDiscovery: { enabled: false }, observability: { enabled: false } },
      models: { "glm-5.3": { trust: { mode: "private", allowDowngrade: false }, capabilityDiscovery: { enabled: false } } },
    });
    const base = vi.fn(async (effectiveModel, _context, options) => {
      await options?.onResponse?.({ status: 200, headers: { "x-0g-e2ee": "sealed" } }, effectiveModel);
      return stream(effectiveModel.id);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;

    await expect(wrapped(model("glm-5.3"), {} as never, {})).resolves.toBeDefined();
  });

  it("does not delay an ordinary inference while background model discovery is pending", async () => {
    setPluginConfigForTests({
      defaults: {
        capabilityDiscovery: { enabled: true, ttlSeconds: 300, timeoutMs: 5_000 },
        observability: { enabled: false },
      },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({
        data: [{ id: "glm-5.3-flash", supported_formats: ["openai", "responses", "anthropic"] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const base = vi.fn((effectiveModel) => stream(effectiveModel.id));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    let settled = false;
    const pending = wrapped(model("glm-5.3-flash"), {} as never, {}).then(() => { settled = true; });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    const unblockedBeforeDiscoveryFinished = settled;
    release();
    await pending;
    expect(unblockedBeforeDiscoveryFinished).toBe(true);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("keeps private trust on the fresh blocking discovery path", async () => {
    setPluginConfigForTests({
      defaults: {
        capabilityDiscovery: { enabled: true, ttlSeconds: 300, timeoutMs: 5_000 },
        observability: { enabled: false },
      },
      models: {
        "glm-5.3": {
          trust: { mode: "private", allowDowngrade: false },
        },
      },
    });
    let releaseModels!: () => void;
    const modelGate = new Promise<void>((resolve) => { releaseModels = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        await modelGate;
        return new Response(JSON.stringify({
          data: [{ id: "glm-5.3", supported_formats: ["openai", "responses", "anthropic"], tee_attested: true }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        data: [{ address: "0xprivate", is_healthy: true, trust_mode: "private", tee_attested: true }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const base = vi.fn((effectiveModel) => stream(effectiveModel.id));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    let settled = false;
    const pending = wrapped(model("glm-5.3"), {} as never, { apiKey: "strict-test-key" }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(base).not.toHaveBeenCalled();

    releaseModels();
    await pending;
    expect(base).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a response from a different provider when fallbacks are disabled", async () => {
    setPluginConfigForTests({
      defaults: {
        capabilityDiscovery: { enabled: false },
        observability: { enabled: false },
        routing: { enabled: true, address: "0xabc", allowFallbacks: false },
      },
    });
    const base = vi.fn(async (effectiveModel, _context, options) => {
      await options?.onResponse?.({ status: 200, headers: { "x-provider": "0xdef" } }, effectiveModel);
      return stream(effectiveModel.id);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;

    await expect(wrapped(model("glm-5.3-flash"), {} as never, {})).rejects.toThrow(/pinned provider fallback/);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("fails closed when strict model discovery fails", async () => {
    setPluginConfigForTests({
      defaults: { capabilityDiscovery: { enabled: true, ttlSeconds: 300, timeoutMs: 5_000 }, observability: { enabled: false } },
      models: { "glm-5.3": { trust: { mode: "private", allowDowngrade: false } } },
    });
    globalThis.fetch = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    const base = vi.fn((effectiveModel) => stream(effectiveModel.id));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;

    await expect(wrapped(model("glm-5.3"), {} as never, { apiKey: "strict-test-key" })).rejects.toThrow(/strict model discovery failed/);
    expect(base).not.toHaveBeenCalled();
  });

  it("downgrades private trust only when policy explicitly permits it", async () => {
    setPluginConfigForTests({
      defaults: { capabilityDiscovery: { enabled: true, ttlSeconds: 300, timeoutMs: 5_000 }, observability: { enabled: false } },
      models: { "glm-5.3": { trust: { mode: "private", allowDowngrade: true } } },
    });
    globalThis.fetch = vi.fn(async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    let seenHeaders: Record<string, string> | undefined;
    const base = vi.fn((effectiveModel, _context, options) => {
      seenHeaders = options?.headers as Record<string, string> | undefined;
      return stream(effectiveModel.id);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;

    await wrapped(model("glm-5.3"), {} as never, {});
    expect(base).toHaveBeenCalledTimes(1);
    expect(seenHeaders?.["X-0G-Provider-Trust-Mode"]).toBeUndefined();
  });

  it("rejects required TEE verification for a model without TEE capability", async () => {
    setPluginConfigForTests({
      defaults: { capabilityDiscovery: { enabled: false }, observability: { enabled: false } },
      models: {
        "qwen3.7-flash": {
          trust: { mode: "private", allowDowngrade: false },
          teeVerification: { enabled: true, required: true },
        },
      },
    });
    const base = vi.fn((effectiveModel) => stream(effectiveModel.id));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;

    await expect(wrapped(model("qwen3.7-flash"), {} as never, {})).rejects.toThrow(/TEE verification required/);
    expect(base).not.toHaveBeenCalled();
  });

  it("does not downgrade a pinned private route even when downgrade is allowed", async () => {
    setPluginConfigForTests({
      defaults: {
        capabilityDiscovery: { enabled: true, ttlSeconds: 300, timeoutMs: 5_000 },
        observability: { enabled: false },
        routing: { enabled: true, address: "0xabc", allowFallbacks: false },
      },
      models: { "glm-5.3": { trust: { mode: "private", allowDowngrade: true } } },
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "glm-5.3", supported_formats: ["openai", "responses", "anthropic"] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const base = vi.fn((effectiveModel) => stream(effectiveModel.id));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;

    await expect(wrapped(model("glm-5.3"), {} as never, { apiKey: "pinned-test-key" })).rejects.toThrow(/private trust mode unavailable/);
    expect(base).not.toHaveBeenCalled();
  });
});
