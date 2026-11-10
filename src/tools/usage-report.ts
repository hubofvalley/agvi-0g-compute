/**
 * Opt-in, read-only usage report. Run manually; the plugin runtime never loads this.
 *
 *   node dist/tools/usage-report.js --file <usage.jsonl> [--json]
 *
 * Input: one JSON object per line: {"model": "<id>", "usage": {"input": n, "output": n,
 * "cacheRead": n, "cacheWrite": n}}. Only these numeric fields and the model id are
 * read. Prompts, completions, keys and any other fields are never read or printed.
 * Output is an ESTIMATE; unknown or unverified rates are listed, not guessed.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { estimateCost, type ModelCost, type TokenClass, type TokenUsage } from "../pricing.js";

export const PROVIDER_PREFIX = "agvi-0g-compute/";

/** Rate facts that are not verified against an authoritative source yet. */
export const UNVERIFIED_RATE_NOTES: Record<string, string[]> = {
  "claude-haiku-5.5": [
    "cacheRead rate not in public router listing (unverified)",
    "tieredPricing above 100k input not in public router listing (unverified)",
  ],
  "deepseek-v4.1-flash": [
    "cacheWrite has no published rate (unknown, not free); cacheRead verified at $0.0416/M",
  ],
};

/** Cache rates stored as 0 placeholders: treated as UNKNOWN in estimates, never as free. */
const ZERO_IS_UNKNOWN: Record<string, readonly ("cacheRead" | "cacheWrite")[]> = {
  "deepseek-v4.1-flash": ["cacheWrite"],
};

function effectiveCost(modelId: string, cost: ModelCost): ModelCost {
  const unknown = ZERO_IS_UNKNOWN[modelId] ?? [];
  if (unknown.length === 0) return cost;
  const copy: ModelCost = { ...cost };
  for (const cls of unknown) if (copy[cls] === 0) delete copy[cls];
  return copy;
}

export type CatalogModel = { id: string; cost: ModelCost };

export type ModelReport = {
  model: string;
  records: number;
  tokens: Record<TokenClass, number>;
  estimatedUsd: number;
  unknownRateClasses: TokenClass[];
  notes: string[];
};

export type UsageReport = {
  estimated: true;
  totalRecords: number;
  skippedLines: number;
  models: ModelReport[];
};

const CLASSES: TokenClass[] = ["input", "output", "cacheRead", "cacheWrite"];

function normalizeModelId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return raw.startsWith(PROVIDER_PREFIX) ? raw.slice(PROVIDER_PREFIX.length) : raw;
}

function numericUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const out: TokenUsage = {};
  let any = false;
  for (const cls of CLASSES) {
    const value = source[cls];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      out[cls] = value;
      any = true;
    }
  }
  // A usage object with no valid token count is not a record.
  return any ? out : undefined;
}

/** Parses one JSONL line into a plain object record, or undefined. Never throws. */
function parseRecord(line: string): { model?: unknown; usage?: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  // JSON.parse also yields null, numbers, strings, booleans, and arrays; none is a record.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as { model?: unknown; usage?: unknown };
}

/** Aggregates JSONL lines. Pure: takes text and the catalog, returns an estimate. */
export function buildUsageReport(jsonlText: string, catalog: readonly CatalogModel[]): UsageReport {
  const byModel = new Map<string, ModelReport>();
  let totalRecords = 0;
  let skippedLines = 0;
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (!record) {
      skippedLines++;
      continue;
    }
    const usage = numericUsage(record.usage);
    const modelId = normalizeModelId(record.model);
    if (!usage || !modelId) {
      skippedLines++;
      continue;
    }
    const entry = catalog.find((m) => m.id === modelId);
    // Unknown models are reported under a fixed label so arbitrary ids never reach output.
    const label = entry ? modelId : "unknown-model";
    let report = byModel.get(label);
    if (!report) {
      report = {
        model: label,
        records: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        estimatedUsd: 0,
        unknownRateClasses: [],
        notes: entry ? (UNVERIFIED_RATE_NOTES[modelId] ?? []) : ["not in plugin catalog: no rate applied"],
      };
      byModel.set(label, report);
    }
    report.records++;
    totalRecords++;
    for (const cls of CLASSES) report.tokens[cls] += usage[cls] ?? 0;
    if (entry) {
      const est = estimateCost(effectiveCost(modelId, entry.cost), usage);
      report.estimatedUsd += est.usd;
      for (const cls of est.unknownRateClasses) {
        if (!report.unknownRateClasses.includes(cls)) report.unknownRateClasses.push(cls);
      }
    } else {
      for (const cls of CLASSES) {
        if ((usage[cls] ?? 0) > 0 && !report.unknownRateClasses.includes(cls)) report.unknownRateClasses.push(cls);
      }
    }
  }
  return { estimated: true, totalRecords, skippedLines, models: [...byModel.values()] };
}

export function formatUsageReport(report: UsageReport): string {
  const lines = [
    `ESTIMATE ONLY. Records: ${report.totalRecords}. Skipped lines: ${report.skippedLines}.`,
  ];
  for (const m of report.models) {
    lines.push(
      `- ${m.model}: records=${m.records} input=${m.tokens.input} output=${m.tokens.output} ` +
        `cacheRead=${m.tokens.cacheRead} cacheWrite=${m.tokens.cacheWrite} ` +
        `estUSD=${m.estimatedUsd.toFixed(6)} unknownRates=[${m.unknownRateClasses.join(",")}]`,
    );
    for (const note of m.notes) lines.push(`    note: ${note}`);
  }
  return lines.join("\n");
}

async function main(argv: string[]): Promise<void> {
  const fileIndex = argv.indexOf("--file");
  const file = fileIndex >= 0 ? argv[fileIndex + 1] : undefined;
  if (!file) {
    process.stderr.write("usage: usage-report --file <usage.jsonl> [--json]\n");
    process.exitCode = 2;
    return;
  }
  // Lazy import keeps the pure functions above free of the OpenClaw SDK import.
  const { MODEL_CATALOG } = await import("../index.js");
  const report = buildUsageReport(readFileSync(file, "utf8"), MODEL_CATALOG);
  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${formatUsageReport(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`usage-report failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
