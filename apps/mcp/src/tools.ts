import { z } from "zod"
import { roleInWorkspace } from "@yourcrm/auth"
import { requirePermission } from "@yourcrm/permissions"
import { requireToolSession, type ToolContext } from "./auth"

/**
 * Tool registration pattern. Each tool is a pure descriptor + handler that
 * goes through session -> permission -> domain service. Tools NEVER touch
 * repositories or SQL directly (they consume @yourcrm/crm services).
 */

export type ToolDefinition = {
  name: string
  description: string
  /** Zod raw shape — passed straight to the MCP SDK's registerTool. */
  inputSchema: z.ZodRawShape
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>
}

const pingInput = z.object({ message: z.string().min(1).max(500).default("ping") })

/** Foundation tool: proves auth + permission + service wiring. */
export const pingTool: ToolDefinition = {
  name: "yourcrm_ping",
  description: "Verify the MCP server is reachable and the caller is authorized.",
  inputSchema: pingInput.shape,
  handler: async (input, ctx) => {
    const parsed = pingInput.parse(input)
    const session = requireToolSession(ctx)
    requirePermission({
      workspaceId: session.workspaceId ?? "",
      actorId: session.user.id,
      role: roleInWorkspace(session),
      action: "read",
    })
    if (!session.workspaceId) throw new Error("UNAUTHORIZED: no active workspace")
    // Later: call the domain service (e.g. workspaceService.ping(ctx)).
    return { pong: true, echo: parsed.message, workspaceId: session.workspaceId }
  },
}

export const tools: ToolDefinition[] = [pingTool]

export function getTool(name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name === name)
}
