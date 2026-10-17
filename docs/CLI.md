# CLI

```
seo-notary verify <url> [options]
seo-notary rules [--format text|json]
seo-notary doctor [--format text|json]
seo-notary install-browser
seo-notary mcp
```

## verify

| Option | Meaning |
|---|---|
| `--tier http\|browser` | `http` (default) checks the raw response. `browser` also renders the page in Chromium and compares raw vs rendered. |
| `--mode lean\|faithful` | Browser tier only. `faithful` (default) loads everything; `lean` blocks images, media and fonts. Neither is pixel-accurate. |
| `--format text\|json` | `text` (default) is for people. `json` writes exactly one JSON document to stdout. |
| `--out <file>` | Also writes the JSON report to a file (parent directories are created, an existing file is overwritten). Stdout still follows `--format`. A write failure exits 2. |
| `--fail-on error\|warning\|info` | Lowest severity that makes the run fail. Default `error`. |
| `--timeout-ms <n>` | Total time budget, 1000 to 120000. Default 30000. |
| `--policy local\|strict` | `local` (default) allows `localhost` and private hosts. `strict` allows public hosts on ports 80 and 443 only. |
| `--allow-link-local` | `local` policy only: also allow link-local and cloud-metadata addresses. |
| `--check-robots-txt` | Also check that `/robots.txt` on the final origin responds. |
| `--screenshot` | Browser tier: include a byte-capped PNG (base64) in the JSON report. |

### Exit codes

| Code | Meaning |
|---|---|
| 0 | A report was produced and no finding is at or above `--fail-on`. |
| 1 | A report was produced and at least one finding is at or above `--fail-on`. |
| 2 | Operational failure: bad arguments, DNS or network error, timeout, size cap, policy block, browser unavailable, unexpected error. No report is produced. |

A received HTTP response is always a finding (exit 0 or 1), including 404 and 500. Connection failures and timeouts are exit 2.

### Output streams

- Diagnostics and error messages go to stderr. Stdout carries only the report (or `rules` / `doctor` output).
- With `--format json` and an operational error, stdout holds one JSON document `{"schema_version": "0.1.0", "error": {"code": "...", "message": "..."}}`, stderr holds the message, and the exit code is 2. Usage errors write to stderr only.
- Text output is colored only when stdout is a terminal and `NO_COLOR` is unset. Page-derived strings are stripped of control and bidirectional characters.

### Report shape

```jsonc
{
  "schema_version": "0.1.0",
  "target_url": "http://127.0.0.1:4173/broken",
  "status": "fail",
  "execution": { "tier": "browser", "mode": "faithful", "runner": "local", "duration_ms": 612, "redirects_followed": 0, "started_at": "2026-10-17T04:00:00.000Z" },
  "summary": { "passed": 18, "failed": 2, "warnings": 0, "info": 0 },
  "snapshots": { "raw_http": { "status": 200, "title": "Acme Widgets | ...", "canonical": "http://127.0.0.1:4173/broken", "...": "..." }, "rendered_dom": { "title": "Loading...", "...": "..." } },
  "findings": [
    {
      "rule_id": "RENDER_TITLE_DIFFERS",
      "severity": "error",
      "category": "rendering",
      "message": "The title changes after JavaScript runs.",
      "location": "head > title",
      "evidence": { "raw": "Acme Widgets | ...", "rendered": "Loading..." },
      "remediation": "Make the server-rendered title and the client-rendered title agree."
    }
  ]
}
```

`summary.passed` counts rules that ran and produced no finding. Findings are sorted by severity, then rule ID, then location. Only `execution.duration_ms`, `execution.started_at` and `rendered_dom.timings` vary between identical runs.

## doctor

Checks the Node version, prints the default policy, and launches Chromium once to confirm the browser tier can run. A missing browser is a warning, not a failure; only an unsupported Node version exits 2.

## install-browser

Runs Playwright's `install --only-shell chromium`. Tier 1 never needs it. On Linux the browser may also need OS libraries (for example `sudo npx playwright-core install-deps chromium`).

## Environment

SEO Notary v0.1 reads no environment variables of its own. `NO_COLOR` is respected, and Playwright's own `PLAYWRIGHT_BROWSERS_PATH` applies to the browser tier.
