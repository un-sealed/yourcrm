/**
 * Shared service-call context.
 *
 * Lives here rather than in `@yourcrm/crm` so that packages sitting beside
 * the domain layer — notably `@yourcrm/testing` — can reference it without
 * depending on the domain package. `crm` re-exports it for compatibility.
 */
export type ServiceContext = {
  workspaceId: string
  actorId: string
  role?: string
  correlationId?: string
}
