# `@yourcrm/mcp` — MCP server (spec 39-mcp, P0)

An MCP server over the CRM: read tools for records and search, and write
tools that **propose** changes through AI governance instead of making
them. Transport is **stdio only** in P0.

## Files

- `src/index.ts` — the protocol layer. Low-level `Server` with
  `tools/list` + `tools/call` handlers, so each tool's JSON Schema is
  emitted verbatim (see "Schemas" below). Stdio transport, env from
  `@yourcrm/config`.
- `src/auth.ts` — `McpSession`: the caller. Resolves to a real
  `@yourcrm/auth` `Session`, from which workspace, actor and role are
  derived. Unauthenticated callers reach nothing.
- `src/runtime.ts` — `McpRuntime`: the three domain-service ports the
  tools may reach (reports query engine, search service, AI-governance
  proposal port) plus the audit sink.
- `src/tools.ts` — `McpToolDefinition` + `createMcpToolset(runtime)`. The
  catalogue and the one entrypoint that authenticates, authorizes, runs
  and audits every call.
- `src/dev-runtime.ts` — fixture CRM behind the *real* domain services,
  for development and hermetic tests.

## Tool catalogue

| Tool | Access | Goes to |
| --- | --- | --- |
| `yourcrm_ping` | read | — (reports the caller's workspace and role) |
| `yourcrm_describe_objects` | read | assistant tool `crm_describe_objects` |
| `yourcrm_query_records` | read | assistant tool `crm_query` |
| `yourcrm_list_people` | read | `crm_query` with `objectType: person` |
| `yourcrm_list_companies` | read | `crm_query` with `objectType: company` |
| `yourcrm_list_deals` | read | `crm_query` with `objectType: deal` |
| `yourcrm_list_tasks` | read | `crm_query` with `objectType: task` |
| `yourcrm_list_activities` | read | `crm_query` with `objectType: activity` |
| `yourcrm_search` | read | `createSearchService(...).search` |
| `yourcrm_propose_create_record` | propose | `requestAction` (create) |
| `yourcrm_propose_update_record` | propose | `requestAction` (update) |
| `yourcrm_propose_create_task` | propose | `requestAction` (create task) |

## Rules this app keeps

- **Domain services, never tables.** No dependency on the database
  package — asserted from the source text in `src/boundary.test.ts`.
- **Reads reuse the assistant's tools.** `createAiCrmTools` over the
  reports engine; there is no second query path and no MCP-authored SQL.
- **Permissions are inherited, twice.** `createMcpToolset.call` resolves a
  `Session`, builds the `ServiceContext` from it alone, and calls
  `requirePermission()`; the domain service then runs its own check and
  its own row scoping (`resolveReportRowScope`). Arguments cannot
  influence workspace, actor or role.
- **Writes propose.** Every `propose_*` tool calls
  `AiActionProposalPort.requestAction` — a pending `ai_action_request`
  that a *different* human must approve in the app. The apply path is not
  reachable from this process.
- **Every call is audited** (`object: mcp_tool`, `source: "mcp"`) with the
  caller, tool name, arguments and outcome — denials included.

## Schemas

Tool schemas are hand-authored complete JSON Schema (`type`,
`properties`, `required`, `additionalProperties`) and emitted verbatim.
`McpJsonSchema` makes `required` non-optional at the type level, so a
parameter-less tool cannot ship without `required: []` — a gateway has
rejected exactly that omission with `null is not of type "array"`.
`McpServer.registerTool`'s zod conversion drops it, which is why this
server uses the low-level `Server`.

## Running it

```bash
bun --filter @yourcrm/mcp run dev    # stdio, fixture runtime outside production
```

A client (e.g. Claude Desktop) launches the process and speaks JSON-RPC
over stdin/stdout.

## Known gaps (blockers, not omissions)

1. **No production runtime.** Building the real ports needs the database
   package, which this app must not depend on. `createMcpServer({ runtime,
   resolveCaller })` takes both as arguments; until a host wires them,
   production uses `createUnconfiguredMcpRuntime()` — lists the catalogue,
   refuses every call. Development uses the fixture runtime.
2. **No token/OAuth session resolution.** `MCP_API_TOKEN` exists in the
   env schema but resolving it to a user needs the auth store (same
   package problem). `McpSessionResolver` is the seam.
3. **No domain events.** Spec 39 §9 names `mcp.connected`,
   `mcp.tool_called`, `mcp.write_approved` and `mcp.disconnected`;
   `@yourcrm/events` exports no constants for them and event names may
   never be string literals. Audit rows cover calls meanwhile.
4. **No HTTP/SSE transport and no `/app/settings/mcp` UI** — both P1,
   both gated on the OAuth design.
