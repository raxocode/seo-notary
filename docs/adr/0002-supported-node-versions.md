# ADR 0002: Supported Node versions

Status: accepted (2026-10-17)

- `engines.node` is `>=22.19.0` (undici 8.12.2 declares `>=22.19.0`; Node 20 is EOL).
- CI matrix target: 22, 24, 26. Primary dev/Docker image: Node 24. Revisit the floor in 2027 (Node 22 EOL 2027-04-30).
- Verified locally so far: Node 22.22.2 only. Node 24/26 are unverified until CI exists.
- Vitest 5.0.5 supports `^22.12.0 || ^24.0.0 || >=26.0.0`.
