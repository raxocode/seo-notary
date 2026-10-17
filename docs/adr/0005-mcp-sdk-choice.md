# ADR 0005: MCP SDK choice

Status: accepted (2026-10-17), to be re-verified when the MCP server is built

- Use `@modelcontextprotocol/server` v2 (`McpServer`, `registerTool`, stdio transport). `npm view` shows 2.3.1 as latest; the legacy `@modelcontextprotocol/sdk` is at 1.32.1.
- The installed version's docs must be checked before any code is written. Fall back to v1 only if v2 blocks, with a new ADR.
- Nothing from the MCP SDK is installed yet.
