/**
 * Synchronize OpenClaw's required custom-provider model projection from the
 * plugin-owned canonical MODEL_CATALOG.
 *
 * OpenClaw validates and builds its early thinking catalog from the configured
 * `models.providers.<id>.models` rows before provider runtime normalization.
 * Keeping those rows generated from MODEL_CATALOG avoids hand-maintained drift
 * while still satisfying the host's preflight contract.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MODEL_CATALOG } from "../catalog.js";
import { PROVIDER_ID } from "../identifiers.js";

const PROVIDER = PROVIDER_ID;

function projectModel(model: (typeof MODEL_CATALOG)[number]) {
  return {
    ...model,
    contextTokens: model.contextWindow,
  };
}

export function synchronizeConfig(config: Record<string, any>): Record<string, any> {
  const provider = config?.models?.providers?.[PROVIDER];
  if (!provider || typeof provider !== "object") {
    throw new Error(`Missing models.providers.${PROVIDER}`);
  }
  provider.models = MODEL_CATALOG.map(projectModel);
  return config;
}

function main() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : undefined;
  const write = args.includes("--write");
  if (!configPath) throw new Error("Usage: sync-config-stubs --config <openclaw.json> [--write]");
  const config = synchronizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
  if (!write) {
    process.stdout.write(JSON.stringify(config.models.providers[PROVIDER].models, null, 2) + "\n");
    return;
  }
  const tmp = join(dirname(configPath), `.${PROVIDER}-config-${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, configPath);
  process.stdout.write(`Synchronized ${MODEL_CATALOG.length} ${PROVIDER} model projections.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
