import { describe, it, expect, vi } from "vitest";
import { MODEL_CATALOG } from "../catalog.js";
import { buildUsageReport, formatUsageReport } from "./usage-report.js";
import { compareCatalog, type ListingModel } from "./catalog-compare.js";
import { synchronizeConfig } from "./sync-config-stubs.js";
import { runHealthCheck } from "./health-check.js";
import { readFileSync } from "node:fs";

const listing = JSON.parse(
  readFileSync(new URL("../fixtures/router-models.2026-11-10.json", import.meta.url), "utf8"),
) as { data: ListingModel[] };

const SENTINEL_CONTENT = "SENTINEL-PROMPT-BODY-7f3a";
const SENTINEL_KEY = "sk-live-SENTINEL-KEY-9c1d";

describe("usage-report (opt-in, read-only, estimate-only)", () => {
  const lines = [
    JSON.stringify({ model: "agvi-0g-compute/claude-haiku-5.5", usage: { input: 200_000, output: 1000 }, content: SENTINEL_CONTENT, apiKey: SENTINEL_KEY }),
    JSON.stringify({ model: "deepseek-v4.1-flash", usage: { input: 1000, cacheRead: 5000, cacheWrite: 100, output: 100 } }),
    JSON.stringify({ model: "evil-model-id-not-in-catalog", usage: { input: 10 } }),
    "not json at all",
    JSON.stringify({ model: "claude-haiku-5.5" }),
  ].join("\n");

  const report = buildUsageReport(lines, MODEL_CATALOG);

  it("counts records and skipped lines without failing on bad input", () => {
    expect(report.totalRecords).toBe(3);
    expect(report.skippedLines).toBe(2);
    expect(report.estimated).toBe(true);
  });

  it("estimates Haiku cost in the long-context tier and flags nothing unknown for it", () => {
    const haiku = report.models.find((m) => m.model === "claude-haiku-5.5")!;
    expect(haiku.estimatedUsd).toBeCloseTo(0.1025, 6);
    expect(haiku.unknownRateClasses).toEqual([]);
    expect(haiku.notes.join(" ")).toContain("unverified");
  });

  it("treats DeepSeek cache tokens as unknown, not free", () => {
    const ds = report.models.find((m) => m.model === "deepseek-v4.1-flash")!;
    expect(ds.unknownRateClasses).toEqual(["cacheWrite"]);
    expect(ds.notes.join(" ")).toContain("cacheWrite has no published rate");
  });

  it("labels unknown models generically and never echoes arbitrary ids", () => {
    expect(report.models.map((m) => m.model)).toContain("unknown-model");
    expect(JSON.stringify(report)).not.toContain("evil-model-id");
  });

  it("never prints prompt content or key-like values", () => {
    const text = formatUsageReport(report) + JSON.stringify(report);
    expect(text).not.toContain(SENTINEL_CONTENT);
    expect(text).not.toContain(SENTINEL_KEY);
    expect(text).toContain("ESTIMATE ONLY");
  });
});

describe("usage-report malformed-input hardening", () => {
  it("skips JSON null, primitives, and arrays without throwing", () => {
    const text = ["null", "42", '"str"', "true", "[]", "[1,2]", ""].join("\n");
    const report = buildUsageReport(text, MODEL_CATALOG);
    expect(report.totalRecords).toBe(0);
    expect(report.skippedLines).toBe(6);
  });

  it("does not count usage that has no valid token field as a record", () => {
    const text = [
      JSON.stringify({ model: "claude-haiku-5.5", usage: null }),
      JSON.stringify({ model: "claude-haiku-5.5", usage: [1] }),
      JSON.stringify({ model: "claude-haiku-5.5", usage: {} }),
      JSON.stringify({ model: "claude-haiku-5.5", usage: { input: "12" } }),
      JSON.stringify({ model: "claude-haiku-5.5", usage: { input: -5 } }),
    ].join("\n");
    const report = buildUsageReport(text, MODEL_CATALOG);
    expect(report.totalRecords).toBe(0);
    expect(report.skippedLines).toBe(5);
  });

  it("keeps good lines when bad lines are interleaved", () => {
    const text = ["null", JSON.stringify({ model: "claude-haiku-5.5", usage: { input: 1000 } }), "[", ""].join("\n");
    const report = buildUsageReport(text, MODEL_CATALOG);
    expect(report.totalRecords).toBe(1);
    expect(report.skippedLines).toBe(2);
  });
});

