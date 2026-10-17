import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from "playwright-core";
import {
  NotaryError,
  RenderedDomSnapshotSchema,
  admitUrl,
  defaultResolve,
  redactUrl,
  sanitizeText,
  type BrowserCollectInput,
  type BrowserCollector,
  type PolicyState,
  type RenderedDomSnapshot,
  type ResolvedAddress,
} from "seo-notary-core";
import { SNAPSHOT_SCRIPT } from "./snapshot-script.js";

export interface BrowserManagerOptions {
  /** Recycle the browser process after this many jobs (drain, then replace). Default 50. */
  maxJobsPerBrowser?: number;
  /** Max time to wait for context/browser close before the browser is considered unhealthy. Default 3000. */
  closeTimeoutMs?: number;
  /** Test-only: extra Chromium launch arguments. Not reachable from requests, the CLI or MCP. */
  internals?: { launchArgs?: string[] };
}

interface Slot {
  browser: Browser;
  jobs: number;
  active: number;
  retiring: boolean;
  dead: boolean;
  closed: boolean;
}

export interface BrowserStats {
  launches: number;
  jobs: number;
  recycles: number;
  openContexts: number;
}

const LEAN_BLOCKED = new Set(["image", "media", "font"]);
const USER_AGENT = "Mozilla/5.0 (compatible; SEO-Notary; +https://seonotary.com)";
const MISSING_EXECUTABLE = /executable doesn't exist|looks like playwright.*was just installed/i;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Rejects when the signal aborts, so a wedged page cannot outlive the job deadline. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as unknown);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason as unknown);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([p, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return raceAbort(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

const str = (v: unknown, max: number): string | null => {
  const s = typeof v === "string" ? sanitizeText(v, max) : "";
  return s === "" ? null : s;
};

interface JobState {
  blockedMain: string | null;
  slotDead: boolean;
}

function isMainNavigation(request: Request, page: Page): boolean {
  if (!request.isNavigationRequest()) return false;
  try {
    return request.frame() === page.mainFrame();
  } catch {
    // The first navigation is issued before its frame exists; sub-frame navigations always have a frame.
    return true;
  }
}

export class BrowserManager implements BrowserCollector {
  readonly stats: BrowserStats = { launches: 0, jobs: 0, recycles: 0, openContexts: 0 };
  private current: Slot | null = null;
  private launching: Promise<Slot> | null = null;
  private readonly all = new Set<Slot>();
  private closed = false;
  private readonly maxJobs: number;
  private readonly closeTimeoutMs: number;

  constructor(private readonly options: BrowserManagerOptions = {}) {
    this.maxJobs = Math.max(1, options.maxJobsPerBrowser ?? 50);
    this.closeTimeoutMs = options.closeTimeoutMs ?? 3000;
  }

