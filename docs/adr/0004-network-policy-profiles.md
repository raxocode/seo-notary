# ADR 0004: Network policy profiles

Status: accepted (2026-10-17)

Two profiles share one code path: `local` (default for CLI/MCP) and `strict` (public internet only).

- `strict`: only addresses classified `public`; `localhost`, `*.localhost`, `*.local` rejected by name; default ports 80/443 only.
- `local`: classes `public`, `loopback`, `private`, `cgnat` are allowed for the initial target. `link_local`, `metadata`, `unspecified`, `multicast`, `reserved` are blocked. `link_local` and `metadata` can be allowed only with an explicit `allowLinkLocal` option (CLI `--allow-link-local`).
- Additional decision: `unspecified` (0.0.0.0, ::) is blocked in `local` because it is ambiguous; use `127.0.0.1`.
- No-escalation: once a hop resolved to all-public addresses, no later hop may resolve to any non-public address, in both profiles.
- Userinfo URLs and non-http(s) schemes are always rejected.
- Every address of a DNS answer must be allowed (mixed answers are rejected). The validated address is the one connected to (pinned via the connect `lookup` callback).
