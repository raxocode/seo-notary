# ADR 0005: MCP SDK choice

Status: accepted (2026-10-17), verified against the installed packages

- The server uses `@modelcontextprotocol/server` 2.3.1: `McpServer`, `registerTool` with Zod v4 input and output schemas, and `StdioServerTransport` from `@modelcontextprotocol/server/stdio`. The legacy `@modelcontextprotocol/sdk` (1.x) is not used.
- Tests use `@modelcontextprotocol/client` 2.3.1 (`Client`, `StdioClientTransport`) to talk to the built binary over stdio.
- Tool annotations are supported by `registerTool`: `verify_url` is read-only, idempotent and open-world; `get_rule_catalog` is read-only and closed-world.
- Operational failures are returned as `isError: true` results with no `structuredContent`; the SDK accepts a tool with an `outputSchema` returning an error result.
- The server logs only to stderr; stdout is reserved for protocol frames.