describe("catalog-compare (opt-in, read-only, safe unknown/unavailable)", () => {
  it("reports every field unavailable when the listing could not be fetched", () => {
    const rows = compareCatalog(MODEL_CATALOG, null);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "unavailable")).toBe(true);
  });

  it("reports only the missing model as unavailable", () => {
    const rows = compareCatalog(MODEL_CATALOG, { data: listing.data.slice(0, 1) });
    expect(rows.filter((r) => r.model === "deepseek-v4.1-flash").every((r) => r.status === "unavailable")).toBe(true);
    expect(rows.some((r) => r.model === "claude-haiku-5.5" && r.status === "match")).toBe(true);
  });

  it("reports a missing listing field as unknown, not match", () => {
    const data = structuredClone(listing.data) as ListingModel[];
    delete data[0].context_length;
    const row = compareCatalog(MODEL_CATALOG, { data }).find((r) => r.model === "claude-haiku-5.5" && r.field === "contextWindow");
    expect(row?.status).toBe("unknown");
  });

  it("flags a real mismatch", () => {
    const data = structuredClone(listing.data) as ListingModel[];
    data[0].max_completion_tokens = 1;
    const row = compareCatalog(MODEL_CATALOG, { data }).find((r) => r.model === "claude-haiku-5.5" && r.field === "maxTokens");
    expect(row?.status).toBe("mismatch");
  });
});

describe("sync-config-stubs", () => {
  it("projects the canonical catalog and context token limits", () => {
    const config = { models: { providers: { "agvi-0g-compute": { models: [{ id: "stale" }] } } } };
    const result = synchronizeConfig(config);
    const models = result.models.providers["agvi-0g-compute"].models;

    expect(result).toBe(config);
    expect(models).toHaveLength(MODEL_CATALOG.length);
    expect(models[0]).toMatchObject({
      id: MODEL_CATALOG[0].id,
      contextTokens: MODEL_CATALOG[0].contextWindow,
    });
  });

  it("fails clearly when the host provider stub is missing", () => {
    expect(() => synchronizeConfig({ models: { providers: {} } })).toThrow(/Missing models.providers.agvi-0g-compute/);
  });
});

describe("health-check", () => {
  it("requires an environment-only API key before probing", async () => {
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.AGVI_0G_COMPUTE_API_KEY;
    const previousLegacyKey = process.env.ZEROG_COMPUTE_API_KEY;
    delete process.env.AGVI_0G_COMPUTE_API_KEY;
    delete process.env.ZEROG_COMPUTE_API_KEY;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: listing.data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await expect(runHealthCheck(["--probe"])).rejects.toThrow(/requires AGVI_0G_COMPUTE_API_KEY/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.AGVI_0G_COMPUTE_API_KEY;
      else process.env.AGVI_0G_COMPUTE_API_KEY = previousKey;
      if (previousLegacyKey === undefined) delete process.env.ZEROG_COMPUTE_API_KEY;
      else process.env.ZEROG_COMPUTE_API_KEY = previousLegacyKey;
    }
  });

  it("reports the first SSE event without returning the credential or response body", async () => {
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.AGVI_0G_COMPUTE_API_KEY;
    const previousLegacyKey = process.env.ZEROG_COMPUTE_API_KEY;
    const sentinelKey = "sk-live-health-sentinel";
    process.env.AGVI_0G_COMPUTE_API_KEY = sentinelKey;
    delete process.env.ZEROG_COMPUTE_API_KEY;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/models")) {
        return new Response(JSON.stringify({ data: listing.data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer " + sentinelKey);
      return new Response("data: probe-response-sentinel\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-request-id": "health-test" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const result = await runHealthCheck(["--probe"]);
      expect(result.probes).toHaveLength(4);
      expect(result.probes?.every((probe) => probe.ok && probe.firstEventMs !== undefined)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(sentinelKey);
      expect(JSON.stringify(result)).not.toContain("probe-response-sentinel");
      expect(fetchMock).toHaveBeenCalledTimes(5);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.AGVI_0G_COMPUTE_API_KEY;
      else process.env.AGVI_0G_COMPUTE_API_KEY = previousKey;
      if (previousLegacyKey === undefined) delete process.env.ZEROG_COMPUTE_API_KEY;
      else process.env.ZEROG_COMPUTE_API_KEY = previousLegacyKey;
    }
  });
});
