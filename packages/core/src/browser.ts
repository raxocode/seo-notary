import type { Limits } from "./constants.js";
import type { FetchInternals } from "./fetcher.js";
import { isNoindex } from "./html.js";
import type { PolicyOptions } from "./policy.js";
import { redactUrl } from "./sanitize.js";
import type { RenderedDomSnapshot, Severity } from "./schemas.js";
import type { FindingDraft } from "./rules.js";

export type BrowserMode = "lean" | "faithful";

export interface BrowserCollectInput {
  url: string;
  mode: BrowserMode;
  policy: PolicyOptions;
  limits: Limits;
  /** Total deadline and runner shutdown. */
  signal: AbortSignal;
  includeScreenshot: boolean;
  internals?: FetchInternals;
}

/** Implemented by seo-notary-browser. The caller that creates a collector is responsible for closing it. */
export interface BrowserCollector {
  collect(input: BrowserCollectInput): Promise<RenderedDomSnapshot>;
  close(): Promise<void>;
}

export interface BrowserRuleContext {
  raw: {
    title: string | null;
    metaDescription: string | null;
    canonical: string | null;
    metaRobots: string[];
  };
  rendered: RenderedDomSnapshot;
  limits: Limits;
}

export interface BrowserRuleDefinition {
  id: string;
  category: string;
  defaultSeverity: Severity;
  tier: "browser";
  requires: "browser";
  description: string;
  limitation: string;
  run(ctx: BrowserRuleContext): FindingDraft[];
}

// Pattern detection on console/page errors; not proof that server and client HTML differ.
const HYDRATION_PATTERNS: readonly RegExp[] = [
  /hydrat(e|ion)/i,
  /minified react error #(418|419|422|423|425)\b/i,
  /text content does not match server-rendered html/i,
  /expected server html to contain/i,
  /did not match\.\s*server:/i,
  /\[svelte\]\s*hydration_mismatch/i,
];

export function isHydrationMessage(message: string): boolean {
  return HYDRATION_PATTERNS.some((p) => p.test(message));
}

const same = (a: string | null, b: string | null): boolean => (a ?? "") === (b ?? "");

function metaTokens(directives: readonly string[]): string[] {
  return [...new Set(directives)].sort();
}

