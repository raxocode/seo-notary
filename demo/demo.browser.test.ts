import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../packages/cli/src/index.js";
import { startDemoServer } from "./server.js";

let demo: Awaited<ReturnType<typeof startDemoServer>>;

beforeAll(async () => {
  demo = await startDemoServer(0);
});
afterAll(async () => demo.close());

async function verify(page: string) {
  let out = "";
  let err = "";
  const code = await runCli(["verify", `http://127.0.0.1:${demo.port}/${page}`, "--tier", "browser", "--format", "json"], {
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    color: false,
  });
  return { code, report: JSON.parse(out) as { status: string; findings: { rule_id: string; evidence?: { raw?: string; rendered?: string } }[] }, err };
}

describe("demo: verify, fail, fix, pass", () => {
  it("/broken fails with the title and canonical rewritten by JavaScript", async () => {
    const r = await verify("broken");
    expect(r.code).toBe(1);
    expect(r.report.status).toBe("fail");
    const byId = Object.fromEntries(r.report.findings.map((f) => [f.rule_id, f]));
    expect(byId["RENDER_TITLE_DIFFERS"]?.evidence).toEqual({
      raw: "Acme Widgets | Handmade widgets for every workshop",
      rendered: "Loading...",
    });
    expect(byId["RENDER_CANONICAL_DIFFERS"]?.evidence?.rendered).toBe("https://staging.acme.example/broken");
    expect(r.err).toBe("");
  });

  it("/fixed passes with no findings", async () => {
    const r = await verify("fixed");
    expect(r.code).toBe(0);
    expect(r.report.findings).toEqual([]);
  });

  it("the loop is deterministic: repeated runs give identical findings", async () => {
    const a = await verify("broken");
    const b = await verify("broken");
    expect(JSON.stringify(a.report.findings)).toBe(JSON.stringify(b.report.findings));
  });
});
