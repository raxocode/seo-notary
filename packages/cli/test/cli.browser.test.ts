import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT_ERROR, EXIT_FAIL, runCli } from "../src/index.js";
import { startServer, type MockServer } from "../../../tests/helpers/mock-server.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
let srv: MockServer;

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error("packages/cli/dist/bin.js is missing: run `npm run build` first");
  srv = await startServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    res.writeHead(200, { "content-type": "text/html" });
    if (p === "/overwrite") {
      res.end(`<!doctype html><title>Server title here</title><link rel="canonical" href="${srv.url("/overwrite")}"><script>document.title="Client title";</script><p>x</p>`);
    } else {
      res.end(`<!doctype html><title>Server title here</title><link rel="canonical" href="${srv.url(p)}"><meta name="description" content="d"><p>ok</p>`);
    }
  });
});
afterAll(async () => srv.close());

async function cli(args: string[]) {
  let out = "";
  let err = "";
  const code = await runCli(args, { out: (s) => void (out += s), err: (s) => void (err += s), color: false });
  return { code, out, err };
}

describe("CLI browser tier", () => {
  it("JS overwrite: exit 1, RENDER_TITLE_DIFFERS with raw and rendered values", async () => {
    const r = await cli(["verify", srv.url("/overwrite"), "--tier", "browser", "--format", "json"]);
    expect(r.code).toBe(EXIT_FAIL);
    const doc = JSON.parse(r.out) as { execution: { tier: string }; findings: { rule_id: string; evidence?: { raw?: string; rendered?: string } }[] };
    expect(doc.execution.tier).toBe("browser");
    const f = doc.findings.find((x) => x.rule_id === "RENDER_TITLE_DIFFERS");
    expect(f?.evidence).toEqual({ raw: "Server title here", rendered: "Client title" });
    expect(r.err).toBe("");
  });

  it("text output shows raw and rendered values", async () => {
    const r = await cli(["verify", srv.url("/overwrite"), "--tier", "browser", "--mode", "lean"]);
    expect(r.out).toContain("rendered: Client title");
    expect(r.out).toContain("(lean)");
  });

  it("clean page passes in the browser tier", async () => {
    expect((await cli(["verify", srv.url("/ok"), "--tier", "browser"])).code).toBe(0);
  });

  it("strict policy refuses localhost before launching a browser", async () => {
    const r = await cli(["verify", srv.url("/ok"), "--tier", "browser", "--policy", "strict"]);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.err).toContain("POLICY_BLOCKED");
  });

  it("doctor sees the installed browser", async () => {
    const doc = JSON.parse((await cli(["doctor", "--format", "json"])).out) as { checks: { name: string; status: string }[] };
    expect(doc.checks.find((c) => c.name.startsWith("Browser"))?.status).toBe("ok");
  });
});

describe("MCP browser tier", () => {
  it("verify_url with tier=browser returns the raw-vs-rendered diff in one call", async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], stderr: "pipe" });
    const client = new Client({ name: "notary-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: "verify_url", arguments: { url: srv.url("/overwrite"), tier: "browser", mode: "lean" } });
      expect(res.isError).toBeFalsy();
      const report = res.structuredContent as { status: string; snapshots: { rendered_dom: { title: string } }; findings: { rule_id: string }[] };
      expect(report.status).toBe("fail");
      expect(report.snapshots.rendered_dom.title).toBe("Client title");
      expect(report.findings.map((f) => f.rule_id)).toContain("RENDER_TITLE_DIFFERS");
      expect((res.content as { text: string }[])[0]!.text.length).toBeLessThanOrEqual(1500);
    } finally {
      await client.close();
    }
  });
});

describe("browser process cleanup", () => {
  it("the CLI exits on its own after a browser run (no orphaned Chromium keeps it alive)", async () => {
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, "verify", srv.url("/ok"), "--tier", "browser", "--format", "json"], { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("CLI did not exit within 30s"));
      }, 30_000);
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(0);
  });
});
