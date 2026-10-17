import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_FAIL, EXIT_OK, runCli } from "../src/index.js";
import { PAGE_OK, startServer, type MockServer } from "../../../tests/helpers/mock-server.js";

let srv: MockServer;

beforeAll(async () => {
  srv = await startServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    const html = (b: string, status = 200) => {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(b);
    };
    if (p === "/ok") return html(PAGE_OK.replace("CANON", srv.url("/ok")));
    if (p === "/notitle") return html("<html><head></head><body>hi</body></html>");
    if (p === "/warn") return html("<title>A title that is long enough</title><link rel='canonical' href='/warn'>");
    if (p === "/robots.txt") return html("User-agent: *");
    return html("nf", 404);
  });
});
afterAll(async () => srv.close());

async function cli(args: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(args, { out: (s) => void (out += s), err: (s) => void (err += s), color: false });
  return { code, out, err };
}

describe("verify", () => {
  it("passes: exit 0, human text with the verdict and fields", async () => {
    const r = await cli(["verify", srv.url("/ok")]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain("PASS");
    expect(r.out).toContain("A perfectly fine page title");
    expect(r.err).toBe("");
  });

  it("findings at or above --fail-on: exit 1 with rule id, evidence and fix", async () => {
    const r = await cli(["verify", srv.url("/notitle")]);
    expect(r.code).toBe(EXIT_FAIL);
    expect(r.out).toContain("FAIL");
    expect(r.out).toContain("HTML_TITLE_MISSING");
    expect(r.out).toContain("fix:");
  });

  it("--fail-on warning turns warnings into exit 1; default does not", async () => {
    expect((await cli(["verify", srv.url("/warn")])).code).toBe(EXIT_OK);
    expect((await cli(["verify", srv.url("/warn"), "--fail-on", "warning"])).code).toBe(EXIT_FAIL);
  });

  it("--format json writes exactly one JSON document to stdout and nothing to stderr", async () => {
    const r = await cli(["verify", srv.url("/notitle"), "--format", "json"]);
    expect(r.code).toBe(EXIT_FAIL);
    expect(r.err).toBe("");
    const doc = JSON.parse(r.out) as { status: string; findings: { rule_id: string }[]; schema_version: string };
    expect(doc.status).toBe("fail");
    expect(doc.schema_version).toBe("0.1.0");
    expect(r.out.trim().split("\n").filter((l) => l.startsWith("{")).length).toBeGreaterThan(0);
    expect(r.out.endsWith("}\n")).toBe(true);
  });

  it("--out writes the JSON report and keeps the chosen stdout format", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notary-"));
    try {
      const file = join(dir, "nested", "report.json");
      const r = await cli(["verify", srv.url("/ok"), "--out", file]);
      expect(r.code).toBe(EXIT_OK);
      expect(r.out).toContain("PASS");
      expect(JSON.parse(await readFile(file, "utf8")).status).toBe("pass");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("--check-robots-txt runs the extra rule", async () => {
    const without = JSON.parse((await cli(["verify", srv.url("/ok"), "--format", "json"])).out);
    const withIt = JSON.parse((await cli(["verify", srv.url("/ok"), "--check-robots-txt", "--format", "json"])).out);
    expect(withIt.summary.passed).toBe(without.summary.passed + 1);
  });
});

describe("operational errors are exit 2, never a pass", () => {
  it("connection refused: stderr message, JSON error document on stdout in json mode", async () => {
    const tmp = await startServer(() => undefined);
    const dead = tmp.url("/");
    await tmp.close();
    const text = await cli(["verify", dead]);
    expect(text.code).toBe(EXIT_ERROR);
    expect(text.err).toContain("NETWORK_ERROR");
    expect(text.out).toBe("");
    const json = await cli(["verify", dead, "--format", "json"]);
    expect(json.code).toBe(EXIT_ERROR);
    expect(JSON.parse(json.out)).toMatchObject({ error: { code: "NETWORK_ERROR" } });
    expect(JSON.parse(json.out)).not.toHaveProperty("status");
  });

  it("strict policy refuses localhost", async () => {
    const r = await cli(["verify", srv.url("/ok"), "--policy", "strict"]);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.err).toContain("POLICY_BLOCKED");
  });

  it("link-local is blocked by default", async () => {
    const r = await cli(["verify", "http://169.254.169.254/"]);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.err).toContain("POLICY_BLOCKED");
  });

  it("timeout", async () => {
    const slow = await startServer(() => undefined);
    try {
      const r = await cli(["verify", slow.url("/"), "--timeout-ms", "1000"]);
      expect(r.code).toBe(EXIT_ERROR);
      expect(r.err).toContain("TIMEOUT");
    } finally {
      await slow.close();
    }
  });

  it("unwritable --out is an error, not a silent pass", async () => {
    const r = await cli(["verify", srv.url("/ok"), "--out", "/dev/null/not-a-directory/report.json"]);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.err).toContain("could not write");
  });

  it.each([
    [["verify"]],
    [["verify", "a", "b"]],
    [["verify", "not a url"]],
    [["verify", "http://x.test/", "--format", "xml"]],
    [["verify", "http://x.test/", "--tier", "mobile"]],
    [["verify", "http://x.test/", "--timeout-ms", "5"]],
    [["verify", "http://x.test/", "--timeout-ms", "abc"]],
    [["verify", "http://x.test/", "--nope"]],
    [["frobnicate"]],
    [[]],
  ])("bad usage %j", async (args) => {
    const r = await cli(args);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.err).not.toBe("");
    expect(r.out).not.toContain("PASS");
  });
});

describe("other commands", () => {
  it("rules: text and json catalogs", async () => {
    const text = await cli(["rules"]);
    expect(text.code).toBe(EXIT_OK);
    expect(text.out).toContain("HTTP_STATUS");
    expect(text.out).toContain("RENDER_TITLE_DIFFERS");
    const json = JSON.parse((await cli(["rules", "--format", "json"])).out) as { rules: unknown[] };
    expect(json.rules).toHaveLength(23);
  });

  it("doctor: reports Node and browser state as one JSON document", async () => {
    const r = await cli(["doctor", "--format", "json"]);
    expect(r.code).toBe(EXIT_OK);
    const doc = JSON.parse(r.out) as { ok: boolean; checks: { name: string; status: string }[] };
    expect(doc.ok).toBe(true);
    expect(doc.checks.map((c) => c.name)).toEqual(["Node.js", "seo-notary", "Browser (Chromium)"]);
  });

  it("--help and --version", async () => {
    expect((await cli(["--help"])).out).toContain("seo-notary verify <url>");
    expect((await cli(["--version"])).out).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("terminal output never contains raw escape characters when color is off", async () => {
    const r = await cli(["verify", srv.url("/notitle")]);
    expect(r.out).not.toContain("\u001b");
  });
});
