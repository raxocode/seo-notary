import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

export interface BrowserStatus {
  playwrightVersion: string;
  installed: boolean;
  executablePath: string | null;
}

function playwrightCli(): { cli: string; version: string } {
  const pkgPath = createRequire(import.meta.url).resolve("playwright-core/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; bin: Record<string, string> };
  return { cli: join(dirname(pkgPath), pkg.bin["playwright-core"] ?? "cli.js"), version: pkg.version };
}

export function browserStatus(): BrowserStatus {
  const { version } = playwrightCli();
  let path: string | null;
  try {
    path = chromium.executablePath();
  } catch {
    path = null;
  }
  return { playwrightVersion: version, installed: path !== null && existsSync(path), executablePath: path };
}

/** Runs Playwright's documented headless-shell install for Chromium. Resolves with the exit code. */
export function installBrowser(options: { stdio?: "inherit" | "ignore" } = {}): Promise<number> {
  const { cli } = playwrightCli();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "install", "--only-shell", "chromium"], { stdio: options.stdio ?? "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
