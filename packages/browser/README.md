# seo-notary-browser

Optional Playwright adapter for SEO Notary. It loads a page in headless Chromium, snapshots the rendered DOM, and lets `seo-notary-core` compare it with the raw HTTP response (`RENDER_*`, `HYDRATION_ERROR_DETECTED` and `BROWSER_*` rules).

> Pre-alpha, unpublished.

```ts
import { LocalRunner } from "seo-notary-core";
import { BrowserManager } from "seo-notary-browser";

const browser = new BrowserManager();
const runner = new LocalRunner({ browser });
const report = await runner.verify({ target_url: "http://localhost:3000/", tier: "browser" });
await runner.close();
await browser.close();
```

Install the browser once with `installBrowser()` (or `seo-notary install-browser`). It runs Playwright's documented `install --only-shell chromium`. If the bundled shell is missing, a system Chrome (`channel: "chrome"`) is tried; that fallback has not been verified in this repository's tests.

## Behaviour

- One warm browser process is reused across sequential jobs; each job gets a fresh `BrowserContext` that is closed in `finally`. After `maxJobsPerBrowser` jobs (default 50) the process is drained and replaced. A disconnected or wedged browser is never reused.
- Wait strategy: `domcontentloaded` plus a short settle delay (500 ms by default). Never `networkidle`.
- Modes: `faithful` (default) loads everything; `lean` blocks images, media and fonts and records that in `blocked_resource_classes`. Neither is pixel-accurate.
- Service workers are blocked, downloads and permissions are disabled, and the user agent is `Mozilla/5.0 (compatible; SEO-Notary; +https://seonotary.com)`.
- Collected data is bounded: console errors, page errors and failed requests are capped, query values in failed-request URLs are redacted, control characters are stripped, and the optional PNG screenshot is byte-capped.
- Failure to reach `domcontentloaded`, a total timeout, a policy block, DNS failure or a browser crash raise a typed `NotaryError`; they never produce a passing report.

## Network policy limits

The browser resolves and connects on its own, so the policy check is best effort:

- Requests are checked in an interception handler before they are sent. DNS answers can still change between that check and Chromium's own lookup.
- Chromium follows redirects internally, so only the first hop is checked before sending. Later redirect hops are checked afterwards: a blocked main-frame redirect fails the job and returns no content, but the request may already have been sent. The Tier 1 fetch runs first and blocks such chains before the browser starts, for the common case where the server redirects consistently.
- WebSocket traffic is not intercepted.

Treat this as defense in depth, not as an isolation boundary. Do not point it at untrusted pages on a machine with sensitive internal services unless you use the `strict` policy and OS-level egress controls.
