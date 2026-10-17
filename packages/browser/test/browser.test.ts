import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, LocalRunner, NotaryError, type FetchInternals, type Report } from "seo-notary-core";
import { BrowserManager } from "../src/index.js";
import { startServer, type MockServer } from "../../../tests/helpers/mock-server.js";

const PUBLIC_IP = "1.1.1.1";
const fast = { settleMs: 150 };

let srv: MockServer;
let managers: BrowserManager[] = [];
let runners: LocalRunner[] = [];

const internals: FetchInternals = {
  resolve: async (host) => (host === "public.test" ? [{ address: PUBLIC_IP, family: 4 }] : [{ address: "127.0.0.1", family: 4 }]),
  mapConnectAddress: (a) => (a === PUBLIC_IP ? "127.0.0.1" : a),
};

const page = (head: string, body = "<h1>Hello world</h1><p>some words here</p>") => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const BASE = `<title>Server title here</title><meta name="description" content="Server description."><link rel="canonical" href="CANON">`;

beforeAll(async () => {
  srv = await startServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const send = (body: string, type = "text/html; charset=utf-8", status = 200) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    const base = BASE.replace("CANON", srv.url("/static"));
    switch (p) {
      case "/static": return send(page(base));
      case "/insert-title": return send(page(`<script>document.title = "Client only title";</script>`));
      case "/overwrite":
        return send(page(base + `<script>document.title = "Client title"; document.querySelector('link[rel=canonical]').href = "https://evil.example/x";</script>`));
      case "/insert-canonical": return send(page(`<title>Server title here</title><script>var l=document.createElement('link');l.rel='canonical';l.href='/injected';document.head.appendChild(l);</script>`));
      case "/robots-add": return send(page(base + `<script>var m=document.createElement('meta');m.name='robots';m.content='noindex, nofollow';document.head.appendChild(m);</script>`));
      case "/desc-change": return send(page(base + `<script>document.querySelector('meta[name=description]').content='Changed by JS';</script>`));
      case "/hydration": return send(page(base, `<script>console.error('Warning: Text content did not match. Server: "a" Client: "b"');</script>`));
      case "/pageerror": return send(page(base, `<script>setTimeout(function(){ throw new Error("boom from page"); }, 0);</script>`));
      case "/console": return send(page(base, `<script>console.error("plain console failure");</script>`));
      case "/failed": return send(page(base, `<img src="${url.searchParams.get("dead")}/x.png?token=secret">`));
      case "/redirect": res.writeHead(302, { location: "/static" }); return void res.end();
      case "/hang-doc":
        // Only the browser stalls; the Tier 1 fetch (a different User-Agent) gets the full page.
        if (!String(req.headers["user-agent"]).startsWith("Mozilla")) return send(page(base));
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<html><head><title>partial</title>");
        return;
      case "/hang-sub": return send(page(base, `<script>fetch('/never');</script>`));
      case "/never": return;
      case "/busy": return send(`<html><head><title>x</title></head><body><script>while(true){}</script></body></html>`);
      case "/bigdom": return send(page(base, "<p>" + "word ".repeat(150_000) + "</p>"));
      case "/images": return send(page(base, `<img src="/pic.png"><p>text</p>`));
      case "/pic.png": return send("png", "image/png");
      case "/ansi": return send(page(`<title>ok</title><script>console.error("\\u001b[31mred\\u202e text");</script>`));
      case "/private-sub": return send(page(base, `<img src="http://127.0.0.1:${srv.port}/secret.png">`));
      case "/to-private": res.writeHead(302, { location: `http://127.0.0.1:${srv.port}/secret` }); return void res.end();
      case "/secret.png":
      case "/secret": return send("secret");
      case "/robots.txt": return send("User-agent: *", "text/plain");
      default: return send("nf", "text/plain", 404);
    }
  });
});

afterAll(async () => srv.close());
afterEach(async () => {
  await Promise.all(runners.map((r) => r.close()));
  await Promise.all(managers.map((m) => m.close()));
  runners = [];
  managers = [];
  srv.hits.length = 0;
});

