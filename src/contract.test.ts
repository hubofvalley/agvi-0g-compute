import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import entry, { DEFAULT_REQUEST_TIMEOUT_SECONDS, ENV_VARS, MODEL_CATALOG } from "./index.js";
import { estimateCost, selectTierRates } from "./pricing.js";
import { compareCatalog, type ListingModel } from "./tools/catalog-compare.js";

/**
 * Offline contract tests. They check manifest, runtime registration, metadata, and
 * a dated snapshot of the public router listing. They do NOT call the live router,
 * do NOT resolve credentials through the OpenClaw SDK, and do NOT prove stream behavior.
 */
const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const manifest = readJson("../openclaw.plugin.json");
const pkg = readJson("../package.json");
const listing = readJson("./fixtures/router-models.2026-11-10.json") as { data: ListingModel[] };
const haiku = MODEL_CATALOG[0];
const deepseek = MODEL_CATALOG[1];
const qwen = MODEL_CATALOG[2];
const glm = MODEL_CATALOG[3];
const glmFull = MODEL_CATALOG[4];
const listed = (id: string) => listing.data.find((m) => m.id === id)!;

function registeredProvider(): ProviderPlugin {
  const providers: ProviderPlugin[] = [];
  entry.register({ registerProvider: (p: ProviderPlugin) => providers.push(p) } as unknown as OpenClawPluginApi);
  expect(providers).toHaveLength(1);
  return providers[0];
}

describe("auth and manifest consistency", () => {
  it("keeps manifest, package, and plugin identity aligned", () => {
    expect(manifest.id).toBe("agvi-0g-compute");
    expect(manifest.providers).toEqual(["agvi-0g-compute"]);
    expect(manifest.setup.providers[0].id).toBe("agvi-0g-compute");
    expect(manifest.version).toBe(pkg.version);
    expect(pkg.openclaw.extensions).toEqual(["./dist/index.js"]);
  });

  it("accepts both env names, canonical first, and the manifest matches the runtime", () => {
    expect([...ENV_VARS]).toEqual(["AGVI_0G_COMPUTE_API_KEY", "ZEROG_COMPUTE_API_KEY"]);
    expect(manifest.setup.providers[0].envVars).toEqual([...ENV_VARS]);
    expect(registeredProvider().envVars).toEqual([...ENV_VARS]);
  });



  it("normalizes provider timeout and replaces stale inline model metadata with the canonical catalog", () => {
    const provider = registeredProvider();
    const base = {
      baseUrl: "https://router-api.0g.ai/v1",
      models: [{ id: "deepseek-v4.1-flash", name: "stale", maxTokens: 384000 }],
    } as never;
    expect(provider.normalizeConfig?.({ providerConfig: base } as never)).toMatchObject({
      timeoutSeconds: DEFAULT_REQUEST_TIMEOUT_SECONDS,
      models: MODEL_CATALOG,
    });
    expect(provider.normalizeConfig?.({ providerConfig: { ...base, timeoutSeconds: 240 } } as never)).toMatchObject({
      timeoutSeconds: 240,
      models: MODEL_CATALOG,
    });
  });

});

describe("metadata and pricing boundaries", () => {
  it("selects the Haiku tier with half-open ranges (100,000 base; 100,001 long-context)", () => {
    expect(selectTierRates(haiku.cost, 0).input).toBe(0.0999);
    expect(selectTierRates(haiku.cost, 100_000).input).toBe(0.0999);
    expect(selectTierRates(haiku.cost, 100_001).input).toBe(0.5);
    expect(selectTierRates(haiku.cost, 100_001).output).toBe(2.5);
  });

  it("uses base rates for DeepSeek, which has no tiers", () => {
    expect(selectTierRates(deepseek.cost, 900_000)).toBe(deepseek.cost);
  });

  it("estimates USD per million tokens and flags tier selection as an estimate", () => {
    expect(estimateCost(haiku.cost, { input: 200_000 }).usd).toBeCloseTo(0.1, 9);
    const boundary = estimateCost(haiku.cost, { input: 100_000, cacheRead: 1 });
    expect(boundary.tierInputTokens).toBe(100_001);
    expect(selectTierRates(haiku.cost, boundary.tierInputTokens).input).toBe(0.5);
    expect(estimateCost(deepseek.cost, { input: 1_000_000 }).usd).toBeCloseTo(0.4166, 9);
  });

});

