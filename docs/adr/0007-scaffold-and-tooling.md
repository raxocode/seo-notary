# ADR 0007: Scaffold state and tooling

Status: accepted (2026-10-17)

- The repository was created from scratch; there was no prior scaffold to inherit.
- Tooling: npm workspaces, TypeScript strict (NodeNext), Vitest 5.0.5 (projects `unit`, `security`), ESLint 10 + typescript-eslint 8.71.2.
- Installed TypeScript is 6.0.3, not the registry `latest` (7.0.2): typescript-eslint 8.71.2 constrains its peer range below 6.1. Revisit when typescript-eslint supports TS 7.
- HTML parser: parse5 8.0.1 (spec-compliant tree building, same recovery behavior as browsers).
- Request schema addition to the original request contract: optional `check_robots_txt` boolean (needed for the `--check-robots-txt` CLI flag and `ROBOTS_TXT_UNAVAILABLE`).
