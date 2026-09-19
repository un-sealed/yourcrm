import { devSession, roleInWorkspace, type Session, type WorkspaceRole } from "@yourcrm/auth"
import type { ServiceContext } from "@yourcrm/validation"

/**
 * MCP authentication (spec 39-mcp §8, `AGENTS.md`: "AI/MCP actions inherit
 * caller permissions").
 *
 * ## An MCP call is a request by a person
 *
 * There is no "MCP identity" in this product and there must never be one.
 * A tool call is resolved to a real `Session` — the same contract
 * `@yourcrm/auth` hands the HTTP layer — and every downstream permission
 * decision is made from that session's workspace and role. An MCP client
 * that has not been authenticated therefore reaches exactly nothing:
 * {@link requireMcpSession} refuses before any tool name is even looked
 * up, so a refusal cannot tell a caller which tools (or records) exist.
 *
 * ## Where the session comes from
 *
 * Resolving `MCP_API_TOKEN` (or an OAuth grant, spec 39 §7) to a user
 * means reading the auth store, which lives behind the database package —
 * one `apps/mcp` deliberately does not depend on (see
 * `boundary.test.ts`). So the lookup is a PORT: the composition root
 * supplies an {@link McpSessionResolver}, exactly as it supplies the CRM
 * services. See `runtime.ts` for the blocker this implies for production.
 *
 * ## Naming
 *
 * `McpSession` is the CALLER — the resolved session plus the per-connection
 * metadata the audit trail needs. It is not a second session model: the
 * `session` field is `@yourcrm/auth`'s `Session`, unchanged.
 */

/** The caller of a tool, as the toolset sees it. */
export type McpSession = {
  /** Null until the transport has authenticated the caller. */
  session: Session | null
  /** Shared by every audit row and event produced by this call. */
  correlationId: string
  /** Opaque id of the connected MCP client, recorded for the audit trail. */
  clientId: string
}

/**
 * How a transport turns a connection into a caller. Async because a real
 * implementation reads the auth store.
 */
export type McpSessionResolver = () => Promise<McpSession> | McpSession

/**
 * The ONE refusal an unauthenticated caller ever sees.
 *
 * Deliberately constant and content-free: it names no tool, no object, no
 * record and no workspace, so probing the server with and without a valid
 * record id produces byte-identical answers. Asserted in `tools.test.ts`.
 */
export const MCP_UNAUTHORIZED_MESSAGE = "authentication required"

export class McpUnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED"
  constructor() {
    super(MCP_UNAUTHORIZED_MESSAGE)
    this.name = "McpUnauthorizedError"
  }
}

/** Resolve the caller or refuse. Called before anything else on every tool. */
export function requireMcpSession(caller: McpSession): Session {
  const session = caller.session
  // A session without an active workspace is as good as no session: every
  // service context below is workspace-scoped, and an empty workspace id
  // is refused by `checkPermission` anyway. Refuse here, identically, so
  // the two cases are indistinguishable from outside.
  if (!session || !session.workspaceId) throw new McpUnauthorizedError()
  return session
}

/** The caller's role in the active workspace, from the session only. */
export function mcpCallerRole(session: Session): WorkspaceRole {
  return roleInWorkspace(session)
}

/**
 * The `ServiceContext` every domain service call is made with.
 *
 * This is the whole permission-inheritance mechanism: the workspace, the
 * actor and the role are read off the caller's session and nothing else.
 * No tool argument can influence any of the three, so an MCP client cannot
 * widen its own scope by asking nicely.
 */
export function mcpServiceContext(caller: McpSession, session: Session): ServiceContext {
  return {
    workspaceId: session.workspaceId ?? "",
    actorId: session.user.id,
    role: mcpCallerRole(session),
    correlationId: caller.correlationId,
  }
}

/**
 * Dev/test caller, mirroring `devSession()` in `@yourcrm/auth`. Used by the
 * stdio entrypoint outside production so the server is drivable by a real
 * MCP client before the token store is wired — never in production, where
 * the default resolver returns an anonymous caller (see `index.ts`).
 */
export function devMcpSession(overrides: Partial<Session> = {}): McpSession {
  return {
    session: devSession(overrides),
    correlationId: crypto.randomUUID(),
    clientId: "mcp-dev",
  }
}

/** An authenticated-nobody caller: every tool call is refused. */
export function anonymousMcpSession(clientId = "mcp-anonymous"): McpSession {
  return { session: null, correlationId: crypto.randomUUID(), clientId }
}
