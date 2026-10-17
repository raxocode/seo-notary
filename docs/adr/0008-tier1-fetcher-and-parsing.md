# ADR 0008: Tier 1 fetcher and parsing decisions

Status: accepted (2026-10-17)

- One undici `Agent` per hop, destroyed in `finally`. Redirects are handled manually (undici does not follow them); every hop re-runs URL and address policy.
- `Accept-Encoding: gzip, deflate, br` is sent; bodies are decoded with Node zlib. The byte cap applies to both the compressed stream and the decoded output (decompression-bomb guard). Unknown encodings are an operational error.
- Discarded response bodies get a no-op `error` listener before `destroy()`; otherwise undici's AbortError crashes the process (found by test).
- Charset order: BOM, Content-Type, `<meta charset>` in the first 1024 bytes, else UTF-8 (not the HTML-spec windows-1252 default). Unknown labels fall back to UTF-8.
- HTML parsing uses parse5 with an explicit stack (no recursion), so deeply nested input cannot overflow the call stack.
- `redirect_chain` redacts query values; `final_url`, `target_url` and evidence are not redacted because they are the caller's own URLs.
- Robots meta: `robots` plus any `*bot` meta name (e.g. `googlebot:noindex`). `X-Robots-Tag` supports an optional `agent:` prefix.
- `ROBOTS_TXT_UNAVAILABLE` fetches `/robots.txt` on the final origin with at most 3 redirects and a 256 KiB cap; policy errors still abort the run, other failures become the finding.
- Test-only seams (`LocalRunnerOptions.internals`, `allowedPorts`) exist so "public" hosts can be simulated with a loopback server; they are not reachable from requests.
- Security tests were mutation-checked: disabling the no-escalation rule makes 8 of them fail.
