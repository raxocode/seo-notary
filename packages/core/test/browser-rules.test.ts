import { describe, expect, it } from "vitest";
import { BROWSER_RULES, DEFAULT_LIMITS, RULE_CATALOG, RULE_IDS, isHydrationMessage, type RenderedDomSnapshot } from "../src/index.js";

const rendered = (over: Partial<RenderedDomSnapshot> = {}): RenderedDomSnapshot => ({
  status: 200,
  final_url: "https://example.test/",
  title: "Title",
  meta_description: "Desc",
  canonical: "https://example.test/",
  robots_directives: [],
  word_count: 3,
  console_errors: [],
  page_errors: [],
  failed_requests: [],
  observed: { console_errors: 0, page_errors: 0, failed_requests: 0 },
  timings: { navigation_ms: 1, settle_ms: 1, total_ms: 2 },
  blocked_resource_classes: [],
  screenshot: null,
  notes: [],
  ...over,
});
const raw: { title: string | null; metaDescription: string | null; canonical: string | null; metaRobots: string[] } = {
  title: "Title",
  metaDescription: "Desc",
  canonical: "https://example.test/",
  metaRobots: [],
};
const run = (id: string, r: RenderedDomSnapshot, rawOver: Partial<typeof raw> = {}) =>
  BROWSER_RULES.find((x) => x.id === id)!.run({ raw: { ...raw, ...rawOver }, rendered: r, limits: DEFAULT_LIMITS });

describe("browser rules (pure)", () => {
  it("identical raw and rendered produce no render findings", () => {
    for (const id of ["RENDER_TITLE_DIFFERS", "RENDER_TITLE_CLIENT_ONLY", "RENDER_CANONICAL_DIFFERS", "RENDER_ROBOTS_DIFFERS", "RENDER_DESCRIPTION_DIFFERS"]) {
      expect(run(id, rendered()), id).toEqual([]);
    }
  });

  it("title: differing, client-only, and removed", () => {
    expect(run("RENDER_TITLE_DIFFERS", rendered({ title: "Other" }))).toHaveLength(1);
    expect(run("RENDER_TITLE_DIFFERS", rendered({ title: null }))).toHaveLength(1);
    expect(run("RENDER_TITLE_CLIENT_ONLY", rendered(), { title: null })).toHaveLength(1);
    expect(run("RENDER_TITLE_DIFFERS", rendered(), { title: null })).toEqual([]);
  });

  it("robots: added noindex is an error, other differences warn", () => {
    expect(run("RENDER_ROBOTS_DIFFERS", rendered({ robots_directives: ["noindex"] }))[0]?.severity).toBe("error");
    expect(run("RENDER_ROBOTS_DIFFERS", rendered({ robots_directives: ["nofollow"] }))[0]?.severity).toBe("warning");
    expect(run("RENDER_ROBOTS_DIFFERS", rendered({ robots_directives: ["noindex"] }), { metaRobots: ["noindex"] })).toEqual([]);
    expect(run("RENDER_ROBOTS_DIFFERS", rendered({ robots_directives: [] }), { metaRobots: ["noindex"] })[0]?.severity).toBe("warning");
  });

  it("hydration patterns", () => {
    for (const m of [
      "Hydration failed because the initial UI does not match what was rendered on the server.",
      "Warning: Text content did not match. Server: a Client: b",
      "Minified React error #418; visit https://react.dev/errors/418",
      "[Vue warn]: Hydration node mismatch",
      "[svelte] hydration_mismatch",
      "Error: Expected server HTML to contain a matching <div>",
    ]) {
      expect(isHydrationMessage(m), m).toBe(true);
    }
    expect(isHydrationMessage("TypeError: x is not a function")).toBe(false);
  });

  it("hydration messages are not double reported as console or page errors", () => {
    const r = rendered({ console_errors: ["Hydration failed", "other"], page_errors: ["Hydration failed"] });
    expect(run("HYDRATION_ERROR_DETECTED", r)).toHaveLength(2);
    expect(run("BROWSER_CONSOLE_ERROR", r)).toHaveLength(1);
    expect(run("BROWSER_PAGE_ERROR", r)).toHaveLength(0);
  });
});

describe("rule catalog", () => {
  it("lists every rule once, with unique IDs and both tiers", () => {
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
    expect(RULE_CATALOG.filter((r) => r.tier === "http")).toHaveLength(14);
    expect(RULE_CATALOG.filter((r) => r.tier === "browser")).toHaveLength(9);
    for (const r of RULE_CATALOG) expect(r.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});
