# Architecture

```
packages/
  core/      Schemas, URL and network policy, bounded fetcher, HTML parsing, rules, reports. No browser dependency.
  browser/   Optional Playwright adapter. Depends on core.
  cli/       The `seo-notary` binary and the local MCP server. Depends on core; loads browser lazily.
```

Dependencies point one way: `core` <- `browser` <- `cli`. `core` imports nothing from its siblings and `cli` imports `seo-notary-browser` only when a browser job is requested, so a Tier 1 run never loads Playwright (covered by a test that traces module resolution).

## Request flow

1. The request is validated with a strict Zod schema; unknown keys are rejected. Hard limits are constants, not request fields.
2. `LocalRunner` fetches the URL with undici. Redirects are followed manually, and each hop re-runs URL and address policy. Bodies are read with a byte cap on both the compressed and decoded stream.
3. The HTML is parsed with parse5 and the Tier 1 rules run over the raw snapshot.
4. For `tier: "browser"`, a `BrowserCollector` (implemented by `seo-notary-browser`) renders the page and returns a bounded snapshot. The raw-vs-rendered comparison is pure code in `core`, so the rules are testable without a browser.
5. The report is assembled, sorted, validated against `ReportSchema` and returned. Operational problems throw a typed `NotaryError` instead.

`core` exposes a `Runner` interface (`verify(request) -> Report`) with `LocalRunner` as the only implementation. The CLI and MCP server depend on that interface shape, not on how the page is fetched.

## Network policy

Two profiles share one code path.

- `local` (default): the initial target may be loopback, private or CGNAT. Link-local, cloud-metadata, unspecified, multicast and reserved addresses are blocked unless `--allow-link-local` is set (link-local and metadata only).
- `strict`: public addresses only, ports 80 and 443 only, `localhost`, `*.localhost` and `*.local` rejected by name.
- Both: no userinfo, http(s) only, every address of a DNS answer must be allowed, and a redirect can never move from a public host to a non-public address.

Addresses are checked inside undici's connect-time `lookup`, and the validated answer is the address connected to. See [ADR 0004](adr/0004-network-policy-profiles.md) and [ADR 0006](adr/0006-undici-connect-lookup.md).

## Browser adapter

One warm Chromium process serves sequential jobs; each job gets a fresh context that is closed in `finally`. After a configurable number of jobs (default 50) the process is drained and replaced. A disconnected or wedged browser is never reused. The wait strategy is `domcontentloaded` plus a short settle delay, never `networkidle`.

Request interception applies the same policy to the main frame and subresources, but it is best effort: Chromium resolves DNS itself and follows redirects internally, so only the first hop is checked before sending. See [packages/browser/README.md](../packages/browser/README.md).

## Testing

| Command | Scope |
|---|---|
| `npm test` | Unit and integration tests against local mock servers |
| `npm run test:security` | Network policy and redirect tests with an injected resolver; no external hosts |
| `npm run test:browser` | Chromium tests: raw vs rendered, recycling, hangs, crashes, demo loop, CLI and MCP browser tier |
| `npm run test:smoke` | Packs the three packages, installs them into an empty directory, and checks Tier 1 downloads no browser |

Decisions are recorded in [docs/adr](adr/).
