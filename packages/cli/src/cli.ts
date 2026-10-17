import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NotaryError, RULE_CATALOG, type Report } from "seo-notary-core";
import { formatReport, formatRules, palette, type Palette } from "./format.js";
import { LazyBrowser } from "./lazy-browser.js";
import { runMcpServer } from "./mcp.js";
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, verifyOnce, type VerifyOptions } from "./verify-once.js";

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  color: boolean;
}

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_ERROR = 2;

const MIN_NODE = [22, 19, 0] as const;
// package.json sits one level above both src/ and dist/.
const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

class UsageError extends Error {}

const HELP = `seo-notary: verify what a web page really returns

Usage:
  seo-notary verify <url> [options]   Check a URL and report findings
  seo-notary rules [--format json]    List the rule catalog
  seo-notary doctor [--format json]   Check Node, config and browser setup
  seo-notary install-browser          Download Chromium for --tier browser
  seo-notary mcp                      Run the MCP server on stdio

verify options:
  --tier http|browser        http (default) checks the raw response; browser also renders the page
  --mode lean|faithful       Browser tier only (default faithful)
  --format text|json         Output format (default text). json prints exactly one JSON document to stdout
  --out <file>               Also write the JSON report to a file
  --fail-on error|warning|info   Lowest severity that fails the run (default error)
  --timeout-ms <n>           Total time budget, ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS} (default 30000)
  --policy local|strict      local (default) allows localhost and private hosts; strict allows public hosts only
  --allow-link-local         local policy only: also allow link-local and cloud-metadata addresses
  --check-robots-txt         Also check that /robots.txt responds
  --screenshot               Browser tier: include a byte-capped PNG (base64) in the JSON report

Exit codes: 0 pass, 1 findings at or above --fail-on, 2 operational error (bad input, network, timeout, policy, browser).
Diagnostics go to stderr.
`;

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new UsageError(`--${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function errorJson(err: NotaryError | UsageError): string {
  const code = err instanceof NotaryError ? err.code : "INVALID_INPUT";
  return `${JSON.stringify({ schema_version: "0.1.0", error: { code, message: err.message } }, null, 2)}\n`;
}

async function cmdVerify(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      tier: { type: "string" },
      mode: { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      "fail-on": { type: "string" },
      "timeout-ms": { type: "string" },
      policy: { type: "string" },
      "check-robots-txt": { type: "boolean" },
      "allow-link-local": { type: "boolean" },
      screenshot: { type: "boolean" },
    },
  });
  if (positionals.length !== 1 || !positionals[0]) throw new UsageError("verify needs exactly one <url>");
  const format = oneOf("format", values.format, ["text", "json"] as const) ?? "text";
  let timeoutMs: number | undefined;
  if (values["timeout-ms"] !== undefined) {
    timeoutMs = Number(values["timeout-ms"]);
    if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
      throw new UsageError(`--timeout-ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
    }
  }
  const opts: VerifyOptions = {
    url: positionals[0],
    tier: oneOf("tier", values.tier, ["http", "browser"] as const),
    mode: oneOf("mode", values.mode, ["lean", "faithful"] as const),
    failOn: oneOf("fail-on", values["fail-on"], ["error", "warning", "info"] as const),
    policy: oneOf("policy", values.policy, ["local", "strict"] as const),
    timeoutMs,
    checkRobotsTxt: values["check-robots-txt"],
    allowLinkLocal: values["allow-link-local"],
    screenshot: values.screenshot,
  };

  const browser = new LazyBrowser();
  let report: Report;
  try {
    report = await verifyOnce(opts, browser);
  } catch (err) {
    if (err instanceof NotaryError) {
      if (format === "json") io.out(errorJson(err));
      io.err(`error: ${err.code}: ${err.message}\n`);
      return EXIT_ERROR;
    }
    throw err;
  } finally {
    await browser.close();
  }

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) {
    try {
      const file = resolve(values.out);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, json, "utf8");
    } catch (err) {
      io.err(`error: could not write ${values.out}: ${(err as NodeJS.ErrnoException).code ?? "unknown error"}\n`);
      return EXIT_ERROR;
    }
  }
  io.out(format === "json" ? json : formatReport(report, palette(io.color)));
  return report.status === "fail" ? EXIT_FAIL : EXIT_OK;
}

