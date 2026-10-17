import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LocalRunner, NotaryError, ReportSchema, type Report } from "../../packages/core/src/index.js";
import { PAGE_OK, startServer, waitForNoSockets, type MockServer } from "../helpers/mock-server.js";

let srv: MockServer;
let runner: LocalRunner;

const ids = (r: Report) => r.findings.map((f) => f.rule_id);
const page = (path: string) => PAGE_OK.replace("CANON", srv.url(path));

beforeAll(async () => {
  srv = await startServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const p = url.pathname;
    const html = (body: string | Buffer, status = 200, type = "text/html; charset=utf-8", extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...extra });
      res.end(body);
    };
    const redirect = (to: string, status = 301) => {
      res.writeHead(status, { location: to });
      res.end();
    };
    switch (p) {
      case "/ok": return html(page("/ok"));
      case "/r301": return redirect("/ok", 301);
      case "/r302": return redirect("/ok", 302);
      case "/rq": return redirect("/ok?session=topsecret", 302);
      case "/r-a": return redirect("/r-b");
      case "/r-b": return redirect("/r-a");
      case "/c1": return redirect("/c2");
      case "/c2": return redirect("/c3");
      case "/c3": return redirect("/ok");
      case "/two1": return redirect("/two2");
      case "/two2": return redirect("/ok");
      case "/many": return redirect(`/many?n=${Number(url.searchParams.get("n") ?? 0) + 1}`);
      case "/404": return html("<title>Not found page</title>", 404);
      case "/410": return html("gone", 410);
      case "/500": return html("boom", 500);
      case "/401": return html(page("/401"), 401);
      case "/delayed": return void setTimeout(() => html(page("/delayed")), 400);
      case "/stall":
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<html><title>partial");
        return;
      case "/big":
        res.writeHead(200, { "content-type": "text/html" });
        return void res.end("a".repeat(5000));
      case "/gzip":
        return html(gzipSync(Buffer.from(page("/gzip"))), 200, "text/html", { "content-encoding": "gzip" });
      case "/bomb":
        return html(gzipSync(Buffer.alloc(200_000)), 200, "text/html", { "content-encoding": "gzip" });
      case "/badenc":
        return html("x", 200, "text/html", { "content-encoding": "zstd" });
      case "/charset":
        return html('<html><head><title>Café résumé title</title></head></html>', 200, "text/html; charset=bogus-charset-xyz");
      case "/json": return html('{"a":1}', 200, "application/json");
      case "/empty": return html("");
      case "/notitle": return html("<html><head></head><body>hi</body></html>");
      case "/wsp-title": return html("<html><head><title>  \n </title></head></html>");
      case "/longtitle": return html(`<title>${"x".repeat(90)}</title>`);
      case "/multican": return html('<link rel="canonical" href="/a"><link rel="canonical" href="/b"><title>Title long enough</title>');
      case "/dupcan": return html('<link rel="canonical" href="/a"><link rel="canonical" href="/a"><title>Title long enough</title>');
      case "/badcan": return html('<link rel="canonical" href="http://[::1"><link rel="canonical" href="javascript:x"><link rel="canonical"><title>Title long enough</title>');
      case "/crosscan": return html('<link rel="canonical" href="https://other.example/page"><title>Title long enough</title>');
      case "/mismatch": return html('<link rel="canonical" href="/mismatch/"><title>Title long enough</title>');
      case "/badld": return html('<script type="application/ld+json">{"a":</script><script type="application/ld+json"> </script><title>Title long enough</title>');
      case "/xrobots": return html(page("/xrobots"), 200, "text/html", { "x-robots-tag": "googlebot: noindex, nofollow" });
      case "/metarobots": return html('<meta name="robots" content="none"><title>Title long enough</title>');
      case "/pdf": return html("%PDF", 200, "application/pdf", { "x-robots-tag": "noindex" });
      case "/ansi": return html("<title>\u001b[31mRED\u202eTITLE here ok</title>");
      case "/cookie":
        res.writeHead(200, { "content-type": "text/html", "set-cookie": "sid=abc; HttpOnly" });
        return void res.end(page("/cookie"));
      case "/rfile": return redirect("file:///etc/passwd");
      case "/rftp": return redirect("ftp://example.test/x");
      case "/rbad": return redirect("http://[::1");
      case "/rempty": return redirect("");
      case "/robots.txt": return html("User-agent: *", 200, "text/plain");
      case "/hugeheader":
        res.writeHead(200, { "content-type": "text/html", "x-big": "y".repeat(60_000) });
        return void res.end("x");
      default: return html("nf", 404);
    }
  });
});

