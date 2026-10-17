# SEO Notary

**Verify what a web page really returns, so your coding agent can fix it and prove it.**

HTTP and real-browser checks for Claude Code, Cursor, VS Code and CI. Deterministic. No LLM. One command.

> **Status: 0.1 (early release).** APIs, rule output and rule severities may still change between 0.x releases; see the [changelog](CHANGELOG.md).

Coding agents edit page code but cannot see what the page actually serves. Client-side scripts overwrite titles and canonicals, server rendering breaks, redirects bounce, and the agent reports "done" without evidence. SEO Notary fetches the page, runs deterministic rules over the response and the rendered DOM, and returns structured findings with stable exit codes.

```text
$ seo-notary verify http://127.0.0.1:4173/broken --tier browser
FAIL http://127.0.0.1:4173/broken
tier browser (faithful), 1153 ms, 0 redirects, HTTP 200
  title        Acme Widgets | Handmade widgets for every workshop
  canonical    http://127.0.0.1:4173/broken
  rendered DOM
  title        Loading...
  canonical    https://staging.acme.example/broken

2 errors, 0 warnings, 0 info; 20 rules passed

ERROR   RENDER_TITLE_DIFFERS  head > title
  The title changes after JavaScript runs.
  raw:      Acme Widgets | Handmade widgets for every workshop
  rendered: Loading...
  fix: Make the server-rendered title and the client-rendered title agree.
$ echo $?
1
```

That output is abridged from a real run of the [demo](demo/) in this repository. Remove the script that rewrites the title and canonical and the same command prints `PASS` and exits 0.

## Quickstart

Requires Node `>=22.19.0`.

```bash
# Tier 1: raw HTTP and HTML. No browser, nothing to download.
npx seo-notary verify http://localhost:3000/

# Tier 2: also render the page in Chromium and compare raw vs rendered.
npx seo-notary install-browser
npx seo-notary verify http://localhost:3000/ --tier browser
```

To run from a checkout instead: `npm install && npm run build`, then `node packages/cli/dist/bin.js verify <url>`.

Exit codes: `0` pass, `1` findings at or above `--fail-on` (default `error`), `2` operational failure (bad input, network, timeout, policy, browser). Use `--format json` for exactly one JSON document on stdout. Details: [docs/CLI.md](docs/CLI.md).

## Use it from an agent

`seo-notary mcp` runs a local MCP server over stdio with two tools: `verify_url` and `get_rule_catalog`. `verify_url` returns the full report as structured content plus a short summary, in one call. See [docs/MCP.md](docs/MCP.md) for what has and has not been tested, and for an `AGENTS.md` snippet that tells agents to verify after frontend changes.

## What it checks

HTTP status, redirect chain, content type, title, meta description, canonical link, robots directives (meta and `X-Robots-Tag`) and JSON-LD syntax in the raw response. With `--tier browser`: whether the title, canonical, robots meta and description change after JavaScript runs, framework hydration error messages, uncaught page errors, console errors and failed requests. 23 rules in total: [docs/RULES.md](docs/RULES.md). Each lists what it does not prove.

## What it does not do

- No crawling, rank tracking, keyword or backlink data, and no claims about indexing or ranking. It reports measured signals only.
- No LLM calls and no code uploads. It fetches the URL you give it.
- No hosted service. It runs on your machine.
- "Hydration error detected" is pattern matching on console messages, not proof of a markup mismatch.
- The browser tier is not pixel-accurate in either mode.

## Security

Page content is untrusted evidence: output strings are stripped of control characters and length-bounded, and nothing in a page is ever treated as an instruction. Two network profiles exist. `local` (default) lets you verify `localhost` and private hosts; `strict` allows public hosts only. A redirect can never move from a public host to a private address. Limits and caveats, including the browser tier's best-effort interception, are in [docs/SECURITY.md](docs/SECURITY.md). To report a vulnerability see [SECURITY.md](SECURITY.md). No third-party security audit has been performed.

## Packages

| Package | Purpose |
|---|---|
| [`seo-notary`](packages/cli) | CLI and local MCP server |
| [`seo-notary-core`](packages/core) | Schemas, network policy, fetcher, rules, reports. No browser dependency |
| [`seo-notary-browser`](packages/browser) | Optional Playwright adapter |

## Development

Requires Node `>=22.19.0`.

```bash
npm install
npm run build
npm run typecheck && npm run lint
npm test                 # unit and integration
npm run test:security    # network policy
npm run test:browser     # needs Chromium: npx playwright-core install --only-shell chromium
npm run test:smoke       # packs and installs the packages into an empty directory
npm run demo             # serves the broken/fixed demo on http://127.0.0.1:4173
```

Docs: [Architecture](docs/ARCHITECTURE.md), [CLI](docs/CLI.md), [MCP](docs/MCP.md), [Rules](docs/RULES.md), [Threat model](docs/SECURITY.md), [Decisions](docs/adr/). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Source code is released under the [MIT License](LICENSE). The Raxocode and SEO Notary names and logos are not covered by that license; see [TRADEMARK.md](TRADEMARK.md).

Built by [Raxocode](https://raxocode.com). Project site: [seonotary.com](https://seonotary.com).