  async collect(input: BrowserCollectInput): Promise<RenderedDomSnapshot> {
    if (this.closed) throw new NotaryError("INVALID_INPUT", "browser manager is closed");
    const slot = await this.acquire();
    this.stats.jobs++;
    try {
      return await this.runJob(slot, input);
    } finally {
      slot.active--;
      await this.settleSlot(slot);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.current = null;
    await Promise.all([...this.all].map((s) => this.closeSlot(s)));
  }

  private async acquire(): Promise<Slot> {
    for (;;) {
      if (this.closed) throw new NotaryError("INVALID_INPUT", "browser manager is closed");
      const slot = this.current;
      if (slot && !slot.dead && !slot.retiring && slot.jobs < this.maxJobs) {
        slot.jobs++;
        slot.active++;
        return slot;
      }
      if (slot) {
        this.retire(slot);
        await this.settleSlot(slot);
      }
      if (!this.current) {
        this.launching ??= this.launch().finally(() => {
          this.launching = null;
        });
        this.current = await this.launching;
      }
    }
  }

  private retire(slot: Slot): void {
    if (!slot.retiring) {
      slot.retiring = true;
      this.stats.recycles++;
    }
    if (this.current === slot) this.current = null;
  }

  /** Closes a retiring or dead slot once no job is using it. */
  private async settleSlot(slot: Slot): Promise<void> {
    if ((slot.retiring || slot.dead) && slot.active === 0) await this.closeSlot(slot);
  }

  private async closeSlot(slot: Slot): Promise<void> {
    if (slot.closed) return;
    slot.closed = true;
    await withTimeout(slot.browser.close(), this.closeTimeoutMs).catch(() => undefined);
    this.all.delete(slot);
  }

  private async launch(): Promise<Slot> {
    const args = this.options.internals?.launchArgs;
    const opts = { headless: true, ...(args ? { args } : {}) };
    let browser: Browser;
    try {
      browser = await chromium.launch(opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!MISSING_EXECUTABLE.test(message)) {
        throw new NotaryError(
          "BROWSER_UNAVAILABLE",
          `the browser failed to start (${sanitizeText(message.split("\n")[0] ?? "", 160)}); run \`seo-notary doctor\``,
          { cause: err },
        );
      }
      try {
        browser = await chromium.launch({ ...opts, channel: "chrome" });
      } catch {
        throw new NotaryError("BROWSER_UNAVAILABLE", "Chromium is not installed; run `seo-notary install-browser`", { cause: err });
      }
    }
    const slot: Slot = { browser, jobs: 0, active: 0, retiring: false, dead: false, closed: false };
    browser.on("disconnected", () => {
      slot.dead = true;
      if (this.current === slot) this.current = null;
    });
    this.all.add(slot);
    this.stats.launches++;
    return slot;
  }

  private async runJob(slot: Slot, input: BrowserCollectInput): Promise<RenderedDomSnapshot> {
    const { limits, signal } = input;
    const startedAt = Date.now();
    const state: JobState = { blockedMain: null, slotDead: false };
    let context: BrowserContext | null = null;
    try {
      context = await raceAbort(
        slot.browser.newContext({
          serviceWorkers: "block",
          userAgent: USER_AGENT,
          viewport: { width: 1280, height: 720 },
          acceptDownloads: false,
          permissions: [],
          locale: "en-US",
        }),
        signal,
      );
      this.stats.openContexts++;
      return await this.collectPage(context, input, state, startedAt);
    } catch (err) {
      if (slot.dead || /has been closed|browser.*closed|connection closed/i.test(String((err as Error)?.message))) {
        slot.dead = true;
        state.slotDead = true;
      }
      throw this.mapError(err, state, signal, limits.navigationTimeoutMs);
    } finally {
      if (context) {
        this.stats.openContexts--;
        try {
          await withTimeout(context.close(), this.closeTimeoutMs);
        } catch {
          // A context that will not close means the page or browser is wedged: replace the process.
          this.retire(slot);
        }
      }
    }
  }

  private async collectPage(
    context: BrowserContext,
    input: BrowserCollectInput,
    state: JobState,
    startedAt: number,
  ): Promise<RenderedDomSnapshot> {
    const { limits, signal, policy, mode } = input;
    const resolveFn = input.internals?.resolve ?? defaultResolve;
    const cache = new Map<string, Promise<ResolvedAddress[]>>();
    const resolve = (host: string) => {
      let hit = cache.get(host);
      if (!hit) {
        hit = resolveFn(host);
        cache.set(host, hit);
      }
      return hit;
    };

    const page = await raceAbort(context.newPage(), signal);
    const navState: PolicyState = { sawPublic: false };
    const leanAborted = new WeakSet<Request>();
    const policyBlocked = new WeakMap<Request, string>();
    const blockedClasses = new Set<string>();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const failed: { url: string; reason: string }[] = [];
    const observed = { console_errors: 0, page_errors: 0, failed_requests: 0 };
    const pending: Promise<unknown>[] = [];

    page.on("request", (req) => {
      if (!req.redirectedFrom()) return;
      const isMain = isMainNavigation(req, page);
      const reqState: PolicyState = isMain ? navState : { sawPublic: navState.sawPublic };
      pending.push(
        admitUrl(req.url(), "redirect", limits.maxUrlLength, policy, reqState, resolve).catch((err: unknown) => {
          if (!(err instanceof NotaryError) || err.code !== "POLICY_BLOCKED") return;
          if (isMain) {
            state.blockedMain ??= err.message;
            void page.close().catch(() => undefined);
          } else {
            observed.failed_requests++;
            if (failed.length < limits.maxFailedRequests) failed.push({ url: redactUrl(req.url()), reason: "redirected to a blocked address" });
          }
        }),
      );
    });

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      observed.console_errors++;
      if (consoleErrors.length < limits.maxConsoleEntries) consoleErrors.push(sanitizeText(msg.text(), 300));
    });
    page.on("pageerror", (err) => {
      observed.page_errors++;
      if (pageErrors.length < limits.maxConsoleEntries) pageErrors.push(sanitizeText(err?.message ?? String(err), 300));
    });
    page.on("requestfailed", (req) => {
      if (leanAborted.has(req)) return;
      observed.failed_requests++;
      if (failed.length < limits.maxFailedRequests) {
        const reason = policyBlocked.has(req) ? "blocked by network policy" : (req.failure()?.errorText ?? "failed");
        failed.push({ url: redactUrl(req.url()), reason: sanitizeText(reason, 150) });
      }
    });

