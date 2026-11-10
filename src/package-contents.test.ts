import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

/**
 * Package-inclusion regression. Runs `npm pack --dry-run` (writes no tarball) and asserts
 * that everything OpenClaw loads at runtime is in the published file list.
 */
const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  files: string[];
  openclaw: { extensions: string[] };
};

function packedPaths(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root.pathname,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  type PackResult = { files?: { path: string }[] };
  const parsed = JSON.parse(out) as PackResult | PackResult[] | Record<string, PackResult>;
  const result = Array.isArray(parsed)
    ? parsed[0]
    : Array.isArray(parsed.files)
      ? parsed
      : Object.values(parsed)[0];
  if (!result || !Array.isArray(result.files)) {
    throw new Error(`npm pack --json did not return a file list: ${out.slice(0, 500)}`);
  }
  return result.files.map((f) => f.path);
}

describe("npm package contents", () => {
  const paths = packedPaths();

  it("ships every openclaw.extensions entry (the live load path)", () => {
    expect(pkg.openclaw.extensions.length).toBeGreaterThan(0);
    for (const ext of pkg.openclaw.extensions) {
      const rel = ext.replace(/^\.\//, "");
      expect(existsSync(new URL(rel, root))).toBe(true);
      expect(paths).toContain(rel);
    }
  });

  it("ships the manifest, README, and compiled output", () => {
    expect(paths).toContain("openclaw.plugin.json");
    expect(paths).toContain("README.md");
    expect(paths).toEqual(expect.arrayContaining([
      "dist/catalog.js",
      "dist/config.js",
      "dist/discovery.js",
      "dist/identifiers.js",
      "dist/index.js",
      "dist/pricing.js",
      "dist/transport.js",
      "dist/tools/catalog-compare.js",
      "dist/tools/health-check.js",
      "dist/tools/sync-config-stubs.js",
      "dist/tools/usage-report.js",
    ]));
  });

  it("does not ship tests or local scratch artefacts", () => {
    expect(paths.filter((p) => p.endsWith(".test.ts"))).toEqual([]);
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
  });
});
