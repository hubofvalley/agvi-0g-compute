import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverModel, discoverModelSWR, discoverProviders, resetDiscoveryCachesForTests } from "./discovery.js";

const discovery = { enabled: true, ttlSeconds: 300, timeoutMs: 5_000 };

describe("0G capability discovery", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => resetDiscoveryCachesForTests());
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("discovers and caches model transport/TEE metadata", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        id: "glm-5.3",
        supported_formats: ["openai", "responses", "anthropic"],
        verifiability: "TeeML",
        tee_attested: true,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as typeof fetch;

    const first = await discoverModel("glm-5.3", discovery);
    const second = await discoverModel("glm-5.3", discovery);
    expect(first).toMatchObject({ tee_attested: true, verifiability: "TeeML" });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discovers private provider health and caches per model", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{
        address: "0xprivate",
        provider_identity: "0g",
        is_healthy: true,
        trust_mode: "private",
        tee_attested: true,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as typeof fetch;

    const rows = await discoverProviders("glm-5.3", "secret-not-logged", discovery);
    const cached = await discoverProviders("glm-5.3", "secret-not-logged", discovery);
    expect(rows[0]).toMatchObject({ trust_mode: "private", tee_attested: true, is_healthy: true });
    expect(cached).toEqual(rows);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-not-logged");
  });

  it("isolates provider discovery cache across API credentials", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      const suffix = headers?.Authorization === "Bearer key-a" ? "a" : "b";
      return new Response(JSON.stringify({
        data: [{ address: `0x${suffix}`, is_healthy: true, trust_mode: "private" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const a1 = await discoverProviders("glm-5.3", "key-a", discovery);
    const a2 = await discoverProviders("glm-5.3", "key-a", discovery);
    const b = await discoverProviders("glm-5.3", "key-b", discovery);
    expect(a1[0]?.address).toBe("0xa");
    expect(a2).toEqual(a1);
    expect(b[0]?.address).toBe("0xb");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns no model on a cold cache while refreshing in the background", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({
        data: [{ id: "glm-5.3-flash", supported_formats: ["openai", "responses", "anthropic"] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const cold = discoverModelSWR("glm-5.3-flash", discovery);
    expect(cold).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release();
    await vi.waitFor(async () => {
      expect(await discoverModel("glm-5.3-flash", discovery)).toMatchObject({
        supported_formats: ["openai", "responses", "anthropic"],
      });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves expired model capabilities stale and deduplicates background refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({
          data: [{ id: "glm-5.3-flash", supported_formats: ["openai"] }],
        }), { status: 200, headers: { "content-type": "application/json" } }));
      globalThis.fetch = fetchMock as typeof fetch;
      await discoverModel("glm-5.3-flash", { ...discovery, ttlSeconds: 1 });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      fetchMock.mockImplementationOnce(async () => {
        await gate;
        return new Response(JSON.stringify({
          data: [{ id: "glm-5.3-flash", supported_formats: ["openai", "responses"] }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      });

      vi.advanceTimersByTime(1_100);
      const staleA = discoverModelSWR("glm-5.3-flash", { ...discovery, ttlSeconds: 1 });
      const staleB = discoverModelSWR("glm-5.3-flash", { ...discovery, ttlSeconds: 1 });
      expect(staleA?.supported_formats).toEqual(["openai"]);
      expect(staleB).toEqual(staleA);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      release();
      await vi.runAllTimersAsync();
      const refreshed = await discoverModel("glm-5.3-flash", { ...discovery, ttlSeconds: 1 });
      expect(refreshed?.supported_formats).toEqual(["openai", "responses"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
