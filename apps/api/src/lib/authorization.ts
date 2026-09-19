/**
 * Authorization integration point. Domain services call `requirePermission()`
 * directly; this helper is for the rare route-level gate (e.g. admin-only
 * endpoints) so Hono handlers still contain zero business logic.
 */
import { requireWorkspace, roleInWorkspace, type Session } from "@yourcrm/auth"
import { requirePermission, type PermissionAction } from "@yourcrm/permissions"

export function authorize(
  session: Session | null,
  input: { object?: string; recordId?: string; field?: string; action: PermissionAction },
): { workspaceId: string; actorId: string } {
  const workspaceId = requireWorkspace(session)
  const actorId = session!.user.id
  requirePermission({ workspaceId, actorId, role: roleInWorkspace(session), ...input })
  return { workspaceId, actorId }
}
