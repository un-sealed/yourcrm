import { roleInWorkspace, type Session } from "@yourcrm/auth"
import type { ServiceContext } from "@yourcrm/crm"
import { nextId } from "./time"

export type MakeServiceContextOptions = Partial<ServiceContext> & {
  /** Derive workspaceId/actorId/role from this session unless overridden. */
  session?: Session
}

/**
 * Service-context fixture using the real `ServiceContext` type from
 * `@yourcrm/crm`. Pass a session to derive the caller, or set fields
 * directly. `correlationId` defaults to a deterministic id (the API layer
 * echoes `x-request-id` into it via audit rows).
 *
 * ```ts
 * const ctx = makeServiceContext({ session: makeSession({ role: "viewer" }) })
 * const ctx = makeServiceContext({ workspaceId: "ws_1", actorId: "u_1", role: "admin" })
 * ```
 */
export function makeServiceContext(options: MakeServiceContextOptions = {}): ServiceContext {
  const { session, ...rest } = options
  const workspaceId =
    rest.workspaceId ?? session?.workspaceId ?? session?.memberships[0]?.workspaceId ?? nextId("ws")
  const actorId = rest.actorId ?? session?.user.id ?? nextId("user")
  const role = rest.role ?? (session ? roleInWorkspace(session) : "owner")
  return { correlationId: nextId("corr"), ...rest, workspaceId, actorId, role }
}
