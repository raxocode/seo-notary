import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("seo-notary-core stays browser-free", () => {
  it("declares no browser dependency", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg["dependencies"], ...pkg["optionalDependencies"], ...pkg["peerDependencies"] });
    expect(deps.filter((d) => /playwright|puppeteer|chromium|selenium/i.test(d))).toEqual([]);
    expect(Object.keys(pkg["scripts"] ?? {}).filter((s) => /install/i.test(s))).toEqual([]);
  });

  it("never imports a browser library", () => {
    const files = readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts"));
    for (const f of files) {
      const src = readFileSync(join(root, "src", f), "utf8");
      expect(src, f).not.toMatch(/from\s+["'](playwright|puppeteer|seo-notary-browser)/);
      expect(src, f).not.toMatch(/import\(\s*["'](playwright|puppeteer)/);
    }
  });
});
