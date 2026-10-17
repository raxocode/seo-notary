import { DEFAULT_LIMITS, SCHEMA_VERSION, type Limits } from "./constants.js";
import { BROWSER_RULES, type BrowserCollector, type BrowserRuleContext } from "./browser.js";
import { RULE_IDS } from "./catalog.js";
import { NotaryError } from "./errors.js";
import { fetchPage, type FetchedResponse, type FetchInternals } from "./fetcher.js";
import { decodeBody, parseHtml, parseXRobotsTag, type ParsedHtml } from "./html.js";
import type { PolicyOptions } from "./policy.js";
import { redactUrl, sanitizeText } from "./sanitize.js";
import {
  ReportSchema,
  RequestSchema,
  SEVERITY_RANK,
  type Finding,
  type RawHttpSnapshot,
  type RenderedDomSnapshot,
  type Report,
  type Severity,
  type VerifyRequest,
} from "./schemas.js";
import { RULES, snapshotCanonical, type FindingDraft, type RobotsTxtResult, type RuleContext } from "./rules.js";
import { VERSION, userAgent } from "./version.js";

export interface Runner {
  verify(request: unknown): Promise<Report>;
  close(): Promise<void>;
}

export interface LocalRunnerOptions {
  limits?: Partial<Limits>;
  /** local profile only; mirrors the CLI's --allow-link-local. */
  allowLinkLocal?: boolean;
  /** strict profile only; defaults to 80 and 443. */
  allowedPorts?: readonly number[];
  /** Test-only seams (see FetchInternals). */
  internals?: FetchInternals;
  /** Required for tier "browser" (provided by seo-notary-browser). The creator closes it. */
  browser?: BrowserCollector;
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const ROBOTS_TXT_MAX_REDIRECTS = 3;

function mediaType(contentType: string | null): string | null {
  return contentType ? (contentType.split(";")[0] ?? "").trim().toLowerCase() : null;
}

function looksLikeHtml(body: Uint8Array): boolean {
  const head = new TextDecoder("latin1").decode(body.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function bounded(s: string | null | undefined, max = 400): string | null {
  return s ? sanitizeText(s, max) : null;
}

function parseRequest(input: unknown): VerifyRequest {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "request"}: ${i.message}`);
    throw new NotaryError("INVALID_INPUT", `invalid request: ${issues.join("; ")}`);
  }
  const req = parsed.data;
  const unknown = (req.rules ?? []).filter((id) => !RULE_IDS.includes(id));
  if (unknown.length > 0) throw new NotaryError("INVALID_INPUT", `unknown rule id(s): ${unknown.slice(0, 5).join(", ")}`);
  return req;
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0) ||
      ((a.location ?? "") < (b.location ?? "") ? -1 : (a.location ?? "") > (b.location ?? "") ? 1 : 0),
  );
}

export class LocalRunner implements Runner {
  private readonly limits: Limits;
  private readonly controller = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly options: LocalRunnerOptions = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  async verify(input: unknown): Promise<Report> {
    if (this.closed) throw new NotaryError("INVALID_INPUT", "runner is closed");
    const work = this.run(input);
    this.inflight.add(work);
    try {
      return await work;
    } finally {
      this.inflight.delete(work);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort(new Error("runner closed"));
    await Promise.allSettled([...this.inflight]);
  }

  private async run(input: unknown): Promise<Report> {
    const req = parseRequest(input);
    const collector = this.options.browser;
    if (req.tier === "browser" && !collector) {
      throw new NotaryError("BROWSER_UNAVAILABLE", "no browser is configured; install seo-notary-browser and run `seo-notary install-browser`");
    }
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const policy: PolicyOptions = { profile: req.policy, allowLinkLocal: this.options.allowLinkLocal, allowedPorts: this.options.allowedPorts };
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.limits.totalTimeoutMs)]);
    const base = { policy, limits: this.limits, userAgent: userAgent(VERSION), signal, internals: this.options.internals };

    const res = await this.guard(() => fetchPage(req.target_url, { ...base, maxBodyBytes: this.limits.maxResponseBytes, maxRedirects: this.limits.maxRedirects }));

    const robotsTxt = req.check_robots_txt ? await this.fetchRobots(res, base) : null;
    const ctx = this.buildContext(res, robotsTxt);
    let rendered: RenderedDomSnapshot | null = null;
    if (req.tier === "browser" && collector) {
      rendered = await this.guard(() =>
        collector.collect({
          url: req.target_url,
          mode: req.mode ?? "faithful",
          policy,
          limits: this.limits,
          signal,
          includeScreenshot: req.include_screenshot,
          internals: this.options.internals,
        }),
      );
    }
    return this.buildReport(req, res, ctx, rendered, started, startedAt);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NotaryError) throw err;
      throw new NotaryError("INTERNAL_ERROR", "unexpected error while fetching", { cause: err });
    }
  }

  private async fetchRobots(res: FetchedResponse, base: Omit<Parameters<typeof fetchPage>[1], "maxBodyBytes" | "maxRedirects">): Promise<RobotsTxtResult> {
    try {
      const r = await fetchPage(new URL("/robots.txt", res.url.origin).href, {
        ...base,
        maxBodyBytes: this.limits.maxRobotsTxtBytes,
        maxRedirects: ROBOTS_TXT_MAX_REDIRECTS,
        initialSawPublic: res.sawPublic,
      });
      return { status: r.status };
    } catch (err) {
      // Policy and shutdown still abort the whole run; other failures are an informational finding.
      if (err instanceof NotaryError && (err.code === "POLICY_BLOCKED" || this.controller.signal.aborted)) throw err;
      return { status: null, error: err instanceof NotaryError ? err.code : "UNKNOWN" };
    }
  }

  private buildContext(res: FetchedResponse, robotsTxt: RobotsTxtResult | null): RuleContext {
    const contentType = res.headers["content-type"]?.[0] ?? null;
    const type = mediaType(contentType);
    const isHtml = type ? HTML_TYPES.has(type) : looksLikeHtml(res.body);
    let html: ParsedHtml | null = null;
    if (isHtml) html = parseHtml(decodeBody(res.body, contentType));
    const header = parseXRobotsTag(res.headers["x-robots-tag"] ?? []);
    const meta = html?.metaRobots ?? [];
    return {
      status: res.status,
      finalUrl: res.url,
      contentType,
      isHtml,
      html,
      redirects: res.redirects,
      robotsDirectives: [...new Set([...header, ...meta])].sort(),
      robotsSource: { header, meta },
      robotsTxt,
      limits: this.limits,
    };
  }

  private buildReport(
    req: VerifyRequest,
    res: FetchedResponse,
    ctx: RuleContext,
    rendered: RenderedDomSnapshot | null,
    started: number,
    startedAt: string,
  ): Report {
    const allow = req.rules ? new Set(req.rules) : null;
    const findings: Finding[] = [];
    let executed = 0;
    let withFindings = 0;
    const emit = (rule: { id: string; category: string; defaultSeverity: Severity }, drafts: FindingDraft[]): void => {
      executed++;
      if (drafts.length > 0) withFindings++;
      for (const d of drafts) {
        findings.push({
          rule_id: rule.id,
          severity: d.severity ?? rule.defaultSeverity,
          category: rule.category,
          message: sanitizeText(d.message, this.limits.maxEvidenceChars),
          ...(d.location ? { location: sanitizeText(d.location, 200) } : {}),
          ...(d.evidence
            ? {
                evidence: {
                  ...(d.evidence.raw !== undefined ? { raw: sanitizeText(d.evidence.raw, this.limits.maxEvidenceChars) } : {}),
                  ...(d.evidence.rendered !== undefined ? { rendered: sanitizeText(d.evidence.rendered, this.limits.maxEvidenceChars) } : {}),
                },
              }
            : {}),
          ...(d.remediation ? { remediation: sanitizeText(d.remediation, this.limits.maxEvidenceChars) } : {}),
        });
      }
    };
    for (const rule of RULES) {
      if (allow && !allow.has(rule.id)) continue;
      if (rule.requires === "html" && !ctx.isHtml) continue;
      if (rule.requires === "robots_txt" && ctx.robotsTxt === null) continue;
      emit(rule, rule.run(ctx));
    }
    if (rendered) {
      const bctx: BrowserRuleContext = {
        raw: {
          title: bounded(ctx.html?.title),
          metaDescription: bounded(ctx.html?.metaDescription),
          canonical: bounded(ctx.html ? snapshotCanonical(ctx) : null, 2100),
          metaRobots: ctx.robotsSource.meta.map((d) => sanitizeText(d, 100)),
        },
        rendered,
        limits: this.limits,
      };
      for (const rule of BROWSER_RULES) {
        if (allow && !allow.has(rule.id)) continue;
        emit(rule, rule.run(bctx));
      }
    }
    const sorted = sortFindings(findings);
    const count = (s: Severity) => sorted.filter((f) => f.severity === s).length;
    const threshold = SEVERITY_RANK[req.fail_on];
    const failed = sorted.some((f) => SEVERITY_RANK[f.severity] <= threshold);

    const raw: RawHttpSnapshot = {
      status: res.status,
      final_url: res.url.href.slice(0, 2100),
      content_type: bounded(ctx.contentType, 200),
      title: bounded(ctx.html?.title),
      meta_description: bounded(ctx.html?.metaDescription),
      canonical: bounded(ctx.html ? snapshotCanonical(ctx) : null, 2100),
      robots_directives: ctx.robotsDirectives.slice(0, 50).map((d) => sanitizeText(d, 100)),
      word_count: ctx.html ? ctx.html.wordCount : null,
      redirect_chain: res.redirects.slice(0, 20).map((r) => ({ url: redactUrl(r.url), status: r.status })),
    };

    return ReportSchema.parse({
      schema_version: SCHEMA_VERSION,
      target_url: req.target_url.slice(0, 2100),
      status: failed ? "fail" : "pass",
      execution: {
        tier: req.tier,
        mode: rendered ? (req.mode ?? "faithful") : null,
        runner: "local",
        duration_ms: Date.now() - started,
        redirects_followed: res.redirects.length,
        started_at: startedAt,
      },
      summary: { passed: executed - withFindings, failed: count("error"), warnings: count("warning"), info: count("info") },
      snapshots: { raw_http: raw, rendered_dom: rendered },
      findings: sorted,
    });
  }
}
