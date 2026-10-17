# Rules

Rule IDs are a stable public contract: they are not renamed without a deprecation period. Severity is the default; a rule can emit a different severity where noted. Every finding reports measured signals only and makes no claim about indexing or ranking.

Use `seo-notary rules` or the `get_rule_catalog` MCP tool to list these from the installed version.

Pass `--fail-on error|warning|info` to choose which severity fails a run (default `error`).

## Tier 1: raw HTTP and HTML

| Rule | Default | What it checks | What it does not prove |
|---|---|---|---|
| `HTTP_STATUS` | error | Final HTTP status of the page. 5xx/404/410/other 4xx are errors; 401/403 are warnings. | Describes only the response received by this client without credentials. |
| `HTTP_REDIRECT_CHAIN` | warning | Number of redirects followed before the final response: 2 is info, 3 or more is a warning. | A single redirect is not reported. Query values are redacted in evidence. |
| `NON_HTML_CONTENT` | info | Response is not HTML, so HTML rules were skipped. HTTP facts are still reported. | Content type comes from the Content-Type header (or a short sniff when it is absent). |
| `HTML_TITLE_MISSING` | error | No <title> element, or its text is empty or whitespace-only. | Checks the raw HTML only; a script may add a title later (use the browser tier). |
| `HTML_TITLE_LENGTH` | info | Title is shorter or longer than advisory bounds (10 and 70 characters by default). | Advisory heuristic only; makes no claim about how any search engine truncates titles. |
| `META_DESCRIPTION_MISSING` | warning | No <meta name="description"> with non-empty content. | Raw HTML only. |
| `CANONICAL_MISSING` | warning | No <link rel="canonical"> in the raw HTML. | A canonical link is not mandatory on every page. |
| `CANONICAL_MULTIPLE` | error | Multiple canonical links whose resolved targets differ. | Identical duplicates are not reported. |
| `CANONICAL_INVALID` | error | Canonical href is missing, empty, malformed, or not http(s). | Resolved against <base href> when present, else the final URL. |
| `CANONICAL_CROSS_ORIGIN` | warning | Canonical points to a different origin than the final URL. | May be intentional (syndication, domain migration). |
| `CANONICAL_MISMATCH` | info | Same-origin canonical differs from the final URL (fragment ignored). | Often legitimate (tracking parameters, trailing slash). Cross-origin canonicals are reported by CANONICAL_CROSS_ORIGIN instead. |
| `ROBOTS_NOINDEX` | warning | A noindex or none directive in meta robots or the X-Robots-Tag header. | Does not prove the page is or is not indexed. |
| `JSON_LD_INVALID` | error | A JSON-LD script block that is empty or is not valid JSON. | JSON syntax only; no schema.org semantic validation. |
| `ROBOTS_TXT_UNAVAILABLE` | info | Only with check_robots_txt: /robots.txt on the same origin did not return a 2xx response. | A missing robots.txt is legal. The file content is not evaluated. |

## Tier 2: browser (--tier browser)

| Rule | Default | What it checks | What it does not prove |
|---|---|---|---|
| `RENDER_TITLE_DIFFERS` | error | Raw HTML has a title, but the rendered DOM title is different (for example a client-side overwrite). | Compares the title after domcontentloaded plus a short settle delay; later changes are not seen. |
| `RENDER_TITLE_CLIENT_ONLY` | warning | Raw HTML has no title, but the rendered DOM has one. | Clients that do not run JavaScript will not see this title. |
| `RENDER_CANONICAL_DIFFERS` | error | Canonical link differs between raw HTML and the rendered DOM (including added or removed). | Compares resolved absolute URLs of the first canonical link. |
| `RENDER_ROBOTS_DIFFERS` | warning | Meta robots directives differ between raw HTML and the rendered DOM. Error when the rendered DOM adds noindex. | X-Robots-Tag headers cannot change client-side and are not part of this comparison. |
| `RENDER_DESCRIPTION_DIFFERS` | warning | Meta description differs between raw HTML and the rendered DOM. | Compares whitespace-collapsed content of the first description meta tag. |
| `HYDRATION_ERROR_DETECTED` | error | A console or page error matches a known framework hydration message (React, Next.js, Vue, Svelte). | Pattern detection on error text only. It does not prove or measure a server/client markup mismatch. |
| `BROWSER_PAGE_ERROR` | error | Uncaught exception in the page (excluding messages already reported as hydration errors). | Only errors raised before the snapshot is taken are seen. The list is bounded. |
| `BROWSER_CONSOLE_ERROR` | warning | console.error output (excluding messages already reported as hydration errors). | Bounded count; message text is page-controlled and untrusted. |
| `BROWSER_REQUEST_FAILED` | warning | A subresource request failed or was blocked by the network policy. Query values are redacted. | In lean mode, requests blocked on purpose (images, media, fonts) are not reported. |

## Operational errors

These are not findings. A run that hits one produces no report and exits with code 2.

| Code | Meaning |
|---|---|
| `INVALID_INPUT` | Malformed request or arguments |
| `POLICY_BLOCKED` | The network policy refused the URL, a redirect, or an address |
| `DNS_FAILURE` | The host did not resolve |
| `TIMEOUT` | A hop, the navigation, or the total deadline was exceeded |
| `BODY_TOO_LARGE` | The response body exceeded the size cap (compressed or decoded) |
| `TOO_MANY_REDIRECTS` | More than 10 redirects |
| `REDIRECT_LOOP` | A redirect revisited a URL |
| `REDIRECT_INVALID` | A redirect `Location` was malformed or too long |
| `NETWORK_ERROR` | Connection refused or reset, oversized headers, unsupported encoding, browser crash |
| `BROWSER_UNAVAILABLE` | Browser tier requested but Chromium is missing or cannot start |
| `INTERNAL_ERROR` | Unexpected error |

If an HTTP response was received, even a 404 or 500, it is reported as a finding, not as an operational error.