afterAll(async () => srv.close());
afterEach(async () => {
  await runner?.close();
});

const make = (limits = {}) => (runner = new LocalRunner({ limits }));
const verify = (path: string, extra: Record<string, unknown> = {}, limits = {}) =>
  make(limits).verify({ target_url: srv.url(path), ...extra });
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof NotaryError) return e.code;
    throw e;
  }
  return "NO_ERROR";
};

describe("Tier 1 happy paths", () => {
  it("normal 200: passes, valid schema, no findings, snapshot populated", async () => {
    const r = await verify("/ok");
    expect(ReportSchema.safeParse(r).success).toBe(true);
    expect(r.status).toBe("pass");
    expect(r.findings).toEqual([]);
    expect(r.snapshots.raw_http).toMatchObject({
      status: 200,
      title: "A perfectly fine page title",
      meta_description: "A description.",
      canonical: srv.url("/ok"),
      word_count: 6,
      redirect_chain: [],
    });
    expect(r.snapshots.rendered_dom).toBeNull();
    expect(r.execution).toMatchObject({ tier: "http", mode: null, runner: "local", redirects_followed: 0 });
    expect(r.summary).toMatchObject({ failed: 0, warnings: 0, info: 0 });
    expect(await waitForNoSockets(srv)).toBe(0);
  });

  it("301 and 302 are followed and recorded; final page is checked", async () => {
    for (const p of ["/r301", "/r302"]) {
      const r = await verify(p);
      expect(r.snapshots.raw_http.final_url).toBe(srv.url("/ok"));
      expect(r.snapshots.raw_http.redirect_chain).toEqual([{ url: srv.url(p), status: p === "/r301" ? 301 : 302 }]);
      expect(r.execution.redirects_followed).toBe(1);
      expect(r.status).toBe("pass");
    }
  });

  it("redacts query values in redirect_chain", async () => {
    const r = await verify("/rq?token=abc123");
    expect(JSON.stringify(r.snapshots.raw_http.redirect_chain)).not.toContain("abc123");
    expect(r.snapshots.raw_http.redirect_chain[0]?.url).toContain("token=REDACTED");
  });

  it("reports redirect chain severity: 2 hops info, 3 hops warning", async () => {
    const two = await verify("/two1");
    expect(two.findings.find((f) => f.rule_id === "HTTP_REDIRECT_CHAIN")?.severity).toBe("info");
    expect(two.status).toBe("pass");
    const three = await verify("/c1");
    expect(three.findings.find((f) => f.rule_id === "HTTP_REDIRECT_CHAIN")?.severity).toBe("warning");
  });

  it("decodes gzip and tolerates unknown charsets", async () => {
    expect((await verify("/gzip")).snapshots.raw_http.title).toBe("A perfectly fine page title");
    expect((await verify("/charset")).snapshots.raw_http.title).toBe("Café résumé title");
  });

  it("is deterministic apart from timings", async () => {
    const strip = (r: Report) => ({ ...r, execution: undefined });
    const a = await verify("/badld");
    const b = await verify("/badld");
    expect(JSON.stringify(strip(a))).toBe(JSON.stringify(strip(b)));
  });

  it("never records cookies or response set-cookie", async () => {
    const r = await verify("/cookie");
    expect(JSON.stringify(r)).not.toMatch(/sid=abc|set-cookie/i);
  });
});

describe("HTTP status findings (a received response is a finding, not an error)", () => {
  it.each([
    ["/404", "error", "fail"],
    ["/410", "error", "fail"],
    ["/500", "error", "fail"],
    ["/401", "warning", "pass"],
  ])("%s -> HTTP_STATUS %s, report %s", async (path, sev, status) => {
    const r = await verify(path);
    expect(r.findings.find((f) => f.rule_id === "HTTP_STATUS")?.severity).toBe(sev);
    expect(r.status).toBe(status);
  });

  it("fail_on controls pass/fail", async () => {
    expect((await verify("/401", { fail_on: "warning" })).status).toBe("fail");
    expect((await verify("/two1", { fail_on: "info" })).status).toBe("fail");
    expect((await verify("/ok", { fail_on: "info" })).status).toBe("pass");
  });
});

