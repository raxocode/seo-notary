import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type MockServer } from "../helpers/mock-server.js";

const exec = promisify(execFile);
const ROOT = new URL("../../", import.meta.url).pathname;

let work: string;
let consumer: string;
let browsers: string;
let srv: MockServer;
const tarballs: string[] = [];
const packed: Record<string, string[]> = {};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "notary-pack-"));
  consumer = join(work, "consumer");
  browsers = join(work, "browsers");
  await mkdir(consumer);
  await mkdir(browsers);
  srv = await startServer((_q, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Consumer smoke test page</title><meta name='description' content='d'><link rel='canonical' href='/'><p>hello</p>");
  });
  for (const pkg of ["seo-notary-core", "seo-notary-browser", "seo-notary"]) {
    const { stdout } = await exec("npm", ["pack", "-w", pkg, "--pack-destination", work, "--json"], { cwd: ROOT });
    const info = JSON.parse(stdout) as { filename: string; files: { path: string }[] }[];
    tarballs.push(join(work, info[0]!.filename));
    packed[pkg] = info[0]!.files.map((f) => f.path);
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
}, 240_000);

afterAll(async () => {
  await srv.close();
  await rm(work, { recursive: true, force: true });
});

describe("packed packages", () => {
  it("contain only dist, README, LICENSE and package.json", () => {
    for (const [pkg, files] of Object.entries(packed)) {
      for (const f of files) expect(f, `${pkg}: ${f}`).toMatch(/^(dist\/.+|README\.md|LICENSE|package\.json)$/);
      expect(files, pkg).toContain("README.md");
      expect(files, pkg).toContain("LICENSE");
      expect(files.some((f) => f.endsWith(".d.ts")), pkg).toBe(true);
    }
  });

  it("install from clean without downloading a browser, then Tier 1 works", async () => {
    await exec("npm", ["install", "--no-audit", "--no-fund", ...tarballs], {
      cwd: consumer,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
      timeout: 200_000,
    });
    expect(await readdir(browsers)).toEqual([]);

    const bin = join(consumer, "node_modules", ".bin", "seo-notary");
    const version = await exec(bin, ["--version"]);
    expect(version.stdout).toMatch(/^0\.1\.0/);
    const run = await exec(bin, ["verify", srv.url("/"), "--format", "json"], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers } });
    expect(JSON.parse(run.stdout).status).toBe("pass");
    expect(await readdir(browsers)).toEqual([]);
  }, 240_000);

  it("browser tier says exactly how to fix a missing Chromium", async () => {
    const bin = join(consumer, "node_modules", ".bin", "seo-notary");
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers, HOME: join(work, "empty-home") };
    await mkdir(env.HOME, { recursive: true });
    const failed = await exec(bin, ["verify", srv.url("/"), "--tier", "browser"], { env }).then(
      () => null,
      (e: { code?: number; stderr?: string }) => e,
    );
    expect(failed?.code).toBe(2);
    expect(failed?.stderr).toContain("BROWSER_UNAVAILABLE");
    expect(failed?.stderr).toContain("seo-notary install-browser");
  }, 120_000);

  it("the library entry points import in a plain Node ESM consumer", async () => {
    const script = join(consumer, "lib.mjs");
    await writeFile(script, 'import { RULE_IDS, LocalRunner } from "seo-notary-core"; import { BrowserManager } from "seo-notary-browser"; console.log(RULE_IDS.length, typeof LocalRunner, typeof BrowserManager);');
    const r = await exec(process.execPath, [script], { cwd: consumer });
    expect(r.stdout.trim()).toBe("23 function function");
  });
});
