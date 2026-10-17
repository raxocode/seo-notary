import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  LocalRunner,
  NotaryError,
  type FetchInternals,
  type LocalRunnerOptions,
  type ResolvedAddress,
} from "../../packages/core/src/index.js";
import { admitAddresses } from "../../packages/core/src/policy.js";
import { startServer, waitForNoSockets, PAGE_OK, type MockServer } from "../helpers/mock-server.js";

// All traffic stays on a loopback mock server. "Public" test hosts resolve to a public-class
// IP in the injected resolver, and mapConnectAddress then dials loopback after validation.
const PUBLIC_IP = "1.1.1.1";

let srv: MockServer;
let runner: LocalRunner;
let resolverCalls: string[] = [];

const dns: Record<string, string[]> = {
  "public.test": [PUBLIC_IP],
  "private.test": ["10.0.0.5"],
  "mixed.test": [PUBLIC_IP, "10.0.0.1"],
  "localhost.attacker.test": ["127.0.0.1"],
  "localhost": ["127.0.0.1", "::1"],
  "metadata.test": ["169.254.169.254"],
  "ula.test": ["fd12::1"],
  "mapped.test": ["::ffff:127.0.0.1"],
};

const internals: FetchInternals = {
  resolve: async (hostname): Promise<ResolvedAddress[]> => {
    resolverCalls.push(hostname);
    const list = dns[hostname];
    if (!list) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  },
  mapConnectAddress: (address) => (address === PUBLIC_IP ? "127.0.0.1" : address),
};

beforeAll(async () => {
  srv = await startServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(b);
    };
    switch (p) {
      case "/ok": return html(PAGE_OK.replace("CANON", "http://public.test/ok"));
      case "/secret": return html("<title>INTERNAL SECRET</title>");
      case "/to-loopback": res.writeHead(302, { location: `http://127.0.0.1:${srv.port}/secret` }); return void res.end();
      case "/to-localhost-name": res.writeHead(302, { location: `http://localhost:${srv.port}/secret` }); return void res.end();
      case "/to-private-name": res.writeHead(302, { location: `http://private.test:${srv.port}/secret` }); return void res.end();
      case "/to-mixed": res.writeHead(302, { location: `http://mixed.test:${srv.port}/secret` }); return void res.end();
      case "/to-v6-loopback": res.writeHead(302, { location: `http://[::1]:${srv.port}/secret` }); return void res.end();
      case "/to-mapped": res.writeHead(302, { location: `http://[::ffff:127.0.0.1]:${srv.port}/secret` }); return void res.end();
      case "/to-decimal": res.writeHead(302, { location: `http://2130706433:${srv.port}/secret` }); return void res.end();
      case "/to-public": res.writeHead(302, { location: `http://public.test:${srv.port}/ok` }); return void res.end();
      case "/to-meta": res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }); return void res.end();
      case "/to-file": res.writeHead(302, { location: "file:///etc/passwd" }); return void res.end();
      case "/to-ftp": res.writeHead(302, { location: "ftp://public.test/x" }); return void res.end();
      case "/to-js": res.writeHead(302, { location: "javascript:alert(1)" }); return void res.end();
      case "/to-userinfo": res.writeHead(302, { location: `http://user:pw@public.test:${srv.port}/ok` }); return void res.end();
      default: return html("<title>other page here</title>");
    }
  });
});

afterAll(async () => srv.close());
afterEach(async () => {
  await runner?.close();
  resolverCalls = [];
  srv.hits.length = 0;
});

const make = (opts: LocalRunnerOptions = {}) => (runner = new LocalRunner({ internals, ...opts }));
const run = async (url: string, policy: "local" | "strict", opts: LocalRunnerOptions = {}) => {
  try {
    await make(opts).verify({ target_url: url, policy });
    return "OK";
  } catch (e) {
    if (e instanceof NotaryError) return e.code;
    throw e;
  }
};
const strictPorts = () => ({ allowedPorts: [srv.port] });
const secretHit = () => srv.hits.some((h) => h.startsWith("/secret"));

