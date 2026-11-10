import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ProviderPlugin, ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import entry, {
  CIRCUIT_BREAKER_COOLDOWN_MS,
  CIRCUIT_BREAKER_FAILURES,
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  getRouteHealth,
  resetRouteHealthForTests,
  setPluginConfigForTests,
  wrapZeroGProviderStream,
} from "./index.js";

function provider(): ProviderPlugin {
  const providers: ProviderPlugin[] = [];
  entry.register({ registerProvider: (value: ProviderPlugin) => providers.push(value), pluginConfig: {} } as never);
  return providers[0];
}

function finalMessage(modelId = "qwen3.7-flash") {
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

function streamWith(events: any[], modelId = "qwen3.7-flash") {
  const message = finalMessage(modelId);
  return {
    result: async () => message,
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  } as never;
}

function testModel(id = "qwen3.7-flash") {
  return { id, api: "openai-completions", provider: "agvi-0g-compute" } as never;
}

describe("0G transport hardening", () => {
  beforeEach(() => {
    resetRouteHealthForTests();
    setPluginConfigForTests({
      defaults: {
        capabilityDiscovery: { enabled: false },
        observability: { enabled: false },
      },
    });
  });

  it("sets provider-local transport defaults without overriding tighter caller values", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const base = vi.fn((_model, _context, options) => {
      seen.push(options as Record<string, unknown> | undefined);
      return streamWith([]);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    const model = testModel();
    const context = {} as never;

    await wrapped(model, context, {});
    await wrapped(model, context, { timeoutMs: 90_000, maxRetryDelayMs: 5_000 });

    expect(seen[0]).toMatchObject({
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      maxRetryDelayMs: DEFAULT_MAX_RETRY_DELAY_MS,
    });
    expect(seen[1]).toMatchObject({ timeoutMs: 90_000, maxRetryDelayMs: 5_000 });
    expect((wrapped as { preservesGenericCompatibility?: boolean }).preservesGenericCompatibility).toBe(true);
  });

  it("opens the per-model breaker after repeated idle-timeout aborts", async () => {
    const base = vi.fn(() => streamWith([]));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    const model = testModel();
    const context = {} as never;

    for (let i = 0; i < CIRCUIT_BREAKER_FAILURES; i += 1) {
      const controller = new AbortController();
      await wrapped(model, context, { signal: controller.signal });
      controller.abort(new Error("LLM idle timeout (120s): no response from model"));
    }

    const health = getRouteHealth("qwen3.7-flash");
    expect(health.consecutiveStalls).toBe(CIRCUIT_BREAKER_FAILURES);
    expect(health.openUntil).toBeGreaterThan(Date.now());
    expect(health.openUntil).toBeLessThanOrEqual(Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS);
    await expect(wrapped(model, context, {})).rejects.toThrow(/temporarily quarantined/);
  });

  it("does not reset a prior stall merely because HTTP response headers arrived", async () => {
    const base = vi.fn((_model, _context, options) => {
      void options?.onResponse?.({ status: 200, headers: {} }, _model);
      return streamWith([]);
    });
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    const model = testModel();
    const controller = new AbortController();
    await wrapped(model, {} as never, { signal: controller.signal });
    controller.abort(new Error("LLM idle timeout (120s): no response from model"));
    expect(getRouteHealth("qwen3.7-flash").consecutiveStalls).toBe(1);

    await wrapped(model, {} as never, {});
    await Promise.resolve();
    expect(getRouteHealth("qwen3.7-flash").consecutiveStalls).toBe(1);
  });

  it("resets prior stall state only after a real provider progress event", async () => {
    const base = vi.fn(() => streamWith([
      { type: "start", partial: finalMessage() },
      { type: "thinking_delta", contentIndex: 0, delta: "x", partial: finalMessage() },
    ]));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    const model = testModel();
    const controller = new AbortController();
    await wrapped(model, {} as never, { signal: controller.signal });
    controller.abort(new Error("LLM idle timeout (120s): no response from model"));
    expect(getRouteHealth("qwen3.7-flash").consecutiveStalls).toBe(1);

    const observed = await wrapped(model, {} as never, {});
    for await (const _event of observed) {}
    expect(getRouteHealth("qwen3.7-flash").consecutiveStalls).toBe(0);
  });

  it("removes abort listeners after the observed stream is fully consumed", async () => {
    const base = vi.fn(() => streamWith([{ type: "done", reason: "stop", message: finalMessage() }]));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    const controller = new AbortController();
    const observed = await wrapped(testModel(), {} as never, { signal: controller.signal });
    for await (const _event of observed) {}
    controller.abort(new Error("LLM idle timeout (120s): no response from model"));
    expect(getRouteHealth("qwen3.7-flash").consecutiveStalls).toBe(0);
  });

  it("records a timeout thrown while consuming the provider stream", async () => {
    const base = vi.fn(() => ({
      result: async () => finalMessage(),
      async *[Symbol.asyncIterator]() {
        throw new Error("timed out");
      },
    }) as never);
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    const observed = await wrapped(testModel(), {} as never, {});

    await expect((async () => {
      for await (const _event of observed) {}
    })()).rejects.toThrow("timed out");
    expect(getRouteHealth("qwen3.7-flash").consecutiveStalls).toBe(1);
  });

  it("recovers a quarantined route after the cooldown and real progress", async () => {
    vi.useFakeTimers();
    try {
      const base = vi.fn(() => streamWith([{ type: "thinking_delta", contentIndex: 0, delta: "x", partial: finalMessage() }]));
      const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
      const model = testModel();

      for (let i = 0; i < CIRCUIT_BREAKER_FAILURES; i += 1) {
        const controller = new AbortController();
        await wrapped(model, {} as never, { signal: controller.signal });
        controller.abort(new Error("LLM idle timeout (120s): no response from model"));
      }
      expect(getRouteHealth("qwen3.7-flash").open).toBe(true);

      vi.advanceTimersByTime(CIRCUIT_BREAKER_COOLDOWN_MS + 1);
      const recovered = await wrapped(model, {} as never, {});
      for await (const _event of recovered) {}
      expect(base).toHaveBeenCalledTimes(CIRCUIT_BREAKER_FAILURES + 1);
      expect(getRouteHealth("qwen3.7-flash").consecutiveStalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies malformed tool payloads and an actual open breaker as non-transient format failures", async () => {
    const base = vi.fn(() => streamWith([]));
    const wrapped = wrapZeroGProviderStream({ streamFn: base } as unknown as ProviderWrapStreamFnContext)!;
    for (let i = 0; i < CIRCUIT_BREAKER_FAILURES; i += 1) {
      const controller = new AbortController();
      await wrapped(testModel(), {} as never, { signal: controller.signal });
      controller.abort(new Error("LLM idle timeout (120s): no response from model"));
    }

    let circuitMessage = "";
    try {
      await wrapped(testModel(), {} as never, {});
    } catch (error) {
      circuitMessage = error instanceof Error ? error.message : String(error);
    }
    const classify = provider().classifyFailoverReason!;
    expect(classify({ errorMessage: "Provider returned an incomplete or malformed tool call" })).toBe("format");
    expect(classify({ errorMessage: circuitMessage })).toBe("format");
    expect(classify({ errorMessage: "socket reset" })).toBeUndefined();
  });
});