const mgr = (opts: ConstructorParameters<typeof BrowserManager>[0] = {}) => {
  const m = new BrowserManager(opts);
  managers.push(m);
  return m;
};
const verify = (m: BrowserManager, path: string, extra: Record<string, unknown> = {}, limits: Record<string, number> = {}) => {
  const r = new LocalRunner({ browser: m, limits: { ...fast, ...limits } });
  runners.push(r);
  return r.verify({ target_url: srv.url(path), tier: "browser", ...extra });
};
const ids = (r: Report) => r.findings.map((f) => f.rule_id);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "NO_ERROR";
  } catch (e) {
    if (e instanceof NotaryError) return e.code;
    throw e;
  }
};

describe("raw vs rendered", () => {
  it("static page: no RENDER findings, snapshot populated, tier and mode recorded", async () => {
    const r = await verify(mgr(), "/static");
    expect(r.status).toBe("pass");
    expect(ids(r).filter((i) => i.startsWith("RENDER_"))).toEqual([]);
    expect(r.execution).toMatchObject({ tier: "browser", mode: "faithful" });
    expect(r.snapshots.rendered_dom).toMatchObject({
      status: 200,
      title: "Server title here",
      meta_description: "Server description.",
      canonical: srv.url("/static"),
      word_count: 5,
    });
  });

  it("JS inserts a title: RENDER_TITLE_CLIENT_ONLY (warning)", async () => {
    const r = await verify(mgr(), "/insert-title");
    expect(r.findings.find((f) => f.rule_id === "RENDER_TITLE_CLIENT_ONLY")?.severity).toBe("warning");
    expect(r.snapshots.rendered_dom?.title).toBe("Client only title");
    expect(ids(r)).toContain("HTML_TITLE_MISSING");
  });

  it("JS overwrites title and canonical: both recorded, exit-1 report", async () => {
    const r = await verify(mgr(), "/overwrite");
    expect(r.status).toBe("fail");
    const t = r.findings.find((f) => f.rule_id === "RENDER_TITLE_DIFFERS");
    expect(t).toMatchObject({ severity: "error", evidence: { raw: "Server title here", rendered: "Client title" } });
    const c = r.findings.find((f) => f.rule_id === "RENDER_CANONICAL_DIFFERS");
    expect(c?.evidence).toEqual({ raw: srv.url("/static"), rendered: "https://evil.example/x" });
  });

  it("JS inserts a canonical: RENDER_CANONICAL_DIFFERS", async () => {
    const r = await verify(mgr(), "/insert-canonical");
    expect(r.findings.find((f) => f.rule_id === "RENDER_CANONICAL_DIFFERS")?.evidence?.rendered).toBe(srv.url("/injected"));
  });

  it("rendered noindex is an error; changed description is a warning", async () => {
    const m = mgr();
    const robots = await verify(m, "/robots-add");
    expect(robots.findings.find((f) => f.rule_id === "RENDER_ROBOTS_DIFFERS")).toMatchObject({ severity: "error" });
    expect(robots.snapshots.rendered_dom?.robots_directives).toEqual(["nofollow", "noindex"]);
    const desc = await verify(m, "/desc-change");
    expect(desc.findings.find((f) => f.rule_id === "RENDER_DESCRIPTION_DIFFERS")?.severity).toBe("warning");
  });

  it("follows main-frame redirects", async () => {
    const r = await verify(mgr(), "/redirect");
    expect(r.snapshots.rendered_dom?.final_url).toBe(srv.url("/static"));
  });
});

describe("browser diagnostics", () => {
  it("hydration-style console error -> HYDRATION_ERROR_DETECTED, not also BROWSER_CONSOLE_ERROR", async () => {
    const r = await verify(mgr(), "/hydration");
    expect(ids(r)).toContain("HYDRATION_ERROR_DETECTED");
    expect(ids(r)).not.toContain("BROWSER_CONSOLE_ERROR");
    expect(r.status).toBe("fail");
  });

  it("uncaught exception -> BROWSER_PAGE_ERROR; plain console.error -> BROWSER_CONSOLE_ERROR (warning)", async () => {
    const m = mgr();
    const pe = await verify(m, "/pageerror");
    expect(pe.findings.find((f) => f.rule_id === "BROWSER_PAGE_ERROR")?.evidence?.rendered).toContain("boom from page");
    expect(ids(pe)).not.toContain("HYDRATION_ERROR_DETECTED");
    const ce = await verify(m, "/console");
    expect(ce.findings.find((f) => f.rule_id === "BROWSER_CONSOLE_ERROR")?.severity).toBe("warning");
  });

  it("failed request is listed with the query value redacted", async () => {
    const dead = await startServer(() => undefined);
    const deadUrl = dead.url("");
    await dead.close();
    const r = await verify(mgr(), `/failed?dead=${encodeURIComponent(deadUrl)}`);
    const f = r.findings.find((x) => x.rule_id === "BROWSER_REQUEST_FAILED");
    expect(f).toBeDefined();
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(r.snapshots.rendered_dom?.failed_requests[0]?.url).toContain("token=REDACTED");
  });

  it("strips control characters from console text", async () => {
    const r = await verify(mgr(), "/ansi");
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("\\u001b");
    expect(dump).not.toContain("\\u202e");
    expect(r.snapshots.rendered_dom?.console_errors[0]).toContain("red");
  });
});