describe("strict profile blocks private targets before any connection", () => {
  const targets = [
    "http://localhost/",
    "http://localhost:80/",
    "http://app.localhost/",
    "http://printer.local/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://172.16.5.5/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[fd00:ec2::254]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[::ffff:10.0.0.1]/",
    "http://0.0.0.0/",
    "http://100.64.0.1/",
    "http://224.0.0.1/",
    "http://2130706433/",
    "http://017700000001/",
    "http://0177.0.0.1/",
    "http://0x7f.1/",
    "http://0x7f000001/",
    "http://2852039166/",
  ];
  it.each(targets)("%s", async (t) => {
    expect(await run(t, "strict")).toBe("POLICY_BLOCKED");
    expect(resolverCalls).toEqual([]);
  });

  it("hostnames resolving to non-public classes are blocked at connect time", async () => {
    for (const host of ["localhost.attacker.test", "private.test", "metadata.test", "ula.test", "mapped.test", "mixed.test"]) {
      expect(await run(`http://${host}:${srv.port}/secret`, "strict", strictPorts()), host).toBe("POLICY_BLOCKED");
    }
    expect(secretHit()).toBe(false);
  });

  it("localhost-lookalike public name is judged by its address, not its spelling", async () => {
    dns["localhost.public-looking.test"] = [PUBLIC_IP];
    const r = await make(strictPorts()).verify({ target_url: `http://localhost.public-looking.test:${srv.port}/ok`, policy: "strict" });
    expect(r.status).toBe("pass");
    delete dns["localhost.public-looking.test"];
  });

  it("odd ports are refused by default and allowed only when configured", async () => {
    expect(await run(`http://public.test:${srv.port}/ok`, "strict")).toBe("POLICY_BLOCKED");
    expect(await run("http://public.test:8080/", "strict")).toBe("POLICY_BLOCKED");
    expect(await run(`http://public.test:${srv.port}/ok`, "strict", strictPorts())).toBe("OK");
  });

  it("acceptance: local fixture works in local profile and is refused in strict", async () => {
    expect(await run(srv.url("/ok"), "local")).toBe("OK");
    expect(await run(srv.url("/ok"), "strict")).toBe("POLICY_BLOCKED");
    expect(await run(srv.url("/ok"), "strict", strictPorts())).toBe("POLICY_BLOCKED");
  });
});

describe("local profile", () => {
  it("allows loopback, private and cgnat targets", async () => {
    expect(await run(srv.url("/ok"), "local")).toBe("OK");
    expect(await run(`http://localhost:${srv.port}/ok`, "local")).toBe("OK");
    expect(await run(`http://[::ffff:127.0.0.1]:${srv.port}/ok`, "local")).toBe("OK");
  });

  it("always blocks link-local and metadata unless explicitly allowed", async () => {
    for (const t of ["http://169.254.169.254/", "http://2852039166/", "http://[fe80::1]/", "http://[fd00:ec2::254]/", "http://0.0.0.0:80/", `http://metadata.test:${srv.port}/`]) {
      expect(await run(t, "local"), t).toBe("POLICY_BLOCKED");
    }
  });

  it("allowLinkLocal is the only switch for link-local (policy level)", () => {
    const state = { sawPublic: false };
    expect(() => admitAddresses(["169.254.1.1"], { profile: "local" }, state)).toThrow(NotaryError);
    expect(() => admitAddresses(["169.254.1.1"], { profile: "local", allowLinkLocal: true }, state)).not.toThrow();
    expect(() => admitAddresses(["169.254.1.1"], { profile: "strict", allowLinkLocal: true }, state)).toThrow(NotaryError);
    expect(() => admitAddresses([], { profile: "local" }, state)).toThrow(/no addresses/);
  });

  it("private -> public redirects are allowed", async () => {
    const r = await make().verify({ target_url: srv.url("/to-public") });
    expect(r.snapshots.raw_http.final_url).toBe(`http://public.test:${srv.port}/ok`);
  });
});

