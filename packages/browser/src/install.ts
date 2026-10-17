import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

export interface BrowserStatus {
  playwrightVersion: string;
  /** True when a headless browser could be launched (bundled shell or system Chrome). */
  usable: boolean;
  browserVersion: string | null;
  /** Why the launch failed, when it did. */
  problem: "not-installed" | "cannot-start" | null;
  detail: string | null;
}

function playwrightCli(): { cli: string; version: string } {
  const pkgPath = createRequire(import.meta.url).resolve("playwright-core/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; bin: Record<string, string> };
  return { cli: join(dirname(pkgPath), pkg.bin["playwright-core"] ?? "cli.js"), version: pkg.version };
}

/** Launches and closes a headless browser: the only reliable check that it can actually run. */
export async function browserStatus(): Promise<BrowserStatus> {
  const { version } = playwrightCli();
  const attempt = async (opts: Parameters<typeof chromium.launch>[0]) => {
    const browser = await chromium.launch(opts);
    const v = browser.version();
    await browser.close();
    return v;
  };
  try {
    return { playwrightVersion: version, usable: true, browserVersion: await attempt({ headless: true }), problem: null, detail: null };
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
    if (/executable doesn't exist/i.test(message)) {
      try {
        return { playwrightVersion: version, usable: true, browserVersion: await attempt({ headless: true, channel: "chrome" }), problem: null, detail: "using system Chrome" };
      } catch {
        return { playwrightVersion: version, usable: false, browserVersion: null, problem: "not-installed", detail: null };
      }
    }
    return { playwrightVersion: version, usable: false, browserVersion: null, problem: "cannot-start", detail: message.slice(0, 200) };
  }
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
