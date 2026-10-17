# ADR 0001: Report status semantics

Status: accepted (2026-10-17)

- `status` is derived only: `fail` iff any finding has severity >= `fail_on`, otherwise `pass`.
- Operational problems (bad input, policy block, DNS failure, timeout, body cap, too many redirects, browser unavailable, unexpected error) are typed errors and never produce a report.
- If an HTTP response was received (including 404/500) that is a finding, not an operational error.
- Exit codes: 0 pass, 1 fail, 2 operational error.
