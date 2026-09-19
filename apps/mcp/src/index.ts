import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { loadEnv } from "@yourcrm/config"
import { z } from "zod"
import { anonymousMcpSession, devMcpSession, type McpSessionResolver } from "./auth"
import { createDevMcpRuntime } from "./dev-runtime"
import { createUnconfiguredMcpRuntime, type McpRuntime } from "./runtime"
import { createMcpToolset } from "./tools"

/**
 * YourCRM MCP server — stdio transport (spec 39-mcp, P0).
 *
 * ## Why the low-level `Server` and not `McpServer.registerTool`
 *
 * `McpServer` derives each tool's JSON Schema from a zod shape, and that
 * conversion DROPS `required` when no property is required: driving the
 * previous foundation server produced
 * `{"type":"object","properties":{...},"additionalProperties":false}` with
 * no `required` at all. That is the exact shape a gateway rejected for
 * `ai-core` with `null is not of type "array"`. Tool schemas are part of
 * this server's contract with clients we do not control, so they are
 * authored as complete JSON Schema in `tools.ts` and emitted VERBATIM
 * here. The transport, the descriptor-plus-handler pattern and the auth
 * seam are unchanged; only the (previously cast-away) registration loop
 * is gone, and with it the `as unknown as` seam it needed.
 *
 * ## HTTP is deliberately absent
 *
 * Spec 39 wants OAuth and a remote transport. Both need an auth design and
 * a public surface this repo does not have yet, so P0 is stdio only:
 * the client launches the server as a local child process and the caller
 * is resolved once per connection.
 */

export type McpServerDeps = {
  /** The CRM services the tools may reach. See `runtime.ts`. */
  runtime: McpRuntime
  /** How a connection becomes a caller. See `auth.ts`. */
  resolveCaller: McpSessionResolver
}

const SERVER_INFO = { name: "yourcrm", version: "0.1.0" } as const

/** Error payload handed back to the client. Never carries record content. */
function errorPayload(err: unknown): { error: { code: string; message: string } } {
  if (err instanceof z.ZodError) {
    return {
      error: {
        code: "BAD_REQUEST",
        message: err.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      },
    }
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return { error: { code: typeof code === "string" ? code : "INTERNAL", message: err.message } }
  }
  return { error: { code: "INTERNAL", message: "tool call failed" } }
}

export function createMcpServer(deps: McpServerDeps): Server {
  const toolset = createMcpToolset(deps.runtime)
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } })

  // The catalogue is static and public: it describes capabilities, not
  // data. Every call it advertises still has to get past `toolset.call`.
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolset.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const caller = await deps.resolveCaller()
    try {
      const outcome = await toolset.call(
        request.params.name,
        request.params.arguments ?? {},
        caller,
      )
      return { content: [{ type: "text" as const, text: JSON.stringify(outcome.result) }] }
    } catch (err) {
      // MCP convention: a tool failure is a result, not a protocol error,
      // so the model can read it and try something else.
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(errorPayload(err)) }],
      }
    }
  })

  return server
}

/**
 * The runtime the stdio entrypoint uses when the host application has not
 * injected one.
 *
 * Production gets the refusing placeholder: a CRM-less MCP server must
 * fail loudly rather than answer "no records". Development gets the
 * fixture runtime so the catalogue can be driven by a real client today.
 */
export function defaultMcpRuntime(nodeEnv: string): McpRuntime {
  if (nodeEnv === "production") return createUnconfiguredMcpRuntime()
  return createDevMcpRuntime().runtime
}

/**
 * The caller resolver the stdio entrypoint uses by default.
 *
 * Production: anonymous — resolving `MCP_API_TOKEN` to a user needs the
 * auth store, which lives behind a package this app does not depend on, so
 * the host must inject a resolver. An anonymous caller reaches nothing.
 * Development: the shared `devSession()`, same as the rest of the repo.
 */
export function defaultMcpSessionResolver(nodeEnv: string): McpSessionResolver {
  if (nodeEnv === "production") return () => anonymousMcpSession()
  return () => devMcpSession()
}

async function main(): Promise<void> {
  const env = loadEnv()
  const server = createMcpServer({
    runtime: defaultMcpRuntime(env.NODE_ENV),
    resolveCaller: defaultMcpSessionResolver(env.NODE_ENV),
  })
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`YourCRM MCP server running on stdio (${env.NODE_ENV})`)
}

if (import.meta.main) {
  await main().catch((err: unknown) => {
    console.error("MCP server failed:", err)
    process.exit(1)
  })
}
