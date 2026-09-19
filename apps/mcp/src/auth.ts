import { devSession, type Session } from "@yourcrm/auth"

/**
 * MCP authentication integration point. Transports resolve a `Session`
 * (API token / OAuth) and tools receive it as `ToolContext`.
 *
 * Foundation: stdio transport trusts the local caller; `MCP_API_TOKEN`
 * gates the future HTTP transport. `x-dev-session` equivalent: pass a
 * dev session explicitly in tests.
 */

export type ToolContext = {
  session: Session | null
  correlationId: string
}

export function devContext(): ToolContext {
  return { session: devSession(), correlationId: crypto.randomUUID() }
}

export function requireToolSession(ctx: ToolContext): Session {
  if (!ctx.session) throw new Error("UNAUTHORIZED: MCP tool requires a session")
  return ctx.session
}
