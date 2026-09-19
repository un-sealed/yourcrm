/**
 * Permission model: workspace -> object -> record -> field -> action.
 * See DATA-MODEL-CONTRACTS.md. Every mutation path (API, MCP, AI, worker)
 * must call `checkPermission` / `requirePermission` server-side.
 */

export const PERMISSION_ACTIONS = [
  "read",
  "create",
  "update",
  "delete",
  "export",
  "share",
  "send_external",
  "run_automation",
  "run_ai",
  "admin",
] as const

export type PermissionAction = (typeof PERMISSION_ACTIONS)[number]

export type PermissionContext = {
  workspaceId: string
  actorId: string
  /** Workspace role, resolved by @yourcrm/auth. */
  role?: "owner" | "admin" | "member" | "viewer" | string
  object?: string
  recordId?: string
  field?: string
  action: PermissionAction
}

export type PermissionDecision = {
  allowed: boolean
  reason?: string
}

const ROLE_RANK: Record<string, number> = {
  owner: 100,
  admin: 80,
  member: 40,
  viewer: 10,
}

const MIN_RANK: Record<PermissionAction, number> = {
  read: 10,
  create: 40,
  update: 40,
  delete: 80,
  export: 40,
  share: 40,
  send_external: 40,
  run_automation: 80,
  run_ai: 40,
  admin: 80,
}

/**
 * Foundation policy: role-rank gate. Domain packages may add
 * object/record/field-level policies on top, never instead of this call.
 */
export function checkPermission(ctx: PermissionContext): PermissionDecision {
  if (!ctx.workspaceId || !ctx.actorId) {
    return { allowed: false, reason: "missing workspace or actor" }
  }
  const rank = ROLE_RANK[ctx.role ?? "viewer"] ?? 10
  const required = MIN_RANK[ctx.action]
  if (rank >= required) return { allowed: true }
  return { allowed: false, reason: `role '${ctx.role}' cannot '${ctx.action}'` }
}

export class PermissionDeniedError extends Error {
  readonly code = "FORBIDDEN"
  constructor(
    readonly ctx: PermissionContext,
    reason?: string,
  ) {
    super(reason ?? `Forbidden: cannot ${ctx.action}${ctx.object ? ` on ${ctx.object}` : ""}`)
    this.name = "PermissionDeniedError"
  }
}

export function requirePermission(ctx: PermissionContext): void {
  const decision = checkPermission(ctx)
  if (!decision.allowed) throw new PermissionDeniedError(ctx, decision.reason)
}
