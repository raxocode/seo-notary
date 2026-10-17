# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-10-17

### Added

- `seo-notary-core`: request/report schemas, network policy (`local` and `strict`), bounded fetcher with manual redirect handling, HTML parsing, 14 Tier 1 rules and 9 browser-tier rules, typed operational errors.
- `seo-notary-browser`: Playwright adapter with a reused browser process, per-job contexts, recycling, `lean` and `faithful` modes and an optional byte-capped screenshot.
- `seo-notary`: CLI (`verify`, `rules`, `doctor`, `install-browser`, `mcp`) and a local MCP server with `verify_url` and `get_rule_catalog`.
- Demo fixture, CI workflow (Node 22, 24, 26), packaging smoke test, and `server.json` for the MCP Registry.