describe("modes, screenshot, limits", () => {
  it("lean blocks images and records it; faithful loads them", async () => {
    const m = mgr();
    const lean = await verify(m, "/images", { mode: "lean" });
    expect(lean.snapshots.rendered_dom?.blocked_resource_classes).toEqual(["image"]);
    expect(srv.hits.filter((h) => h === "/pic.png")).toHaveLength(0);
    expect(ids(lean)).not.toContain("BROWSER_REQUEST_FAILED");
    srv.hits.length = 0;
    const faithful = await verify(m, "/images", { mode: "faithful" });
    expect(faithful.snapshots.rendered_dom?.blocked_resource_classes).toEqual([]);
    expect(srv.hits).toContain("/pic.png");
  });

  it("screenshot is opt-in and byte-capped", async () => {
    const m = mgr();
    expect((await verify(m, "/static")).snapshots.rendered_dom?.screenshot).toBeNull();
    const shot = await verify(m, "/static", { include_screenshot: true });
    expect(shot.snapshots.rendered_dom?.screenshot?.format).toBe("png");
    expect(Buffer.from(shot.snapshots.rendered_dom!.screenshot!.data_base64, "base64").subarray(1, 4).toString()).toBe("PNG");
    const capped = await verify(m, "/static", { include_screenshot: true }, { maxScreenshotBytes: 100 });
    expect(capped.snapshots.rendered_dom?.screenshot).toBeNull();
    expect(capped.snapshots.rendered_dom?.notes.join(" ")).toContain("exceeds");
  });

  it("oversized DOM is handled and counts stay bounded", async () => {
    const r = await verify(mgr(), "/bigdom");
    expect(r.snapshots.rendered_dom?.word_count).toBeGreaterThan(100_000);
    expect(JSON.stringify(r).length).toBeLessThan(20_000);
  });
});

describe("hangs and failures end in typed errors with cleanup", () => {
  it("never-ending main document -> TIMEOUT, context closed, browser still usable", async () => {
    const m = mgr();
    expect(await code(verify(m, "/hang-doc", {}, { navigationTimeoutMs: 1000 }))).toBe("TIMEOUT");
    expect(m.stats.openContexts).toBe(0);
    expect((await verify(m, "/static")).status).toBe("pass");
  });

  it("never-ending subresource does not block the report", async () => {
    const r = await verify(mgr(), "/hang-sub");
    expect(r.status).toBe("pass");
  });

  it("busy-looping page -> TIMEOUT, cleanup, and the next job still works", async () => {
    const m = mgr({ closeTimeoutMs: 2000 });
    expect(await code(verify(m, "/busy", {}, { navigationTimeoutMs: 1000 }))).toBe("TIMEOUT");
    expect(m.stats.openContexts).toBe(0);
    expect((await verify(m, "/static")).status).toBe("pass");
  });

  it("total deadline applies", async () => {
    expect(await code(verify(mgr(), "/hang-doc", {}, { navigationTimeoutMs: 20_000, totalTimeoutMs: 800 }))).toBe("TIMEOUT");
  });

  it("closing the runner aborts an active job", async () => {
    const m = mgr();
    const r = new LocalRunner({ browser: m, limits: { ...fast, navigationTimeoutMs: 20_000 } });
    const p = code(r.verify({ target_url: srv.url("/hang-doc"), tier: "browser" }));
    await new Promise((res) => setTimeout(res, 800));
    await r.close();
    expect(await p).toBe("NETWORK_ERROR");
    expect(m.stats.openContexts).toBe(0);
  });

  it("browser process crash fails the active job; the dead browser is never reused", async () => {
    const m = mgr();
    await verify(m, "/static");
    const slot = (m as unknown as { current: { browser: { close(): Promise<void> } } }).current;
    const p = code(verify(m, "/hang-doc", {}, { navigationTimeoutMs: 20_000 }));
    await new Promise((res) => setTimeout(res, 800));
    await slot.browser.close();
    expect(await p).toBe("NETWORK_ERROR");
    expect((await verify(m, "/static")).status).toBe("pass");
    expect(m.stats.launches).toBe(2);
  });
});

