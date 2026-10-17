import type { Limits } from "./constants.js";
import { isNoindex, type ParsedHtml } from "./html.js";
import { redactUrl } from "./sanitize.js";
import type { Evidence, Severity } from "./schemas.js";

export interface RobotsTxtResult {
  /** HTTP status of /robots.txt, or null when no response was received. */
  status: number | null;
  error?: string;
}

export interface RuleContext {
  status: number;
  finalUrl: URL;
  contentType: string | null;
  isHtml: boolean;
  html: ParsedHtml | null;
  redirects: { url: string; status: number }[];
  /** Meta robots plus X-Robots-Tag tokens. */
  robotsDirectives: string[];
  robotsSource: { header: string[]; meta: string[] };
  robotsTxt: RobotsTxtResult | null;
  limits: Limits;
}

export interface FindingDraft {
  severity?: Severity;
  message: string;
  location?: string;
  evidence?: Evidence;
  remediation?: string;
}

export type RuleRequirement = "response" | "html" | "robots_txt";

export interface RuleDefinition {
  id: string;
  category: string;
  defaultSeverity: Severity;
  tier: "http";
  requires: RuleRequirement;
  description: string;
  /** What a finding from this rule does not prove. */
  limitation: string;
  run(ctx: RuleContext): FindingDraft[];
}

export interface ResolvedCanonical {
  raw: string | null;
  url: URL | null;
}

function documentBase(ctx: RuleContext): URL {
  const href = ctx.html?.baseHref;
  if (href) {
    try {
      const u = new URL(href, ctx.finalUrl);
      if (u.protocol === "http:" || u.protocol === "https:") return u;
    } catch {
      /* fall through to the final URL */
    }
  }
  return ctx.finalUrl;
}

export function resolveCanonicals(ctx: RuleContext): ResolvedCanonical[] {
  const base = documentBase(ctx);
  return (ctx.html?.canonicals ?? []).map(({ href }) => {
    if (href === null || href === "") return { raw: href, url: null };
    try {
      const u = new URL(href, base);
      return { raw: href, url: u.protocol === "http:" || u.protocol === "https:" ? u : null };
    } catch {
      return { raw: href, url: null };
    }
  });
}

const noHash = (u: URL): string => u.href.split("#")[0] ?? u.href;
const canonicalKey = (c: ResolvedCanonical): string => (c.url ? noHash(c.url) : `invalid:${c.raw ?? ""}`);

function firstValidCanonical(ctx: RuleContext): URL | null {
  return resolveCanonicals(ctx).find((c) => c.url !== null)?.url ?? null;
}

export function snapshotCanonical(ctx: RuleContext): string | null {
  const all = resolveCanonicals(ctx);
  const first = all.find((c) => c.url !== null);
  if (first?.url) return first.url.href;
  return all[0]?.raw || null;
}

function statusFinding(status: number): FindingDraft | null {
  if (status >= 200 && status < 300) return null;
  const evidence = { raw: `HTTP ${status}` };
  if (status === 401 || status === 403) {
    return {
      severity: "warning",
      message: `Server answered ${status}. No credentials are sent, so the page may be access-controlled.`,
      evidence,
      remediation: "Verify a publicly reachable URL, or confirm the page is meant to require authentication.",
    };
  }
  if (status >= 300 && status < 400) {
    return { severity: "warning", message: `Final response is a ${status} redirect without a usable Location header.`, evidence };
  }
  return {
    severity: "error",
    message: `Final response status is ${status}.`,
    evidence,
    remediation: status === 404 || status === 410 ? "Check the route exists and the URL is correct." : "Check the server logs for the failing route.",
  };
}