describe("HTML rules", () => {
  it("missing, whitespace-only and empty-document titles", async () => {
    for (const p of ["/notitle", "/wsp-title", "/empty"]) {
      const r = await verify(p);
      expect(ids(r), p).toContain("HTML_TITLE_MISSING");
      expect(r.status).toBe("fail");
    }
  });

  it("missing description and canonical are warnings; exit-0 at default fail_on", async () => {
    const r = await verify("/empty", { rules: ["META_DESCRIPTION_MISSING", "CANONICAL_MISSING"] });
    expect(r.findings.map((f) => `${f.rule_id}:${f.severity}`)).toEqual(["CANONICAL_MISSING:warning", "META_DESCRIPTION_MISSING:warning"]);
    expect(r.status).toBe("pass");
  });

  it("title length is info only", async () => {
    const r = await verify("/longtitle");
    expect(r.findings.find((f) => f.rule_id === "HTML_TITLE_LENGTH")?.severity).toBe("info");
  });

  it("multiple differing canonicals -> CANONICAL_MULTIPLE; identical duplicates do not", async () => {
    expect(ids(await verify("/multican"))).toContain("CANONICAL_MULTIPLE");
    expect(ids(await verify("/dupcan"))).not.toContain("CANONICAL_MULTIPLE");
  });

  it("malformed canonicals -> CANONICAL_INVALID for each bad link", async () => {
    const r = await verify("/badcan");
    expect(ids(r).filter((i) => i === "CANONICAL_INVALID")).toHaveLength(3);
  });

  it("cross-origin canonical warns; same-origin mismatch is info", async () => {
    const cross = await verify("/crosscan");
    expect(cross.findings.find((f) => f.rule_id === "CANONICAL_CROSS_ORIGIN")?.severity).toBe("warning");
    expect(ids(cross)).not.toContain("CANONICAL_MISMATCH");
    const mm = await verify("/mismatch");
    expect(mm.findings.find((f) => f.rule_id === "CANONICAL_MISMATCH")?.severity).toBe("info");
  });

  it("malformed and empty JSON-LD -> JSON_LD_INVALID", async () => {
    const r = await verify("/badld");
    expect(r.findings.filter((f) => f.rule_id === "JSON_LD_INVALID")).toHaveLength(2);
  });

  it("X-Robots-Tag and meta robots noindex -> ROBOTS_NOINDEX (warning)", async () => {
    const h = await verify("/xrobots");
    expect(h.findings.find((f) => f.rule_id === "ROBOTS_NOINDEX")).toMatchObject({ severity: "warning", location: "header:x-robots-tag" });
    expect(h.snapshots.raw_http.robots_directives).toEqual(["googlebot:nofollow", "googlebot:noindex"]);
    const m = await verify("/metarobots");
    expect(m.findings.find((f) => f.rule_id === "ROBOTS_NOINDEX")?.location).toBe('meta[name="robots"]');
  });

  it("strips control characters from page-derived strings", async () => {
    const r = await verify("/ansi");
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("\\u001b");
    expect(dump).not.toContain("\\u202e");
    expect(r.snapshots.raw_http.title).toContain("RED");
  });

  it("findings are sorted by severity, rule id, location", async () => {
    const r = await verify("/badcan");
    const rank = { error: 0, warning: 1, info: 2 };
    for (let i = 1; i < r.findings.length; i++) {
      const a = r.findings[i - 1]!;
      const b = r.findings[i]!;
      expect(rank[a.severity] <= rank[b.severity]).toBe(true);
    }
  });

  it("rules allowlist limits which rules run", async () => {
    const r = await verify("/notitle", { rules: ["META_DESCRIPTION_MISSING"] });
    expect(ids(r)).toEqual(["META_DESCRIPTION_MISSING"]);
    expect(r.summary.passed).toBe(0);
  });
});

describe("non-HTML and robots.txt", () => {
  it("non-HTML: NON_HTML_CONTENT info, HTML rules skipped, no parser crash", async () => {
    const r = await verify("/json");
    expect(ids(r)).toEqual(["NON_HTML_CONTENT"]);
    expect(r.snapshots.raw_http).toMatchObject({ title: null, word_count: null, content_type: "application/json" });
  });

  it("X-Robots-Tag applies to non-HTML responses", async () => {
    expect(ids(await verify("/pdf"))).toContain("ROBOTS_NOINDEX");
  });

  it("robots.txt rule only runs with check_robots_txt", async () => {
    const off = await verify("/ok");
    const on = await verify("/ok", { check_robots_txt: true });
    expect(on.summary.passed).toBe(off.summary.passed + 1);
    expect(ids(on)).not.toContain("ROBOTS_TXT_UNAVAILABLE");
  });

  it("reports ROBOTS_TXT_UNAVAILABLE when robots.txt is missing", async () => {
    const other = await startServer((_q, res) => {
      res.writeHead(404);
      res.end();
    });
    try {
      const r = await make().verify({ target_url: other.url("/"), check_robots_txt: true });
      expect(ids(r)).toContain("ROBOTS_TXT_UNAVAILABLE");
    } finally {
      await other.close();
    }
  });
});

