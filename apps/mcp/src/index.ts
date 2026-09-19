import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { loadEnv } from "@yourcrm/config"
import type { z } from "zod"
import { devContext, type ToolContext } from "./auth"
import { tools } from "./tools"

/**
 * The SDK's `registerTool` is heavily generic over each tool's concrete zod
 * shape, which cannot be expressed through a registry array. The cast below
 * is the single allowed seam: tool descriptors stay fully typed in
 * `./tools.ts`, and only this loop bridges to the SDK. Runtime behavior is
 * unchanged (shapes pass straight through).
 */
type RegisterFn = (
  name: string,
  params: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> },
  cb: (args: Record<string, unknown>) => Promise<{ content: { type: "text"; text: string }[] }>,
) => void

export function createMcpServer(makeContext: () => ToolContext = devContext): McpServer {
  const server = new McpServer({ name: "yourcrm", version: "0.1.0" })
  const register = server.registerTool as unknown as RegisterFn

  for (const tool of tools) {
    register.call(
      server,
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args) => {
        const ctx = makeContext()
        const result = await tool.handler(args, ctx)
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
      },
    )
  }

  return server
}

async function main(): Promise<void> {
  loadEnv()
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("YourCRM MCP server running on stdio")
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error("MCP server failed:", err)
    process.exit(1)
  })
}
