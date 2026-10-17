import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Agent, request } from "undici";
import type { Limits } from "./constants.js";
import { NotaryError } from "./errors.js";
import { admitAddresses, literalAddress, parseUrl, type PolicyOptions, type PolicyState } from "./policy.js";

export interface ResolvedAddress {
  address: string;
  family: number;
}

/** Test-only seams. Never reachable from requests, the CLI or MCP. */
export interface FetchInternals {
  resolve?: (hostname: string, family?: number) => Promise<ResolvedAddress[]>;
  /** Maps a validated address to the address actually dialed (tests dial loopback for "public" IPs). */
  mapConnectAddress?: (address: string) => string;
}

export interface FetchOptions {
  policy: PolicyOptions;
  limits: Limits;
  userAgent: string;
  /** Total deadline and runner shutdown. */
  signal: AbortSignal;
  maxBodyBytes: number;
  maxRedirects: number;
  initialSawPublic?: boolean;
  internals?: FetchInternals;
}

export interface FetchedResponse {
  url: URL;
  status: number;
  /** Lowercased names; set-cookie is never kept. */
  headers: Record<string, string[]>;
  body: Uint8Array;
  redirects: { url: string; status: number }[];
  /** True when the final host resolved to public addresses only (for follow-up same-origin fetches). */
  sawPublic: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DROPPED_HEADERS = new Set(["set-cookie", "set-cookie2", "authorization", "proxy-authenticate"]);

export async function defaultResolve(hostname: string, family?: number): Promise<ResolvedAddress[]> {
  const opts: { all: true; family?: number } = { all: true };
  if (family === 4 || family === 6) opts.family = family;
  return dnsLookup(hostname, opts);
}

function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur !== undefined && cur !== null; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

function errorCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

function toNotaryError(err: unknown, signal: AbortSignal): NotaryError {
  const chain = causeChain(err);
  const typed = chain.find((e): e is NotaryError => e instanceof NotaryError);
  if (typed) return typed;
  if (signal.aborted) {
    const reason = signal.reason as { name?: string } | undefined;
    if (reason?.name === "TimeoutError") return new NotaryError("TIMEOUT", "request exceeded its time limit", { cause: err });
    return new NotaryError("NETWORK_ERROR", "request was aborted", { cause: err });
  }
  const codes = chain.map(errorCode).filter((c): c is string => c !== undefined);
  if (codes.some((c) => c === "ENOTFOUND" || c === "EAI_AGAIN" || c === "EAI_NODATA" || c === "EAI_FAIL")) {
    return new NotaryError("DNS_FAILURE", "DNS lookup failed", { cause: err });
  }
  if (codes.some((c) => c.startsWith("UND_ERR_") && c.endsWith("TIMEOUT")) || codes.includes("ETIMEDOUT")) {
    return new NotaryError("TIMEOUT", "request timed out", { cause: err });
  }
  if (codes.includes("UND_ERR_HEADERS_OVERFLOW")) {
    return new NotaryError("NETWORK_ERROR", "response headers too large", { cause: err });
  }
  return new NotaryError("NETWORK_ERROR", `network error${codes[0] ? ` (${codes[0]})` : ""}`, { cause: err });
}

function makeLookup(policy: PolicyOptions, state: PolicyState, internals: FetchInternals | undefined) {
  const resolve = internals?.resolve ?? defaultResolve;
  return (hostname: string, options: { family?: number | string; all?: boolean }, cb: (...args: unknown[]) => void): void => {
    const family = typeof options.family === "number" ? options.family : undefined;
    resolve(hostname, family)
      .then((answers) => {
        admitAddresses(answers.map((a) => a.address), policy, state);
        const dial = answers.map((a) => {
          const address = internals?.mapConnectAddress?.(a.address) ?? a.address;
          return { address, family: isIP(address) || a.family };
        });
        if (options.all) cb(null, dial);
        else cb(null, dial[0]!.address, dial[0]!.family);
      })
      .catch((err: unknown) => cb(err));
  };
}

function headerRecord(raw: Record<string, string | string[] | undefined>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (DROPPED_HEADERS.has(key) || value === undefined) continue;
    out[key] = Array.isArray(value) ? value : [value];
  }
  return out;
}

class ByteCap extends Transform {
  private seen = 0;
  constructor(private readonly max: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.seen += chunk.length;
    if (this.seen > this.max) cb(new NotaryError("BODY_TOO_LARGE", `response body exceeds ${this.max} bytes`));
    else cb(null, chunk);
  }
}