describe("snapshot of the public router listing (2026-11-10, offline)", () => {
  const rows = compareCatalog(MODEL_CATALOG, listing);
  const find = (model: string, field: string) => rows.find((r) => r.model === model && r.field === field);

  it("matches the Haiku context and output limits", () => {
    expect(find(haiku.id, "contextWindow")?.status).toBe("match");
    expect(find(haiku.id, "maxTokens")?.status).toBe("match");
    expect(find(haiku.id, "api-format")?.status).toBe("match");
  });

  it("treats Haiku prompt price as approx (listing rounds 0.0999 to 0.1) and completion as match", () => {
    expect(find(haiku.id, "price.input")?.status).toBe("approx");
    expect(find(haiku.id, "price.output")?.status).toBe("match");
    expect(find(haiku.id, "price.cacheWrite")?.status).toBe("match");
  });

  it("matches the exact DeepSeek 384-Ki output-token limit", () => {
    const row = find(deepseek.id, "maxTokens");
    expect(row?.status).toBe("match");
    expect(Number(row?.plugin)).toBe(deepseek.maxTokens);
    expect(Number(row?.listing)).toBe(listed(deepseek.id).max_completion_tokens);
  });

  it("keeps Qwen conservative where the router does not publish a completion-token limit", () => {
    expect(find(qwen.id, "contextWindow")?.status).toBe("match");
    const row = find(qwen.id, "maxTokens");
    expect(row?.status).toBe("unknown");
    expect(Number(row?.plugin)).toBe(qwen.maxTokens);
    expect(row?.listing).toBe("-");
    expect(find(qwen.id, "api-format")?.status).toBe("match");
    expect(find(qwen.id, "price.input")?.status).toBe("match");
    expect(find(qwen.id, "price.output")?.status).toBe("match");
  });

  it("matches GLM 5.3 Flash context, output limit, protocol and pricing", () => {
    expect(find(glm.id, "contextWindow")?.status).toBe("match");
    expect(find(glm.id, "maxTokens")?.status).toBe("match");
    expect(find(glm.id, "api-format")?.status).toBe("match");
    expect(find(glm.id, "price.input")?.status).toBe("match");
    expect(find(glm.id, "price.output")?.status).toBe("match");
  });

  it("matches full GLM 5.3 TEE-capable catalog metadata and pricing", () => {
    expect(find(glmFull.id, "contextWindow")?.status).toBe("match");
    expect(find(glmFull.id, "maxTokens")?.status).toBe("match");
    expect(find(glmFull.id, "api-format")?.status).toBe("match");
    expect(find(glmFull.id, "price.input")?.status).toBe("match");
    expect(find(glmFull.id, "price.output")?.status).toBe("match");
    expect(listed(glmFull.id).tee_attested).toBe(true);
    expect(listed(glmFull.id).verifiability).toBe("TeeML");
  });

  it("marks cache-read and tier data unknown rather than verified", () => {
    expect(find(haiku.id, "price.cacheRead")?.status).toBe("unknown");
    expect(find(haiku.id, "tieredPricing")?.status).toBe("unknown");
    expect(find(deepseek.id, "price.cacheRead")?.status).toBe("unknown");
  });
});

describe("protocol and cache contract (metadata-level, not live streams)", () => {
  it("keeps cache control and input modality metadata aligned with the listing", () => {
    expect(listed(haiku.id).supported_parameters).toContain("cache_control");
    expect(listed(deepseek.id).supported_parameters).not.toContain("cache_control");

    for (const model of [haiku, deepseek, qwen, glm, glmFull]) {
      const remote = listed(model.id);
      expect([...model.input].sort()).toEqual([...(remote.architecture?.input_modalities ?? [])].sort());
    }
  });
});
