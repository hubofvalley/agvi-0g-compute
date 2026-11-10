/**
 * Opt-in, read-only catalog comparison against the public 0G router model listing.
 * Never writes config, never changes model selection, and sends no API key.
 *
 *   node dist/tools/catalog-compare.js --fetch            # live public GET
 *   node dist/tools/catalog-compare.js --listing <file>   # saved snapshot
 *   add --json for machine-readable rows
 *
 * Status meanings: match | mismatch | unknown (listing lacks the field) |
 * unavailable (listing or model missing/unreachable). Nothing is guessed.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ModelCost } from "../pricing.js";

export const LISTING_URL = "https://router-api.0g.ai/v1/models";

/** Listing prices are per token and rounded to 7 decimals (0.1 per million). */
const LISTING_RESOLUTION_PER_TOKEN = 1e-7;

export type Status = "match" | "approx" | "mismatch" | "unknown" | "unavailable";

export type CatalogEntry = {
  id: string;
  api: string;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
};

export type ListingModel = {
  id: string;
  context_length?: number;
  max_completion_tokens?: number;
  architecture?: { input_modalities?: string[] };
  supported_formats?: string[];
  pricing_usd?: Record<string, string | undefined>;
  provider_count?: number;
  verifiability?: string | null;
  tee_attested?: boolean | null;
  tee_verifier?: string | null;
};

export type CompareRow = { model: string; field: string; plugin: string; listing: string; status: Status };

const API_TO_FORMAT: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-completions": "openai",
  "openai-responses": "responses",
};

function fmt(value: unknown): string {
  return value === undefined || value === null ? "-" : String(value);
}

function priceStatus(plugin: number | undefined, listingRaw: string | undefined): { status: Status; listing: string } {
  if (plugin === undefined) return { status: "unknown", listing: fmt(listingRaw) };
  if (listingRaw === undefined) return { status: "unknown", listing: "-" };
  const perToken = Number(listingRaw);
  if (!Number.isFinite(perToken)) return { status: "unknown", listing: fmt(listingRaw) };
  const listingPerMillion = (perToken * 1_000_000).toFixed(4);
  const pluginPerToken = plugin / 1_000_000;
  const diff = Math.abs(perToken - pluginPerToken);
  if (diff < 1e-12) return { status: "match", listing: listingPerMillion };
  // Within half a listing step: the listing cannot distinguish the two values.
  if (diff <= LISTING_RESOLUTION_PER_TOKEN / 2) return { status: "approx", listing: listingPerMillion };
  return { status: "mismatch", listing: listingPerMillion };
}

/** Pure comparison. `listing` null means the listing is unavailable. */
export function compareCatalog(
  catalog: readonly CatalogEntry[],
  listing: { data?: ListingModel[] } | null,
): CompareRow[] {
  const rows: CompareRow[] = [];
  for (const entry of catalog) {
    const remote = listing?.data?.find((m) => m.id === entry.id);
    const add = (field: string, plugin: unknown, listingValue: unknown, status?: Status) => {
      if (!remote) {
        rows.push({ model: entry.id, field, plugin: fmt(plugin), listing: "-", status: "unavailable" });
        return;
      }
      if (status) {
        rows.push({ model: entry.id, field, plugin: fmt(plugin), listing: fmt(listingValue), status });
        return;
      }
      const hasListing = listingValue !== undefined && listingValue !== null;
      const st: Status = !hasListing ? "unknown" : listingValue === plugin ? "match" : "mismatch";
      rows.push({ model: entry.id, field, plugin: fmt(plugin), listing: fmt(listingValue), status: st });
    };

    add("contextWindow", entry.contextWindow, remote?.context_length);
    add("maxTokens", entry.maxTokens, remote?.max_completion_tokens);

    const modalities = remote?.architecture?.input_modalities;
    const pluginInput = [...entry.input].sort().join(",");
    add(
      "input",
      pluginInput,
      modalities ? [...modalities].sort().join(",") : undefined,
    );

    const format = API_TO_FORMAT[entry.api];
    const formats = remote?.supported_formats;
    add(
      "api-format",
      `${entry.api}(${format ?? "unmapped"})`,
      formats ? formats.join(",") : undefined,
      !remote ? "unavailable" : !format || !formats ? "unknown" : formats.includes(format) ? "match" : "mismatch",
    );

    const priceFields: [string, number | undefined, string][] = [
      ["price.input", entry.cost.input, "prompt"],
      ["price.output", entry.cost.output, "completion"],
      ["price.cacheWrite", entry.cost.cacheWrite, "cache_write"],
      ["price.cacheRead", entry.cost.cacheRead, "cache_read"],
    ];
    for (const [field, pluginRate, key] of priceFields) {
      if (!remote) {
        rows.push({ model: entry.id, field, plugin: fmt(pluginRate), listing: "-", status: "unavailable" });
        continue;
      }
      const { status, listing: listingValue } = priceStatus(pluginRate, remote.pricing_usd?.[key]);
      rows.push({ model: entry.id, field, plugin: fmt(pluginRate), listing: listingValue, status });
    }

    rows.push({
      model: entry.id,
      field: "tieredPricing",
      plugin: entry.cost.tieredPricing ? `${entry.cost.tieredPricing.length} tiers` : "none",
      listing: "not published in listing",
      status: remote ? "unknown" : "unavailable",
    });
  }
  return rows;
}

async function fetchListing(fetcher: typeof fetch = fetch): Promise<{ data?: ListingModel[] } | null> {
  try {
    // Public, unauthenticated GET. No key is attached on purpose.
    const res = await fetcher(LISTING_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as { data?: ListingModel[] };
  } catch {
    return null;
  }
}

export function formatRows(rows: CompareRow[]): string {
  const head = "model | field | plugin | listing | status";
  return [head, ...rows.map((r) => `${r.model} | ${r.field} | ${r.plugin} | ${r.listing} | ${r.status}`)].join("\n");
}

async function main(argv: string[]): Promise<void> {
  const listingIndex = argv.indexOf("--listing");
  let listing: { data?: ListingModel[] } | null;
  if (listingIndex >= 0 && argv[listingIndex + 1]) {
    try {
      listing = JSON.parse(readFileSync(argv[listingIndex + 1], "utf8")) as { data?: ListingModel[] };
    } catch {
      listing = null;
    }
  } else if (argv.includes("--fetch")) {
    listing = await fetchListing();
  } else {
    process.stderr.write("usage: catalog-compare (--fetch | --listing <file>) [--json]\n");
    process.exitCode = 2;
    return;
  }
  // Lazy import keeps the pure comparison free of the OpenClaw SDK import.
  const { MODEL_CATALOG } = await import("../index.js");
  const rows = compareCatalog(MODEL_CATALOG as unknown as CatalogEntry[], listing);
  process.stdout.write(
    argv.includes("--json") ? `${JSON.stringify(rows, null, 2)}\n` : `${formatRows(rows)}\nNo config was read or changed.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`catalog-compare failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
