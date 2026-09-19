import { requirePermission } from "@yourcrm/permissions"
import { upsertMarketingConsentSchema } from "./schemas"
import type {
  MarketingConsentRecord,
  MarketingConsentServiceContext,
  MarketingConsentServiceDeps,
} from "./types"

export class MarketingConsentNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(token: string) {
    super(`marketing consent token ${token} not found`)
    this.name = "MarketingConsentNotFoundError"
  }
}

/**
 * Consent / unsubscribe domain service (spec 24-marketing, P0) — "the point
 * of this module". Two very different authorization shapes live here on
 * purpose:
 *
 *  - `grant()` is a normal workspace-role-gated write (a teammate recording
 *    that a person opted in/out), so it calls `requirePermission()` first
 *    like every other service method in the codebase.
 *  - `unsubscribeByToken()` has NO session and NO workspace role: the
 *    caller is the recipient of an email, clicking the unsubscribe link it
 *    is legally required to carry. Authorization is possession of the
 *    unguessable per-person `unsubscribe_token` (a uuid, unique per
 *    workspace+person — see `0290_marketing.sql`), not RBAC. This mirrors
 *    the existing precedent in the codebase for public, non-session
 *    endpoints: `apps/api/src/routes/modules/integrations.ts`'s inbound
 *    webhook, which verifies a shared secret instead of calling
 *    `requirePermission()`. `requirePermission()` needs a `workspaceId` +
 *    `actorId` it does not have here, and pretending a request bears the
 *    workspace's `owner` role just to satisfy the general rule would be
 *    worse than documenting the deliberate exception.
 */
export function createMarketingConsentService(deps: MarketingConsentServiceDeps) {
  async function grant(
    ctx: MarketingConsentServiceContext,
    rawInput: unknown,
  ): Promise<MarketingConsentRecord> {
    requirePermission({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      role: ctx.role ?? "viewer",
      object: "marketing_consent",
      action: "update",
    })
    const input = upsertMarketingConsentSchema.parse(rawInput)
    const before = await deps.store.findByPersonId(ctx.workspaceId, input.personId)
    const after = await deps.store.upsert(ctx.workspaceId, input, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: input.marketingConsent ? "grant_consent" : "revoke_consent",
      object: "marketing_consent",
      recordId: after.id,
      before,
      after,
      correlationId: ctx.correlationId,
    })
    return after
  }

  /**
   * Public, token-authenticated unsubscribe. No `requirePermission()` call
   * (see the class doc) — the token itself is the authorization. Still
   * audited, with `source: "user"` because the acting party is the
   * recipient, not the workspace.
   */
  async function unsubscribeByToken(
    token: string,
    correlationId?: string,
  ): Promise<MarketingConsentRecord> {
    const updated = await deps.store.unsubscribeByToken(token)
    if (!updated) throw new MarketingConsentNotFoundError(token)
    await deps.audit({
      workspaceId: updated.workspaceId,
      actorId: null,
      action: "unsubscribe",
      object: "marketing_consent",
      recordId: updated.id,
      after: updated,
      correlationId,
      source: "user",
    })
    return updated
  }

  return { grant, unsubscribeByToken }
}

export type MarketingConsentService = ReturnType<typeof createMarketingConsentService>
