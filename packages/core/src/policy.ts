import { isIP } from "node:net";
import { classifyAddress, type AddressClass } from "./ip.js";
import { NotaryError } from "./errors.js";

export type PolicyProfile = "local" | "strict";

export interface PolicyOptions {
  profile: PolicyProfile;
  /** local profile only: also allow link-local and cloud-metadata addresses. */
  allowLinkLocal?: boolean;
  /** strict profile only; defaults to 80 and 443. */
  allowedPorts?: readonly number[];
}

/** Mutable per-fetch state used by the no-escalation rule. */
export interface PolicyState {
  sawPublic: boolean;
}

export type UrlKind = "target" | "redirect";

const LOCAL_ALLOWED: ReadonlySet<AddressClass> = new Set(["loopback", "private", "cgnat"]);
const DEFAULT_STRICT_PORTS: readonly number[] = [80, 443];

export function literalAddress(hostname: string): string | null {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return isIP(bare) !== 0 ? bare : null;
}

function isLocalName(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local");
}

/** Parses and checks scheme, length, userinfo, host name and port. Does not resolve DNS. */
export function parseUrl(raw: string, kind: UrlKind, maxLength: number, policy: PolicyOptions): URL {
  const fail = (code: "INVALID_INPUT" | "REDIRECT_INVALID" | "POLICY_BLOCKED", msg: string): never => {
    throw new NotaryError(code, msg);
  };
  const badCode = kind === "target" ? "INVALID_INPUT" : "REDIRECT_INVALID";
  if (raw.length === 0 || raw.length > maxLength) fail(badCode, `URL is empty or longer than ${maxLength} characters`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(badCode, "URL is not an absolute, well-formed URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail(kind === "target" ? "INVALID_INPUT" : "POLICY_BLOCKED", `scheme ${url.protocol} is not allowed; only http and https`);
  }
  if (url.username !== "" || url.password !== "") fail("POLICY_BLOCKED", "URLs with credentials (userinfo) are not allowed");
  if (url.hostname === "") fail(badCode, "URL has no host");
  if (policy.profile === "strict") {
    if (isLocalName(url.hostname)) fail("POLICY_BLOCKED", "strict policy blocks localhost and .local names");
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    if (!(policy.allowedPorts ?? DEFAULT_STRICT_PORTS).includes(port)) {
      fail("POLICY_BLOCKED", `strict policy blocks port ${port}`);
    }
  }
  return url;
}

/**
 * Checks every resolved address against the profile and the no-escalation rule.
 * Records whether this hop was fully public. Throws POLICY_BLOCKED when any address is not allowed.
 */
export function admitAddresses(addresses: readonly string[], policy: PolicyOptions, state: PolicyState): void {
  if (addresses.length === 0) throw new NotaryError("DNS_FAILURE", "host resolved to no addresses");
  let allPublic = true;
  for (const address of addresses) {
    const cls = classifyAddress(address);
    if (cls === "public") continue;
    allPublic = false;
    if (policy.profile === "strict") {
      throw new NotaryError("POLICY_BLOCKED", `strict policy blocks ${cls} address ${address}`);
    }
    if (state.sawPublic) {
      throw new NotaryError("POLICY_BLOCKED", `redirect from a public host to a non-public address (${cls}) is blocked`);
    }
    const allowed = LOCAL_ALLOWED.has(cls) || ((cls === "link_local" || cls === "metadata") && policy.allowLinkLocal === true);
    if (!allowed) {
      const hint = cls === "link_local" || cls === "metadata" ? "; pass allowLinkLocal to override" : "";
      throw new NotaryError("POLICY_BLOCKED", `policy blocks ${cls} address ${address}${hint}`);
    }
  }
  if (allPublic) state.sawPublic = true;
}
