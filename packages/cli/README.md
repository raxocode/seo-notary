# seo-notary

Verify what a web page really returns over HTTP and in a real browser. A CLI and local MCP server for coding agents and CI.

```bash
seo-notary verify http://localhost:3000/                 # raw HTTP and HTML, no browser
seo-notary verify http://localhost:3000/ --tier browser  # also compare raw vs rendered DOM
seo-notary verify <url> --format json                    # one JSON document on stdout
seo-notary rules                                         # list the 23 rules
seo-notary doctor                                        # check Node and browser setup
seo-notary install-browser                               # download Chromium for --tier browser
seo-notary mcp                                           # MCP server on stdio
```

Exit codes: `0` pass, `1` findings at or above `--fail-on`, `2` operational failure.

Documentation: [CLI](https://github.com/raxocode/seo-notary/blob/main/docs/CLI.md), [MCP](https://github.com/raxocode/seo-notary/blob/main/docs/MCP.md), [Rules](https://github.com/raxocode/seo-notary/blob/main/docs/RULES.md).