describe("operational errors (never a report)", () => {
  it("redirect loop", async () => expect(await code(verify("/r-a"))).toBe("REDIRECT_LOOP"));

  it("too many redirects", async () => expect(await code(verify("/many", {}, { maxRedirects: 3 }))).toBe("TOO_MANY_REDIRECTS"));

  it("delayed response beyond the hop timeout", async () => {
    expect(await code(verify("/delayed", {}, { hopTimeoutMs: 100 }))).toBe("TIMEOUT");
    expect(await waitForNoSockets(srv)).toBe(0);
  });

  it("delayed but within limits succeeds", async () => {
    expect((await verify("/delayed")).status).toBe("pass");
  });

  it("stalled body ends at the deadline and releases the socket", async () => {
    expect(await code(verify("/stall", {}, { hopTimeoutMs: 200 }))).toBe("TIMEOUT");
    expect(await waitForNoSockets(srv)).toBe(0);
  });

  it("total deadline applies across hops", async () => {
    expect(await code(verify("/stall", {}, { hopTimeoutMs: 10_000, totalTimeoutMs: 200 }))).toBe("TIMEOUT");
  });

  it("oversized body (declared and streamed)", async () => {
    expect(await code(verify("/big", {}, { maxResponseBytes: 1000 }))).toBe("BODY_TOO_LARGE");
    expect(await waitForNoSockets(srv)).toBe(0);
  });

  it("decompression bomb is capped by decoded size", async () => {
    expect(await code(verify("/bomb", {}, { maxResponseBytes: 10_000 }))).toBe("BODY_TOO_LARGE");
  });

  it("unsupported content-encoding", async () => expect(await code(verify("/badenc"))).toBe("NETWORK_ERROR"));

  it("oversized response headers", async () => expect(await code(verify("/hugeheader"))).toBe("NETWORK_ERROR"));

  it("connection refused", async () => {
    const tmp = await startServer(() => undefined);
    const dead = tmp.url("/");
    await tmp.close();
    expect(await code(make().verify({ target_url: dead }))).toBe("NETWORK_ERROR");
  });

  it("redirect to unsupported scheme or malformed Location", async () => {
    expect(await code(verify("/rfile"))).toBe("POLICY_BLOCKED");
    expect(await code(verify("/rftp"))).toBe("POLICY_BLOCKED");
    expect(await code(verify("/rbad"))).toBe("REDIRECT_INVALID");
  });

  it("invalid requests", async () => {
    const r = make();
    expect(await code(r.verify({ target_url: "not a url" }))).toBe("INVALID_INPUT");
    expect(await code(r.verify({ target_url: "ftp://example.test/" }))).toBe("INVALID_INPUT");
    expect(await code(r.verify({ target_url: `http://example.test/${"a".repeat(3000)}` }))).toBe("INVALID_INPUT");
    expect(await code(r.verify({ target_url: srv.url("/ok"), extra: 1 }))).toBe("INVALID_INPUT");
    expect(await code(r.verify({ target_url: srv.url("/ok"), rules: ["NOPE"] }))).toBe("INVALID_INPUT");
    expect(await code(r.verify(null))).toBe("INVALID_INPUT");
  });

  it("browser tier is unavailable in core", async () => {
    expect(await code(verify("/ok", { tier: "browser" }))).toBe("BROWSER_UNAVAILABLE");
  });

  it("repeated use and close() release everything; closed runner refuses work", async () => {
    const r = make();
    for (let i = 0; i < 5; i++) await r.verify({ target_url: srv.url("/ok") });
    expect(await waitForNoSockets(srv)).toBe(0);
    await r.close();
    expect(await code(r.verify({ target_url: srv.url("/ok") }))).toBe("INVALID_INPUT");
  });

  it("close() aborts an in-flight request", async () => {
    const r = make();
    const p = code(r.verify({ target_url: srv.url("/stall") }));
    await new Promise((res) => setTimeout(res, 100));
    await r.close();
    expect(await p).toBe("NETWORK_ERROR");
    expect(await waitForNoSockets(srv)).toBe(0);
  });
});
