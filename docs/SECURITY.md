# Threat model

SEO Notary is a local tool. It fetches URLs that the user (or the user's coding agent) chooses and returns evidence. This document describes what it defends against, how, and where the defenses stop. It is a description of the design, not an audit result.

## Assets and trust boundaries

- The machine and network the tool runs on, including services on `localhost` and private networks.
- The user's agent, which consumes tool output as context.
- Untrusted input: the URL, DNS answers, redirects, response headers and bodies, and everything a page does in the browser (titles, console messages, scripts, subresources).

## Threats and controls

| Threat | Control | Limit |
|---|---|---|
| SSRF: a public page redirects the tool to an internal address | Manual redirect handling with per-hop policy; no redirect may move from public to non-public, in both profiles | Browser tier only checks later redirect hops after the fact (see below) |
| SSRF via IP encodings (decimal, octal, hex, IPv4-mapped IPv6) | URL parsing normalizes hosts; classification covers IPv4, IPv6, mapped, NAT64 and 6to4 forms | |
| DNS rebinding | Addresses are validated inside the connect `lookup`; the validated answer is the connect target; all addresses in an answer must be allowed | Browser tier cannot pin Chromium's own DNS lookup |
| Cloud metadata endpoints | Link-local and known metadata addresses blocked in `local` unless explicitly allowed; blocked in `strict` | |
| Resource exhaustion | Caps on URL length, redirects, header size, body bytes (compressed and decoded), time per hop and in total, console and failed-request counts, screenshot bytes | Limits are constants; they are not tuned for hostile multi-tenant use |
| Prompt injection through page content | Output strings are stripped of control and bidirectional characters and length-bounded; tool descriptions label page text as untrusted evidence; remediation text is advice, never a command | A downstream agent can still be misled by text it chooses to trust |
| Credential or cookie leakage | No cookies, credentials, proxies or custom headers are sent or accepted; `Set-Cookie` is dropped; query values are redacted in redirect chains and failed requests | `target_url` and `final_url` are echoed as given |
| Hostile pages in the browser | Fresh context per job, service workers blocked, downloads and permissions off, hard deadlines, wedged browsers replaced | Playwright launches Chromium with its OS sandbox disabled by default, so a browser exploit is not contained by that sandbox; WebSocket traffic is not intercepted |
| Arbitrary file or protocol access | Only `http` and `https`; `file:`, `ftp:`, `javascript:` and others rejected | |

## What this does not provide

- It is not an OS-level egress filter. Anything that must be isolated from internal services needs network controls outside this tool.
- The `local` profile deliberately allows internal targets so agents can verify dev servers. Do not expose it as a service to untrusted callers.
- No hosted service exists. A hosted runner would need separate authentication, quotas and network isolation and is out of scope for this repository.
- No third-party security audit has been performed.

## Reporting

See [SECURITY.md](../SECURITY.md).