describe("no-escalation rule (both profiles): public -> private is blocked and never contacted", () => {
  const paths = ["/to-loopback", "/to-localhost-name", "/to-private-name", "/to-mixed", "/to-v6-loopback", "/to-mapped", "/to-decimal", "/to-meta"];

  it.each(paths)("local: public.test -> %s", async (p) => {
    expect(await run(`http://public.test:${srv.port}${p}`, "local")).toBe("POLICY_BLOCKED");
    expect(secretHit()).toBe(false);
  });

  it.each(paths)("strict: public.test -> %s", async (p) => {
    expect(await run(`http://public.test:${srv.port}${p}`, "strict", strictPorts())).toBe("POLICY_BLOCKED");
    expect(secretHit()).toBe(false);
  });

  it("sawPublic persists across hops (public -> private is blocked even after a private hop in between)", () => {
    const state = { sawPublic: false };
    admitAddresses(["127.0.0.1"], { profile: "local" }, state);
    admitAddresses([PUBLIC_IP], { profile: "local" }, state);
    expect(state.sawPublic).toBe(true);
    expect(() => admitAddresses(["10.0.0.1"], { profile: "local" }, state)).toThrow(/public host to a non-public/);
  });
});

describe("redirect scheme and credential tricks", () => {
  it.each(["/to-file", "/to-ftp", "/to-js"])("%s is blocked", async (p) => {
    expect(await run(`http://public.test:${srv.port}${p}`, "local")).toBe("POLICY_BLOCKED");
  });

  it("redirect with userinfo is blocked", async () => {
    expect(await run(`http://public.test:${srv.port}/to-userinfo`, "local")).toBe("POLICY_BLOCKED");
  });

  it("userinfo tricks in the target are blocked or rejected", async () => {
    expect(await run("http://127.0.0.1@public.test/", "local")).toBe("POLICY_BLOCKED");
    expect(await run("http://user:pass@public.test/", "strict")).toBe("POLICY_BLOCKED");
    expect(["INVALID_INPUT", "POLICY_BLOCKED"]).toContain(await run("http://public.test%40127.0.0.1/", "local"));
    expect(await run("file:///etc/passwd", "local")).toBe("INVALID_INPUT");
    expect(await run("javascript:alert(1)", "local")).toBe("INVALID_INPUT");
  });
});

describe("DNS handling", () => {
  it("resolves exactly once per hop and connects to the validated answer (no rebinding window)", async () => {
    let calls = 0;
    const rebinding: FetchInternals = {
      ...internals,
      resolve: async () => {
        calls++;
        return [{ address: calls === 1 ? PUBLIC_IP : "10.0.0.5", family: 4 }];
      },
    };
    runner = new LocalRunner({ internals: rebinding });
    const r = await runner.verify({ target_url: `http://flip.test:${srv.port}/ok` });
    expect(r.status).toBe("pass");
    expect(calls).toBe(1);
  });

  it("DNS failure is operational", async () => {
    expect(await run(`http://nxdomain.test:${srv.port}/`, "local")).toBe("DNS_FAILURE");
  });

  it("empty DNS answer is operational", async () => {
    dns["empty.test"] = [];
    expect(await run(`http://empty.test:${srv.port}/`, "local")).toBe("DNS_FAILURE");
    delete dns["empty.test"];
  });
});

describe("hygiene", () => {
  it("blocked requests leave no sockets and no report", async () => {
    await run(`http://public.test:${srv.port}/to-loopback`, "local");
    expect(await waitForNoSockets(srv)).toBe(0);
  });

  it("policy errors never echo response bodies", async () => {
    try {
      await make().verify({ target_url: `http://public.test:${srv.port}/to-loopback` });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("INTERNAL SECRET");
    }
  });
});