export const RULES: readonly RuleDefinition[] = [
  {
    id: "HTTP_STATUS",
    category: "http",
    defaultSeverity: "error",
    tier: "http",
    requires: "response",
    description: "Final HTTP status of the page. 5xx/404/410/other 4xx are errors; 401/403 are warnings.",
    limitation: "Describes only the response received by this client without credentials.",
    run: (ctx) => {
      const f = statusFinding(ctx.status);
      return f ? [f] : [];
    },
  },
  {
    id: "HTTP_REDIRECT_CHAIN",
    category: "redirect",
    defaultSeverity: "warning",
    tier: "http",
    requires: "response",
    description: "Number of redirects followed before the final response: 2 is info, 3 or more is a warning.",
    limitation: "A single redirect is not reported. Query values are redacted in evidence.",
    run: (ctx) => {
      const n = ctx.redirects.length;
      if (n < 2) return [];
      const chain = ctx.redirects.map((r) => `${r.status} ${redactUrl(r.url, 80)}`).join(" -> ");
      return [
        {
          severity: n >= 3 ? "warning" : "info",
          message: `${n} redirects were followed before the final response.`,
          evidence: { raw: chain },
          remediation: "Link directly to the final URL where possible.",
        },
      ];
    },
  },
  {
    id: "NON_HTML_CONTENT",
    category: "content",
    defaultSeverity: "info",
    tier: "http",
    requires: "response",
    description: "Response is not HTML, so HTML rules were skipped. HTTP facts are still reported.",
    limitation: "Content type comes from the Content-Type header (or a short sniff when it is absent).",
    run: (ctx) =>
      ctx.isHtml ? [] : [{ message: "Response is not HTML; HTML rules were skipped.", evidence: { raw: ctx.contentType ?? "no content-type" } }],
  },
  {
    id: "HTML_TITLE_MISSING",
    category: "metadata",
    defaultSeverity: "error",
    tier: "http",
    requires: "html",
    description: "No <title> element, or its text is empty or whitespace-only.",
    limitation: "Checks the raw HTML only; a script may add a title later (use the browser tier).",
    run: (ctx) =>
      ctx.html?.title ? [] : [{ message: "The page has no title in the raw HTML.", location: "head > title", remediation: "Add a non-empty <title> to the document head." }],
  },
  {
    id: "HTML_TITLE_LENGTH",
    category: "metadata",
    defaultSeverity: "info",
    tier: "http",
    requires: "html",
    description: "Title is shorter or longer than advisory bounds (10 and 70 characters by default).",
    limitation: "Advisory heuristic only; makes no claim about how any search engine truncates titles.",
    run: (ctx) => {
      const title = ctx.html?.title;
      if (!title) return [];
      const len = [...title].length;
      if (len >= ctx.limits.titleMinChars && len <= ctx.limits.titleMaxChars) return [];
      return [
        {
          message: `Title is ${len} characters (advisory range ${ctx.limits.titleMinChars}-${ctx.limits.titleMaxChars}).`,
          location: "head > title",
          evidence: { raw: title },
        },
      ];
    },
  },
  {
    id: "META_DESCRIPTION_MISSING",
    category: "metadata",
    defaultSeverity: "warning",
    tier: "http",
    requires: "html",
    description: 'No <meta name="description"> with non-empty content.',
    limitation: "Raw HTML only.",
    run: (ctx) =>
      ctx.html?.metaDescription ? [] : [{ message: "The page has no meta description in the raw HTML.", location: 'meta[name="description"]', remediation: "Add a meta description that summarises the page." }],
  },
  {
    id: "CANONICAL_MISSING",
    category: "canonical",
    defaultSeverity: "warning",
    tier: "http",
    requires: "html",
    description: 'No <link rel="canonical"> in the raw HTML.',
    limitation: "A canonical link is not mandatory on every page.",
    run: (ctx) =>
      (ctx.html?.canonicals.length ?? 0) > 0 ? [] : [{ message: "No canonical link was found in the raw HTML.", location: 'link[rel="canonical"]' }],
  },
  {
    id: "CANONICAL_MULTIPLE",
    category: "canonical",
    defaultSeverity: "error",
    tier: "http",
    requires: "html",
    description: "Multiple canonical links whose resolved targets differ.",
    limitation: "Identical duplicates are not reported.",
    run: (ctx) => {
      const all = resolveCanonicals(ctx);
      const keys = new Set(all.map(canonicalKey));
      if (all.length < 2 || keys.size < 2) return [];
      return [
        {
          message: `${all.length} canonical links point to ${keys.size} different targets.`,
          location: 'link[rel="canonical"]',
          evidence: { raw: [...keys].join(" | ") },
          remediation: "Keep exactly one canonical link per page.",
        },
      ];
    },
  },
  {
    id: "CANONICAL_INVALID",
    category: "canonical",
    defaultSeverity: "error",
    tier: "http",
    requires: "html",
    description: "Canonical href is missing, empty, malformed, or not http(s).",
    limitation: "Resolved against <base href> when present, else the final URL.",
    run: (ctx) =>
      resolveCanonicals(ctx)
        .filter((c) => c.url === null)
        .slice(0, ctx.limits.maxFindingsPerRule)
        .map((c) => ({
          message: "Canonical link has an invalid href.",
          location: 'link[rel="canonical"]',
          evidence: { raw: c.raw ?? "(no href attribute)" },
          remediation: "Use an absolute http(s) URL.",
        })),
  },
  {
    id: "CANONICAL_CROSS_ORIGIN",
    category: "canonical",
    defaultSeverity: "warning",
    tier: "http",
    requires: "html",
    description: "Canonical points to a different origin than the final URL.",
    limitation: "May be intentional (syndication, domain migration).",
    run: (ctx) => {
      const c = firstValidCanonical(ctx);
      if (!c || c.origin === ctx.finalUrl.origin) return [];
      return [{ message: "Canonical points to a different origin.", location: 'link[rel="canonical"]', evidence: { raw: `${c.href} (page: ${ctx.finalUrl.origin})` } }];
    },
  },
  {
    id: "CANONICAL_MISMATCH",
    category: "canonical",
    defaultSeverity: "info",
    tier: "http",
    requires: "html",
    description: "Same-origin canonical differs from the final URL (fragment ignored).",
    limitation: "Often legitimate (tracking parameters, trailing slash). Cross-origin canonicals are reported by CANONICAL_CROSS_ORIGIN instead.",
    run: (ctx) => {
      const c = firstValidCanonical(ctx);
      if (!c || c.origin !== ctx.finalUrl.origin || noHash(c) === noHash(ctx.finalUrl)) return [];
      return [{ message: "Canonical differs from the final URL.", location: 'link[rel="canonical"]', evidence: { raw: `canonical ${noHash(c)} vs page ${noHash(ctx.finalUrl)}` } }];
    },
  },
  {
    id: "ROBOTS_NOINDEX",
    category: "indexing",
    defaultSeverity: "warning",
    tier: "http",
    requires: "response",
    description: "A noindex or none directive in meta robots or the X-Robots-Tag header.",
    limitation: "Does not prove the page is or is not indexed.",
    run: (ctx) => {
      const header = isNoindex(ctx.robotsSource.header);
      const meta = isNoindex(ctx.robotsSource.meta);
      const out: FindingDraft[] = [];
      if (header) out.push({ message: "X-Robots-Tag header contains a noindex directive.", location: "header:x-robots-tag", evidence: { raw: header } });
      if (meta) out.push({ message: "Meta robots contains a noindex directive.", location: 'meta[name="robots"]', evidence: { raw: meta } });
      return out;
    },
  },
  {
    id: "JSON_LD_INVALID",
    category: "structured-data",
    defaultSeverity: "error",
    tier: "http",
    requires: "html",
    description: "A JSON-LD script block that is empty or is not valid JSON.",
    limitation: "JSON syntax only; no schema.org semantic validation.",
    run: (ctx) => {
      const out: FindingDraft[] = [];
      (ctx.html?.jsonLd ?? []).forEach((text, i) => {
        if (out.length >= ctx.limits.maxFindingsPerRule) return;
        const location = `script[type="application/ld+json"][${i}]`;
        if (text.trim() === "") {
          out.push({ message: "JSON-LD block is empty.", location });
          return;
        }
        try {
          JSON.parse(text);
        } catch (err) {
          out.push({ message: "JSON-LD block is not valid JSON.", location, evidence: { raw: (err as Error).message } });
        }
      });
      return out;
    },
  },
  {
    id: "ROBOTS_TXT_UNAVAILABLE",
    category: "robots-txt",
    defaultSeverity: "info",
    tier: "http",
    requires: "robots_txt",
    description: "Only with check_robots_txt: /robots.txt on the same origin did not return a 2xx response.",
    limitation: "A missing robots.txt is legal. The file content is not evaluated.",
    run: (ctx) => {
      const r = ctx.robotsTxt;
      if (!r || (r.status !== null && r.status >= 200 && r.status < 300)) return [];
      return [{ message: r.status === null ? "robots.txt could not be fetched." : `robots.txt returned ${r.status}.`, location: "/robots.txt", evidence: { raw: r.status === null ? (r.error ?? "no response") : `HTTP ${r.status}` } }];
    },
  },
];

export const RULE_IDS: readonly string[] = RULES.map((r) => r.id);