describe("process reuse and recycling", () => {
  it("sequential jobs reuse one browser process", async () => {
    const m = mgr();
    for (let i = 0; i < 5; i++) await verify(m, "/static");
    expect(m.stats).toMatchObject({ launches: 1, jobs: 5, recycles: 0, openContexts: 0 });
  });

  it("recycles after N jobs (drain then replace)", async () => {
    const m = mgr({ maxJobsPerBrowser: 2 });
    for (let i = 0; i < 5; i++) await verify(m, "/static");
    expect(m.stats.launches).toBe(3);
    expect(m.stats.recycles).toBe(2);
  });

  it("concurrent jobs across a recycle boundary all succeed", async () => {
    const m = mgr({ maxJobsPerBrowser: 2 });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => verify(m, "/static")));
    expect(results.every((r) => r.status === "pass")).toBe(true);
    expect(m.stats.launches).toBeGreaterThanOrEqual(3);
    expect(m.stats.openContexts).toBe(0);
  });
});

describe("network policy inside the browser", () => {
  const publicPolicyMgr = () => mgr({ internals: { launchArgs: ["--host-resolver-rules=MAP public.test 127.0.0.1"] } });
  const input = (url: string, policy: "local" | "strict") => ({
    url,
    mode: "faithful" as const,
    policy: { profile: policy, allowedPorts: [srv.port] },
    limits: { ...DEFAULT_LIMITS, settleMs: 150, navigationTimeoutMs: 10_000 },
    signal: AbortSignal.timeout(20_000),
    includeScreenshot: false,
    internals,
  });

  it("local profile: loopback pages and subresources work", async () => {
    const r = await verify(mgr(), "/private-sub");
    expect(ids(r)).not.toContain("BROWSER_REQUEST_FAILED");
    expect(srv.hits).toContain("/secret.png");
  });

  it("strict profile refuses a loopback main frame", async () => {
    const m = mgr();
    await expect(m.collect(input(srv.url("/static"), "strict"))).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(srv.hits).toEqual([]);
  });

  it("a public page cannot load private subresources (no-escalation), even in local profile", async () => {
    const m = publicPolicyMgr();
    const snap = await m.collect(input(`http://public.test:${srv.port}/private-sub`, "local"));
    expect(snap.failed_requests).toEqual([expect.objectContaining({ reason: "blocked by network policy" })]);
    expect(srv.hits).not.toContain("/secret.png");
  });

  it("a redirect from a public page to a private address is rejected and its content is never returned", async () => {
    // Chromium follows redirects internally, so the browser may already have issued the request; only the Tier 1 fetch prevents it.
    const m = publicPolicyMgr();
    await expect(m.collect(input(`http://public.test:${srv.port}/to-private`, "local"))).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  });

  it("end to end, the Tier 1 fetch blocks the redirect before the browser starts", async () => {
    const m = publicPolicyMgr();
    const r = new LocalRunner({ browser: m, internals, limits: fast });
    runners.push(r);
    expect(await code(r.verify({ target_url: `http://public.test:${srv.port}/to-private`, tier: "browser" }))).toBe("POLICY_BLOCKED");
    expect(srv.hits).not.toContain("/secret");
    expect(m.stats.launches).toBe(0);
  });

  it("a private page may still load public subresources and keep using private ones", async () => {
    const m = publicPolicyMgr();
    const snap = await m.collect(input(srv.url("/private-sub"), "local"));
    expect(snap.failed_requests).toEqual([]);
    expect(srv.hits).toContain("/secret.png");
  });
});
