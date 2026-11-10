import { describe, it, expect } from "vitest";
import { MODEL_CATALOG } from "./index.js";

/**
 * Regression for the DeepSeek route. The live 0G route rejects the `developer` role
 * (HTTP 400, "developer is not one of ['system', 'assistant', 'user', 'tool', 'function']")
 * and accepts the system prompt only as `system`. The catalog must say so.
 * This is a metadata check, not a live call.
 */
describe("DeepSeek route compatibility", () => {
  const ds = MODEL_CATALOG.find((m) => m.id === "deepseek-v4.1-flash")!;

  it("disables the developer role so the system prompt is sent as role=system", () => {
    expect(ds.reasoning).toBe(true);
    expect((ds as { compat?: { supportsDeveloperRole?: boolean } }).compat?.supportsDeveloperRole).toBe(false);
  });

  it("uses the verified DeepSeek cache-read rate and keeps cache-write unknown", () => {
    // Source: pc.0g.ai/models/deepseek-v4.1-flash, "Cache Read / 1M $0.0416". No cache-write rate is published.
    expect(ds.cost.cacheRead).toBe(0.0416);
    expect(ds.cost.cacheWrite).toBe(0);
  });

  it("does not change the Haiku route", () => {
    const haiku = MODEL_CATALOG.find((m) => m.id === "claude-haiku-5.5") as unknown as { compat?: unknown };
    expect(haiku.compat).toBeUndefined();
  });
});