function cmdRules(args: string[], io: CliIo): number {
  const { values } = parseArgs({ args, strict: true, options: { format: { type: "string" } } });
  const format = oneOf("format", values.format, ["text", "json"] as const) ?? "text";
  io.out(format === "json" ? `${JSON.stringify({ rules: RULE_CATALOG }, null, 2)}\n` : formatRules(RULE_CATALOG, palette(io.color)));
  return EXIT_OK;
}

interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}

function nodeSupported(version: string): boolean {
  const parts = version.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < MIN_NODE.length; i++) {
    const have = parts[i] ?? 0;
    if (have !== MIN_NODE[i]) return have > MIN_NODE[i]!;
  }
  return true;
}

async function cmdDoctor(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args, strict: true, options: { format: { type: "string" } } });
  const format = oneOf("format", values.format, ["text", "json"] as const) ?? "text";
  const checks: Check[] = [];
  const nodeOk = nodeSupported(process.version);
  checks.push({
    name: "Node.js",
    status: nodeOk ? "ok" : "fail",
    detail: process.version,
    ...(nodeOk ? {} : { fix: `Install Node ${MIN_NODE.join(".")} or newer.` }),
  });
  checks.push({ name: "seo-notary", status: "ok", detail: `${VERSION}, default policy: local, ${RULE_CATALOG.length} rules` });
  try {
    const mod = await import("seo-notary-browser");
    const st = await mod.browserStatus();
    checks.push({
      name: "Browser (Chromium)",
      status: st.usable ? "ok" : "warn",
      detail: st.usable
        ? `Playwright ${st.playwrightVersion}, browser ${st.browserVersion ?? "unknown"}${st.detail ? ` (${st.detail})` : ""}`
        : st.problem === "not-installed"
          ? `Playwright ${st.playwrightVersion}, Chromium not installed`
          : `Playwright ${st.playwrightVersion}, Chromium cannot start: ${st.detail ?? "unknown error"}`,
      ...(st.usable
        ? {}
        : {
            fix:
              st.problem === "not-installed"
                ? "Run: npx seo-notary install-browser (only needed for --tier browser)"
                : "Install the OS libraries Chromium needs, for example: sudo npx playwright-core install-deps chromium",
          }),
    });
  } catch {
    checks.push({ name: "Browser (Chromium)", status: "warn", detail: "seo-notary-browser could not be loaded", fix: "Reinstall seo-notary." });
  }
  const failed = checks.some((c) => c.status === "fail");
  if (format === "json") {
    io.out(`${JSON.stringify({ ok: !failed, checks }, null, 2)}\n`);
  } else {
    const p: Palette = palette(io.color);
    const mark = (s: Check["status"]) => (s === "ok" ? p.green("ok  ") : s === "warn" ? p.yellow("warn") : p.red("FAIL"));
    io.out(`${checks.map((c) => `${mark(c.status)} ${c.name}: ${c.detail}${c.fix ? `\n     ${c.fix}` : ""}`).join("\n")}\n`);
  }
  return failed ? EXIT_ERROR : EXIT_OK;
}

async function cmdInstallBrowser(io: CliIo): Promise<number> {
  try {
    const { installBrowser } = await import("seo-notary-browser");
    const code = await installBrowser({ stdio: "inherit" });
    if (code !== 0) io.err(`error: browser install exited with code ${code}\n`);
    return code === 0 ? EXIT_OK : EXIT_ERROR;
  } catch (err) {
    io.err(`error: could not run the browser installer: ${(err as Error).message}\n`);
    return EXIT_ERROR;
  }
}

/** Runs the CLI and returns the process exit code. Never throws for user errors. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
      (cmd === undefined ? io.err : io.out)(HELP);
      return cmd === undefined ? EXIT_ERROR : EXIT_OK;
    }
    if (cmd === "--version" || cmd === "-v" || cmd === "version") {
      io.out(`${VERSION}\n`);
      return EXIT_OK;
    }
    switch (cmd) {
      case "verify": return await cmdVerify(rest, io);
      case "rules": return cmdRules(rest, io);
      case "doctor": return await cmdDoctor(rest, io);
      case "install-browser": return await cmdInstallBrowser(io);
      case "mcp":
        await runMcpServer(VERSION);
        return EXIT_OK;
      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (err) {
    if (err instanceof UsageError || (err as NodeJS.ErrnoException | undefined)?.code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(`error: ${(err as Error).message}\nRun "seo-notary --help" for usage.\n`);
      return EXIT_ERROR;
    }
    io.err(`error: unexpected failure: ${(err as Error).message}\n`);
    return EXIT_ERROR;
  }
}
