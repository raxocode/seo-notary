# seo-notary-core

Browser-free Tier 1 engine for SEO Notary: fetch one URL over HTTP, run deterministic rules on the response, return a stable report. No LLM, no crawling, no browser, no network calls other than the target (and optionally its `/robots.txt`).

> 0.1 early release: the API may change between 0.x versions.

```ts
import { LocalRunner, NotaryError } from "seo-notary-core";

const runner = new LocalRunner();
try {
  const report = await runner.verify({
    target_url: "http://localhost:3000/",
    fail_on: "error",
  });
  console.log(report.status, report.findings);
} catch (err) {
  if (err instanceof NotaryError) console.error(err.code, err.message); // operational failure
} finally {
  await runner.close();
}
```

## Semantics

- `status` is `fail` iff any finding has severity at or above `fail_on` (default `error`); otherwise `pass`.
- If an HTTP response was received, even 404 or 500, that is a **finding**. DNS failure, timeouts, connection errors, policy blocks, size caps and invalid input throw a typed `NotaryError` and **never** produce a report.
- Operational codes: `INVALID_INPUT`, `POLICY_BLOCKED`, `DNS_FAILURE`, `TIMEOUT`, `BODY_TOO_LARGE`, `TOO_MANY_REDIRECTS`, `REDIRECT_LOOP`, `REDIRECT_INVALID`, `NETWORK_ERROR`, `BROWSER_UNAVAILABLE`, `INTERNAL_ERROR`. `tier: "browser"` throws `BROWSER_UNAVAILABLE` here.
- `summary.passed` counts rules that ran and produced no finding. HTML rules are skipped for non-HTML responses; `ROBOTS_TXT_UNAVAILABLE` runs only with `check_robots_txt: true`.
- Findings are sorted by severity, then `rule_id`, then `location`. Output is deterministic apart from `execution.duration_ms` and `started_at`.
- Page-derived strings are untrusted evidence: control and bidi characters are stripped and lengths are bounded. Query values in `redirect_chain` are replaced by `REDACTED`. The full body, cookies and auth headers are never stored; `Set-Cookie` is dropped.

## Request

`schema_version`, `target_url`, `tier`, `mode`, `rules`, `fail_on`, `policy`, `include_screenshot`, `check_robots_txt`. Unknown keys are rejected. Limits are constants (`DEFAULT_LIMITS`): URL 2048 chars, body 2 MiB (after decompression), 10 redirects, 32 KiB headers, 10 s per hop, 30 s total. There are no request fields for headers, cookies, proxies, scripts or files.

## Rules (Tier 1)

`HTTP_STATUS`, `HTTP_REDIRECT_CHAIN`, `NON_HTML_CONTENT`, `HTML_TITLE_MISSING`, `HTML_TITLE_LENGTH`, `META_DESCRIPTION_MISSING`, `CANONICAL_MISSING`, `CANONICAL_MULTIPLE`, `CANONICAL_INVALID`, `CANONICAL_CROSS_ORIGIN`, `CANONICAL_MISMATCH`, `ROBOTS_NOINDEX`, `JSON_LD_INVALID`, `ROBOTS_TXT_UNAVAILABLE`. Each rule's description and limitation is in `RULES`. Notable limits:

- Rules see the raw HTML only. Client-side changes need the browser tier.
- `HTML_TITLE_LENGTH` is an advisory heuristic, not a search-engine cutoff.
- `JSON_LD_INVALID` checks JSON syntax only.
- `ROBOTS_NOINDEX` reports directives; it does not prove indexability.
- Word count is whitespace-separated tokens in body text outside `script`, `style`, `noscript` and `template`; it undercounts languages written without spaces.
- Charset: BOM, then `Content-Type`, then `<meta charset>` in the first 1024 bytes, else UTF-8 (unknown labels fall back to UTF-8).
- 3xx responses without a `Location` header are treated as the final response.

## Network policy

Profiles `local` (default) and `strict`; see `docs/adr/0004-network-policy-profiles.md`.

- `strict`: public addresses only, ports 80/443 only, `localhost`/`*.localhost`/`*.local` rejected.
- `local`: loopback, private and CGNAT targets allowed for the initial URL; link-local, cloud-metadata, unspecified, multicast and reserved addresses blocked.
- Both: no userinfo, http(s) only, redirects handled manually with each hop revalidated, and a redirect can never move from a public host to a non-public address.
- Resolved IPs are checked inside undici's connect-time `lookup`; the validated answer is the one connected to. Every address in an answer must be allowed.

What this does not cover: it is a client-side check inside one process, not an OS-level egress filter, and it makes no claim of being security audited.

## Test seams

`LocalRunnerOptions.internals` (custom resolver, connect-address mapping) exists for tests only and is not reachable from requests.
