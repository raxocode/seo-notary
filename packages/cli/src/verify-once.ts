import { DEFAULT_LIMITS, LocalRunner, type BrowserCollector, type Limits, type Report } from "seo-notary-core";

export interface VerifyOptions {
  url: string;
  tier?: "http" | "browser";
  mode?: "lean" | "faithful";
  failOn?: "error" | "warning" | "info";
  timeoutMs?: number;
  policy?: "local" | "strict";
  checkRobotsTxt?: boolean;
  allowLinkLocal?: boolean;
  screenshot?: boolean;
}

export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 120_000;

export function limitsFor(timeoutMs: number | undefined): Partial<Limits> {
  if (timeoutMs === undefined) return {};
  return {
    totalTimeoutMs: timeoutMs,
    hopTimeoutMs: Math.min(DEFAULT_LIMITS.hopTimeoutMs, timeoutMs),
    navigationTimeoutMs: Math.min(DEFAULT_LIMITS.navigationTimeoutMs, timeoutMs),
  };
}

/** One request, one runner; the shared browser collector is owned by the caller. */
export async function verifyOnce(opts: VerifyOptions, browser: BrowserCollector): Promise<Report> {
  const runner = new LocalRunner({ limits: limitsFor(opts.timeoutMs), allowLinkLocal: opts.allowLinkLocal, browser });
  try {
    return await runner.verify({
      target_url: opts.url,
      ...(opts.tier ? { tier: opts.tier } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.failOn ? { fail_on: opts.failOn } : {}),
      ...(opts.policy ? { policy: opts.policy } : {}),
      ...(opts.checkRobotsTxt ? { check_robots_txt: true } : {}),
      ...(opts.screenshot ? { include_screenshot: true } : {}),
    });
  } finally {
    await runner.close();
  }
}
