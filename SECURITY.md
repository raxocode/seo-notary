# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to engineering@raxocode.com, or through [GitHub private vulnerability reporting](https://github.com/raxocode/seo-notary/security/advisories/new). Do not open public issues for security problems.

Include the affected version, a description of the impact, and reproduction steps. We aim to acknowledge reports promptly and will coordinate disclosure with you.

## Supported versions

The project is pre-release. Only the latest commit on `main` receives fixes.

## Scope

SEO Notary is a local tool: it fetches URLs chosen by the user and returns evidence. In scope are bypasses of its network policy (for example, reaching a blocked address class via redirects, DNS answers or IP encodings), unbounded resource use, and unsafe handling of page-derived content in output. Network policy behaviour is described in [docs/adr/0004-network-policy-profiles.md](docs/adr/0004-network-policy-profiles.md).
