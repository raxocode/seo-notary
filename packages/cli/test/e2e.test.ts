import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAGE_OK, startServer, type MockServer } from "../../../tests/helpers/mock-server.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
let srv: MockServer;

beforeAll(async () => {
  if (!existsSync(BIN)) throw new Error("packages/cli/dist/bin.js is missing: run `npm run build` first");
  srv = await startServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    res.writeHead(p === "/ok" || p === "/notitle" ? 200 : 404, { "content-type": "text/html" });
    res.end(p === "/ok" ? PAGE_OK.replace("CANON", srv.url("/ok")) : p === "/notitle" ? "<html><head></head><body>hi</body></html>" : "nf");
  });
});
afterAll(async () => srv.close());

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("built binary", () => {
  it("verify --format json: one JSON document on stdout, exit codes 0/1/2", async () => {
    const ok = await run(["verify", srv.url("/ok"), "--format", "json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).status).toBe("pass");
    expect(ok.stderr).toBe("");
    const bad = await run(["verify", srv.url("/notitle"), "--format", "json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout).findings.map((f: { rule_id: string }) => f.rule_id)).toContain("HTML_TITLE_MISSING");
    const err = await run(["verify", "http://169.254.169.254/", "--format", "json"]);
    expect(err.code).toBe(2);
    expect(JSON.parse(err.stdout).error.code).toBe("POLICY_BLOCKED");
    expect(err.stderr).toContain("POLICY_BLOCKED");
  });

  it("a Tier 1 run never resolves the browser package or Playwright", async () => {
    const trace = `
      import { registerHooks } from "node:module";
      import { writeFileSync } from "node:fs";
      const seen = new Set();
      registerHooks({ resolve(s, c, next) { const r = next(s, c); seen.add(r.url); return r; } });
      process.on("exit", () => writeFileSync(process.env.TRACE_FILE, JSON.stringify([...seen])));
    `;
    const dir = await mkdtemp(join(tmpdir(), "notary-trace-"));
    const file = join(dir, "seen.json");
    try {
      const r = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(trace)}`, BIN, "verify", srv.url("/ok"), "--format", "json"], {
          stdio: "ignore",
          env: { ...process.env, TRACE_FILE: file },
        });
        child.on("error", reject);
        child.on("close", resolve);
      });
      expect(r).toBe(0);
      const seen = JSON.parse(await readFile(file, "utf8")) as string[];
      expect(seen.some((u) => u.includes("seo-notary-core") || u.includes("packages/core"))).toBe(true);
      expect(seen.filter((u) => /playwright|seo-notary-browser|packages\/browser/.test(u))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP over stdio", () => {
  async function connect() {
    const transport = new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], stderr: "pipe" });
    const stderr: string[] = [];
    transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
    const client = new Client({ name: "notary-test", version: "0.0.0" });
    await client.connect(transport);
    return { client, stderr };
  }

  it("lists both tools with annotations and an action-oriented description", async () => {
    const { client } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["get_rule_catalog", "verify_url"]);
      const verify = tools.find((t) => t.name === "verify_url")!;
      expect(verify.description).toContain("after editing pages");
      expect(verify.description).toContain("untrusted evidence");
      expect(verify.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(Object.keys((verify.inputSchema as { properties: object }).properties).sort()).toEqual(["fail_on", "mode", "tier", "timeout_ms", "url"]);
    } finally {
      await client.close();
    }
  });

  it("verify_url returns a complete report in one call: structuredContent plus a compact summary", async () => {
    const { client, stderr } = await connect();
    try {
      const res = await client.callTool({ name: "verify_url", arguments: { url: srv.url("/notitle") } });
      expect(res.isError).toBeFalsy();
      const report = res.structuredContent as { status: string; findings: { rule_id: string }[] };
      expect(report.status).toBe("fail");
      expect(report.findings.map((f) => f.rule_id)).toContain("HTML_TITLE_MISSING");
      const text = (res.content as { type: string; text: string }[])[0]!.text;
      expect(text.length).toBeLessThanOrEqual(1500);
      expect(text).toContain("HTML_TITLE_MISSING");
      expect(text).toContain("untrusted evidence");
      expect(stderr.join("")).toContain("ready on stdio");
    } finally {
      await client.close();
    }
  });

  it("operational errors are isError results with a typed message, never a fabricated report", async () => {
    const { client } = await connect();
    try {
      for (const [url, code] of [
        ["http://169.254.169.254/", "POLICY_BLOCKED"],
        ["not a url", "INVALID_INPUT"],
      ] as const) {
        const res = await client.callTool({ name: "verify_url", arguments: { url } });
        expect(res.isError).toBe(true);
        expect(res.structuredContent).toBeUndefined();
        expect((res.content as { text: string }[])[0]!.text).toContain(code);
      }
    } finally {
      await client.close();
    }
  });

  it("rejects invalid arguments", async () => {
    const { client } = await connect();
    try {
      const res = await client.callTool({ name: "verify_url", arguments: { url: srv.url("/ok"), timeout_ms: 5 } }).catch((e: unknown) => e);
      const failed = res instanceof Error || (res as { isError?: boolean }).isError === true;
      expect(failed).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("get_rule_catalog lists every rule", async () => {
    const { client } = await connect();
    try {
      const res = await client.callTool({ name: "get_rule_catalog", arguments: {} });
      const rules = (res.structuredContent as { rules: { id: string }[] }).rules;
      expect(rules).toHaveLength(23);
      expect(rules.map((r) => r.id)).toContain("RENDER_CANONICAL_DIFFERS");
    } finally {
      await client.close();
    }
  });
});
