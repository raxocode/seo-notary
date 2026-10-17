# ADR 0009: Browser request interception and its limits

Status: accepted (2026-10-17)

Observed with Playwright 1.64.1 and Chromium headless shell 156:

- `context.route()` with `route.continue()` is invoked for the first request of a navigation only. Redirect hops are followed inside Chromium without another route callback, although the `request` event fires for each hop (checked with a small experiment).
- `request.frame()` throws for the initial navigation request because its frame does not exist yet. The adapter treats a navigation request without a frame as the main-frame navigation.

Decisions:

- Route handler: apply the shared URL policy (`admitUrl`) to the first hop of every request, abort blocked ones, and record them as failed requests ("blocked by network policy").
- Redirect hops are checked from the `request` event after the fact. A blocked main-frame redirect closes the page and the job fails with `POLICY_BLOCKED`, returning no content. A blocked subresource redirect is reported as a failed request. In both cases Chromium may already have sent the request.
- Subresource checks are relative to the main frame: the no-escalation rule applies only when the main frame resolved to public addresses, so a local dev page can still load public CDNs and local APIs.
- The Tier 1 fetch runs first with strict per-hop validation, so for servers that redirect consistently the chain is blocked before a browser starts.
- Not covered: Chromium's own DNS resolution, WebSocket traffic, and requests made by service workers (service workers are blocked).
- Playwright launches Chromium with its OS sandbox disabled by default; this is documented in the threat model rather than changed, because enabling it fails in many container environments.
- Fully preventing redirect-hop requests would require fulfilling every request through `route.fetch()`, which replaces the browser's network stack and changes rendering behavior. Not done.
