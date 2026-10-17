# SEO Notary

Verify what a web page actually returns, so a coding agent (or a CI job) can fix problems and prove the fix.

SEO Notary fetches a URL, runs deterministic rules over the HTTP response and HTML, and returns structured evidence. It does not call an LLM, crawl sites, or upload code.

> **Status: pre-alpha.** Nothing is published to npm yet. APIs and rule output may change before 0.1.0.

## Status

| Component                                                                   | State                    |
| --------------------------------------------------------------------------- | ------------------------ |
| `seo-notary-core`: 14 HTTP/HTML rules, URL and network policy, typed errors | implemented, unpublished |
| `seo-notary-browser`: rendered-DOM checks via Playwright                    | in development           |
| `seo-notary` CLI (`verify`, `rules`, `doctor`, `install-browser`, `mcp`)    | in development           |
| Local MCP server (`verify_url`, `get_rule_catalog`)                         | in development           |
| Demo, CI matrix, npm release                                                | in development           |

## What it checks

HTTP status, redirect chain, content type, title, meta description, canonical link, robots directives (meta and `X-Robots-Tag`) and JSON-LD syntax. It reports measured signals only and makes no claims about indexing or ranking.

## Development

Requires Node `>=22.19.0`.

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run test:security
```

## Documentation

- Architecture decisions: [docs/adr](docs/adr/)
- Core library: [packages/core](packages/core/README.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Security policy: [SECURITY.md](SECURITY.md)
- Trademark policy: [TRADEMARK.md](TRADEMARK.md)

## License

Source code in this repository is released under the [MIT License](LICENSE). The Raxocode and SEO Notary names and logos are not covered by that license; see [TRADEMARK.md](TRADEMARK.md).

Built by [Raxocode](https://raxocode.com).
