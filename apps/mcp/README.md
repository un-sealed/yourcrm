# `@yourcrm/mcp` — MCP server (stdio foundation)

- `src/index.ts` — bootstrap: env validation, stdio transport.
- `src/auth.ts` — session integration point (`ToolContext`).
- `src/tools.ts` — tool registration pattern: descriptor + handler going
  session -> permission -> **domain service**. `yourcrm_ping` proves it.

Rules: tools consume `@yourcrm/crm` services, never repositories/SQL.
HTTP+SSE transport + OAuth gating land in Phase 1 (`MCP_API_TOKEN`).