    // Defense in depth: the browser resolves and connects on its own, so this check is best-effort (DNS answers can change).
    // Chromium follows redirects internally, so route() only sees the first hop; later hops are checked after the fact below.
    await context.route("**/*", async (route: Route) => {
      const request = route.request();
      const isMain = isMainNavigation(request, page);
      if (!isMain && mode === "lean" && LEAN_BLOCKED.has(request.resourceType())) {
        blockedClasses.add(request.resourceType());
        leanAborted.add(request);
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      try {
        const reqState: PolicyState = isMain ? navState : { sawPublic: navState.sawPublic };
        await admitUrl(request.url(), "redirect", limits.maxUrlLength, policy, reqState, resolve);
      } catch (err) {
        if (err instanceof NotaryError && err.code === "POLICY_BLOCKED") {
          policyBlocked.set(request, err.message);
          if (isMain) state.blockedMain ??= err.message;
          await route.abort("blockedbyclient").catch(() => undefined);
        } else {
          await route.abort(err instanceof NotaryError && err.code === "DNS_FAILURE" ? "namenotresolved" : "failed").catch(() => undefined);
        }
        return;
      }
      await route.continue().catch(() => undefined);
    });

    const navStart = Date.now();
    const response = await raceAbort(
      page.goto(input.url, { waitUntil: "domcontentloaded", timeout: limits.navigationTimeoutMs }),
      signal,
    );
    const navigationMs = Date.now() - navStart;
    await this.assertNotBlocked(pending, state);

    const settleStart = Date.now();
    await sleep(limits.settleMs, signal);
    const settleMs = Date.now() - settleStart;
    await this.assertNotBlocked(pending, state);

    const dom = (await raceAbort(page.evaluate(SNAPSHOT_SCRIPT), signal)) as Record<string, unknown>;
    const robots = Array.isArray(dom["robots"]) ? (dom["robots"] as unknown[]) : [];
    const notes: string[] = [];

    let screenshot: RenderedDomSnapshot["screenshot"] = null;
    if (input.includeScreenshot) {
      const buf = await raceAbort(page.screenshot({ type: "png", timeout: 5000 }), signal);
      if (buf.length > limits.maxScreenshotBytes) {
        notes.push(`screenshot skipped: ${buf.length} bytes exceeds the ${limits.maxScreenshotBytes} byte cap`);
      } else {
        screenshot = { format: "png", bytes: buf.length, data_base64: buf.toString("base64") };
      }
    }
    if (mode === "lean" && blockedClasses.size > 0) notes.push("lean mode blocked images, media and fonts");

    const words = typeof dom["words"] === "number" && Number.isFinite(dom["words"]) ? Math.max(0, Math.floor(dom["words"])) : 0;
    return RenderedDomSnapshotSchema.parse({
      status: response?.status() ?? null,
      final_url: sanitizeText(page.url(), 2100),
      title: str(dom["title"], 400),
      meta_description: str(dom["description"], 400),
      canonical: str(dom["canonical"], 2100),
      robots_directives: [...new Set(robots.map((r) => str(r, 100)).filter((r): r is string => r !== null))].sort().slice(0, 50),
      word_count: words,
      console_errors: consoleErrors,
      page_errors: pageErrors,
      failed_requests: failed,
      observed,
      timings: { navigation_ms: navigationMs, settle_ms: settleMs, total_ms: Date.now() - startedAt },
      blocked_resource_classes: [...blockedClasses].sort(),
      screenshot,
      notes,
    });
  }

  private async assertNotBlocked(pending: Promise<unknown>[], state: JobState): Promise<void> {
    await Promise.allSettled(pending);
    if (state.blockedMain) throw new NotaryError("POLICY_BLOCKED", state.blockedMain);
  }

  private mapError(err: unknown, state: JobState, signal: AbortSignal, navTimeoutMs: number): NotaryError {
    if (err instanceof NotaryError) return err;
    if (state.blockedMain) return new NotaryError("POLICY_BLOCKED", state.blockedMain, { cause: err });
    const message = err instanceof Error ? err.message : String(err);
    if (signal.aborted) {
      const reason = signal.reason as { name?: string } | undefined;
      return reason?.name === "TimeoutError"
        ? new NotaryError("TIMEOUT", "browser job exceeded its total time limit", { cause: err })
        : new NotaryError("NETWORK_ERROR", "browser job was aborted", { cause: err });
    }
    if ((err as Error | undefined)?.name === "TimeoutError" || /timeout \d+ms exceeded/i.test(message)) {
      return new NotaryError("TIMEOUT", `page did not reach domcontentloaded within ${navTimeoutMs} ms`, { cause: err });
    }
    if (state.slotDead) return new NotaryError("NETWORK_ERROR", "the browser process exited during the job", { cause: err });
    if (/ERR_NAME_NOT_RESOLVED/.test(message)) return new NotaryError("DNS_FAILURE", "DNS lookup failed", { cause: err });
    const net = /net::(ERR_[A-Z_]+)/.exec(message)?.[1];
    if (net) return new NotaryError("NETWORK_ERROR", `navigation failed (${net})`, { cause: err });
    return new NotaryError("INTERNAL_ERROR", "unexpected browser error", { cause: err });
  }
}
