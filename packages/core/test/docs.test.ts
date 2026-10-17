import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATIONAL_ERROR_CODES, RULE_CATALOG } from "../src/index.js";

const root = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("documentation stays in sync with the code", () => {
  const rulesDoc = read("docs/RULES.md");

  it("docs/RULES.md lists every rule and nothing else", () => {
    const documented = [...rulesDoc.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| (error|warning|info) \|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual(RULE_CATALOG.map((r) => r.id).sort());
    for (const r of RULE_CATALOG) expect(rulesDoc).toContain(`| \`${r.id}\` | ${r.defaultSeverity} |`);
  });

  it("docs/RULES.md lists every operational error code", () => {
    for (const code of OPERATIONAL_ERROR_CODES) expect(rulesDoc, code).toContain(`\`${code}\``);
  });

  it("the rule count in the READMEs matches the catalog", () => {
    expect(read("README.md")).toContain(`${RULE_CATALOG.length} rules`);
    expect(read("packages/cli/README.md")).toContain(`${RULE_CATALOG.length} rules`);
  });
});

describe("MCP registry metadata", () => {
  const server = JSON.parse(read("server.json")) as {
    name: string;
    description: string;
    version: string;
    packages: { identifier: string; version: string }[];
  };
  const cli = JSON.parse(read("packages/cli/package.json")) as { name: string; version: string; mcpName: string };

  it("server.json matches the CLI package", () => {
    expect(server.name).toBe(cli.mcpName);
    expect(server.packages[0]?.identifier).toBe(cli.name);
    expect(server.packages[0]?.version).toBe(cli.version);
    expect(server.version).toBe(cli.version);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("all packages share one version and depend on exact sibling versions", () => {
    const pkgs = ["core", "browser", "cli"].map((d) => JSON.parse(read(`packages/${d}/package.json`)) as { version: string; dependencies?: Record<string, string> });
    expect(new Set(pkgs.map((p) => p.version)).size).toBe(1);
    for (const p of pkgs) for (const [dep, v] of Object.entries(p.dependencies ?? {})) if (dep.startsWith("seo-notary")) expect(v).toBe(pkgs[0]?.version);
  });
});
