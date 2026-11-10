import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverModel, discoverProviders, resetDiscoveryCachesForTests } from "./discovery.js";

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
});
