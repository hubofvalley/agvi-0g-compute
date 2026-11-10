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
import { ROUTER_BASE_URL } from "../identifiers.js";
export const LISTING_URL = `${ROUTER_BASE_URL}/models`;
/** Listing prices are per token and rounded to 7 decimals (0.1 per million). */
const LISTING_RESOLUTION_PER_TOKEN = 1e-7;
const API_TO_FORMAT = {
    "anthropic-messages": "anthropic",
    "openai-completions": "openai",
    "openai-responses": "responses",
};
function fmt(value) {
    return value === undefined || value === null ? "-" : String(value);
}
function priceStatus(plugin, listingRaw) {
    if (plugin === undefined)
        return { status: "unknown", listing: fmt(listingRaw) };
    if (listingRaw === undefined)
        return { status: "unknown", listing: "-" };
    const perToken = Number(listingRaw);
    if (!Number.isFinite(perToken))
        return { status: "unknown", listing: fmt(listingRaw) };
    const listingPerMillion = (perToken * 1_000_000).toFixed(4);
    const pluginPerToken = plugin / 1_000_000;
    const diff = Math.abs(perToken - pluginPerToken);
    if (diff < 1e-12)
        return { status: "match", listing: listingPerMillion };
    // Within half a listing step: the listing cannot distinguish the two values.
    if (diff <= LISTING_RESOLUTION_PER_TOKEN / 2)
        return { status: "approx", listing: listingPerMillion };
    return { status: "mismatch", listing: listingPerMillion };
}
/** Pure comparison. `listing` null means the listing is unavailable. */
export function compareCatalog(catalog, listing) {
    const rows = [];
    for (const entry of catalog) {
        const remote = listing?.data?.find((m) => m.id === entry.id);
        const add = (field, plugin, listingValue, status) => {
            if (!remote) {
                rows.push({ model: entry.id, field, plugin: fmt(plugin), listing: "-", status: "unavailable" });
                return;
            }
            if (status) {
                rows.push({ model: entry.id, field, plugin: fmt(plugin), listing: fmt(listingValue), status });
                return;
            }
            const hasListing = listingValue !== undefined && listingValue !== null;
            const st = !hasListing ? "unknown" : listingValue === plugin ? "match" : "mismatch";
            rows.push({ model: entry.id, field, plugin: fmt(plugin), listing: fmt(listingValue), status: st });
        };
        add("contextWindow", entry.contextWindow, remote?.context_length);
        add("maxTokens", entry.maxTokens, remote?.max_completion_tokens);
        const modalities = remote?.architecture?.input_modalities;
        const pluginInput = [...entry.input].sort().join(",");
        add("input", pluginInput, modalities ? [...modalities].sort().join(",") : undefined);
        const format = API_TO_FORMAT[entry.api];
        const formats = remote?.supported_formats;
        add("api-format", `${entry.api}(${format ?? "unmapped"})`, formats ? formats.join(",") : undefined, !remote ? "unavailable" : !format || !formats ? "unknown" : formats.includes(format) ? "match" : "mismatch");
        const priceFields = [
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
async function fetchListing(fetcher = fetch) {
    try {
        // Public, unauthenticated GET. No key is attached on purpose.
        const res = await fetcher(LISTING_URL, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
export function formatRows(rows) {
    const head = "model | field | plugin | listing | status";
    return [head, ...rows.map((r) => `${r.model} | ${r.field} | ${r.plugin} | ${r.listing} | ${r.status}`)].join("\n");
}
async function main(argv) {
    const listingIndex = argv.indexOf("--listing");
    let listing;
    if (listingIndex >= 0 && argv[listingIndex + 1]) {
        try {
            listing = JSON.parse(readFileSync(argv[listingIndex + 1], "utf8"));
        }
        catch {
            listing = null;
        }
    }
    else if (argv.includes("--fetch")) {
        listing = await fetchListing();
    }
    else {
        process.stderr.write("usage: catalog-compare (--fetch | --listing <file>) [--json]\n");
        process.exitCode = 2;
        return;
    }
    const { MODEL_CATALOG } = await import("../catalog.js");
    const rows = compareCatalog(MODEL_CATALOG, listing);
    process.stdout.write(argv.includes("--json") ? `${JSON.stringify(rows, null, 2)}\n` : `${formatRows(rows)}\nNo config was read or changed.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main(process.argv.slice(2)).catch((err) => {
        process.stderr.write(`catalog-compare failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
        process.exitCode = 1;
    });
}