export const BROWSER_RULES: readonly BrowserRuleDefinition[] = [
  {
    id: "RENDER_TITLE_DIFFERS",
    category: "rendering",
    defaultSeverity: "error",
    tier: "browser",
    requires: "browser",
    description: "Raw HTML has a title, but the rendered DOM title is different (for example a client-side overwrite).",
    limitation: "Compares the title after domcontentloaded plus a short settle delay; later changes are not seen.",
    run: ({ raw, rendered }) =>
      raw.title && !same(raw.title, rendered.title)
        ? [
            {
              message: "The title changes after JavaScript runs.",
              location: "head > title",
              evidence: { raw: raw.title, rendered: rendered.title ?? "(empty)" },
              remediation: "Make the server-rendered title and the client-rendered title agree.",
            },
          ]
        : [],
  },
  {
    id: "RENDER_TITLE_CLIENT_ONLY",
    category: "rendering",
    defaultSeverity: "warning",
    tier: "browser",
    requires: "browser",
    description: "Raw HTML has no title, but the rendered DOM has one.",
    limitation: "Clients that do not run JavaScript will not see this title.",
    run: ({ raw, rendered }) =>
      !raw.title && rendered.title
        ? [
            {
              message: "The title only exists after JavaScript runs.",
              location: "head > title",
              evidence: { raw: "(empty)", rendered: rendered.title },
              remediation: "Render the title on the server.",
            },
          ]
        : [],
  },
  {
    id: "RENDER_CANONICAL_DIFFERS",
    category: "rendering",
    defaultSeverity: "error",
    tier: "browser",
    requires: "browser",
    description: "Canonical link differs between raw HTML and the rendered DOM (including added or removed).",
    limitation: "Compares resolved absolute URLs of the first canonical link.",
    run: ({ raw, rendered }) =>
      same(raw.canonical, rendered.canonical)
        ? []
        : [
            {
              message: "The canonical link changes after JavaScript runs.",
              location: 'link[rel="canonical"]',
              evidence: { raw: raw.canonical ?? "(none)", rendered: rendered.canonical ?? "(none)" },
              remediation: "Emit one canonical link on the server and do not rewrite it on the client.",
            },
          ],
  },
  {
    id: "RENDER_ROBOTS_DIFFERS",
    category: "rendering",
    defaultSeverity: "warning",
    tier: "browser",
    requires: "browser",
    description: "Meta robots directives differ between raw HTML and the rendered DOM. Error when the rendered DOM adds noindex.",
    limitation: "X-Robots-Tag headers cannot change client-side and are not part of this comparison.",
    run: ({ raw, rendered }) => {
      const a = metaTokens(raw.metaRobots);
      const b = metaTokens(rendered.robots_directives);
      if (a.join(",") === b.join(",")) return [];
      const added = isNoindex(b) !== null && isNoindex(a) === null;
      return [
        {
          severity: added ? "error" : "warning",
          message: added ? "The rendered DOM adds a noindex directive." : "Meta robots directives change after JavaScript runs.",
          location: 'meta[name="robots"]',
          evidence: { raw: a.join(", ") || "(none)", rendered: b.join(", ") || "(none)" },
        },
      ];
    },
  },
  {
    id: "RENDER_DESCRIPTION_DIFFERS",
    category: "rendering",
    defaultSeverity: "warning",
    tier: "browser",
    requires: "browser",
    description: "Meta description differs between raw HTML and the rendered DOM.",
    limitation: "Compares whitespace-collapsed content of the first description meta tag.",
    run: ({ raw, rendered }) =>
      same(raw.metaDescription, rendered.meta_description)
        ? []
        : [
            {
              message: "The meta description changes after JavaScript runs.",
              location: 'meta[name="description"]',
              evidence: { raw: raw.metaDescription ?? "(none)", rendered: rendered.meta_description ?? "(none)" },
            },
          ],
  },
  {
    id: "HYDRATION_ERROR_DETECTED",
    category: "rendering",
    defaultSeverity: "error",
    tier: "browser",
    requires: "browser",
    description: "A console or page error matches a known framework hydration message (React, Next.js, Vue, Svelte).",
    limitation: "Pattern detection on error text only. It does not prove or measure a server/client markup mismatch.",
    run: ({ rendered, limits }) =>
      [...rendered.page_errors, ...rendered.console_errors]
        .filter(isHydrationMessage)
        .slice(0, limits.maxFindingsPerRule)
        .map((m) => ({ message: "A framework hydration error was reported.", location: "console", evidence: { rendered: m } })),
  },
  {
    id: "BROWSER_PAGE_ERROR",
    category: "browser",
    defaultSeverity: "error",
    tier: "browser",
    requires: "browser",
    description: "Uncaught exception in the page (excluding messages already reported as hydration errors).",
    limitation: "Only errors raised before the snapshot is taken are seen. The list is bounded.",
    run: ({ rendered, limits }) =>
      rendered.page_errors
        .filter((m) => !isHydrationMessage(m))
        .slice(0, limits.maxFindingsPerRule)
        .map((m) => ({ message: "Uncaught exception in the page.", location: "console", evidence: { rendered: m } })),
  },
  {
    id: "BROWSER_CONSOLE_ERROR",
    category: "browser",
    defaultSeverity: "warning",
    tier: "browser",
    requires: "browser",
    description: "console.error output (excluding messages already reported as hydration errors).",
    limitation: "Bounded count; message text is page-controlled and untrusted.",
    run: ({ rendered, limits }) =>
      rendered.console_errors
        .filter((m) => !isHydrationMessage(m))
        .slice(0, limits.maxFindingsPerRule)
        .map((m) => ({ message: "The page logged a console error.", location: "console", evidence: { rendered: m } })),
  },
  {
    id: "BROWSER_REQUEST_FAILED",
    category: "browser",
    defaultSeverity: "warning",
    tier: "browser",
    requires: "browser",
    description: "A subresource request failed or was blocked by the network policy. Query values are redacted.",
    limitation: "In lean mode, requests blocked on purpose (images, media, fonts) are not reported.",
    run: ({ rendered, limits }) =>
      rendered.failed_requests.slice(0, limits.maxFindingsPerRule).map((r) => ({
        message: "A request failed.",
        location: redactUrl(r.url, 200),
        evidence: { rendered: r.reason },
      })),
  },
];