async function readBody(body: Readable, encoding: string, max: number, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  const decoder =
    encoding === "gzip" || encoding === "x-gzip" ? createGunzip()
    : encoding === "deflate" ? createInflate()
    : encoding === "br" ? createBrotliDecompress()
    : null;
  try {
    if (decoder) await pipeline(body, new ByteCap(max), decoder, new ByteCap(max), sink, { signal });
    else await pipeline(body, new ByteCap(max), sink, { signal });
  } catch (err) {
    if (err instanceof NotaryError) throw err;
    if (decoder && errorCode(err)?.startsWith("Z_")) throw new NotaryError("NETWORK_ERROR", "response body is not valid compressed data", { cause: err });
    throw err;
  }
  return Buffer.concat(chunks);
}

/** destroy() emits an 'error' event; without a listener it would crash the process. */
function discard(body: Readable): void {
  body.on("error", () => undefined);
  body.destroy();
}

interface HopResult {
  status: number;
  headers: Record<string, string[]>;
  body: Uint8Array | null;
}

async function fetchHop(url: URL, opts: FetchOptions, state: PolicyState): Promise<HopResult> {
  const { limits } = opts;
  const literal = literalAddress(url.hostname);
  if (literal) admitAddresses([literal], opts.policy, state);

  const hopSignal = AbortSignal.any([opts.signal, AbortSignal.timeout(limits.hopTimeoutMs)]);
  const agent = new Agent({
    connections: 1,
    pipelining: 0,
    keepAliveTimeout: 1,
    maxHeaderSize: limits.maxHeaderBytes,
    headersTimeout: limits.hopTimeoutMs,
    bodyTimeout: limits.hopTimeoutMs,
    connect: {
      timeout: limits.hopTimeoutMs,
      lookup: makeLookup(opts.policy, state, opts.internals) as never,
    },
  });
  try {
    const res = await request(url, {
      dispatcher: agent,
      method: "GET",
      signal: hopSignal,
      headers: {
        "user-agent": opts.userAgent,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
      },
    });
    const headers = headerRecord(res.headers);
    const location = headers["location"]?.[0];
    if (REDIRECT_STATUSES.has(res.statusCode) && location !== undefined) {
      discard(res.body);
      return { status: res.statusCode, headers, body: null };
    }
    const encoding = (headers["content-encoding"]?.[0] ?? "identity").trim().toLowerCase();
    if (!["identity", "", "gzip", "x-gzip", "deflate", "br"].includes(encoding)) {
      discard(res.body);
      throw new NotaryError("NETWORK_ERROR", "unsupported content-encoding");
    }
    const declared = Number(headers["content-length"]?.[0]);
    if (Number.isFinite(declared) && declared > opts.maxBodyBytes) {
      discard(res.body);
      throw new NotaryError("BODY_TOO_LARGE", `response body exceeds ${opts.maxBodyBytes} bytes`);
    }
    const body = await readBody(res.body, encoding, opts.maxBodyBytes, hopSignal);
    return { status: res.statusCode, headers, body };
  } catch (err) {
    throw toNotaryError(err, hopSignal);
  } finally {
    await agent.destroy().catch(() => undefined);
  }
}

/** GET with manual redirects; every hop is re-validated. Throws NotaryError on any operational failure. */
export async function fetchPage(target: string, opts: FetchOptions): Promise<FetchedResponse> {
  const state: PolicyState = { sawPublic: opts.initialSawPublic ?? false };
  let current = parseUrl(target, "target", opts.limits.maxUrlLength, opts.policy);
  const visited = new Set<string>();
  const redirects: { url: string; status: number }[] = [];

  for (;;) {
    const key = current.href.split("#")[0] ?? current.href;
    if (visited.has(key)) throw new NotaryError("REDIRECT_LOOP", "redirect loop detected");
    visited.add(key);

    const hop = await fetchHop(current, opts, state);
    const location = hop.headers["location"]?.[0];
    if (REDIRECT_STATUSES.has(hop.status) && location !== undefined) {
      if (redirects.length >= opts.maxRedirects) {
        throw new NotaryError("TOO_MANY_REDIRECTS", `more than ${opts.maxRedirects} redirects`);
      }
      redirects.push({ url: current.href, status: hop.status });
      if (location.length > opts.limits.maxUrlLength) throw new NotaryError("REDIRECT_INVALID", "redirect Location is too long");
      let next: string;
      try {
        next = new URL(location, current).href;
      } catch {
        throw new NotaryError("REDIRECT_INVALID", "redirect Location is not a valid URL");
      }
      current = parseUrl(next, "redirect", opts.limits.maxUrlLength, opts.policy);
      continue;
    }
    return { url: current, status: hop.status, headers: hop.headers, body: hop.body ?? new Uint8Array(0), redirects, sawPublic: state.sawPublic };
  }
}
