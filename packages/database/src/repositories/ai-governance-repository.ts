import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import {
  aiActionApprovals,
  aiActionRequests,
  aiPolicies,
  isAiActionRequestStatus,
  isAiActionType,
  isAiActorType,
  isAiApprovalDecision,
  isAiPolicyMode,
  AI_POLICY_WILDCARD,
  type AiActionApproval,
  type AiActionRequest,
  type AiPolicy,
} from "../schema/ai-governance"
import { createBaseRepository } from "./base-repository"

/**
 * AI governance repository (spec 38-ai-governance, P0) — migration 0350.
 *
 * Three concerns in one file because they share a lifecycle: policies
 * (`ai_policies`), proposed mutations (`ai_action_requests`) and the one
 * human decision each may receive (`ai_action_approvals`).
 *
 * THE TWO GUARANTEES THIS FILE IMPLEMENTS
 * ---------------------------------------
 * 1. `recordDecision` inserts with `ON CONFLICT DO NOTHING` against the
 *    UNIQUE index `ai_action_approvals_request_idx (request_id)` and, on
 *    conflict, returns the existing decision with `created: false`. One
 *    request can therefore never collect two decisions, however many
 *    approvers race on it.
 *
 * 2. `claimRequestApply` / `claimRequestRevert` are CONDITIONAL UPDATES:
 *
 *      UPDATE ai_action_requests SET apply_claimed_at = now()
 *       WHERE id = $1 AND workspace_id = $2
 *         AND status = 'approved' AND apply_claimed_at IS NULL
 *      RETURNING *
 *
 *    Postgres serialises writers on the row, so exactly one caller sees a
 *    returned row and every other caller gets `claimed: false`. The
 *    governance service only reaches the domain applier after a successful
 *    claim, which is what makes apply exactly-once across retries, double
 *    clicks and concurrent workers.
 *
 * Everything user-supplied is validated here before it reaches SQL —
 * statuses, action types, actor types, decisions and policy modes against
 * the schema allowlists. Values are always bound by drizzle, never
 * interpolated.
 */

export class AiGovernanceDefinitionError extends Error {
  readonly code = "INVALID_AI_ACTION"
  constructor(message: string) {
    super(message)
    this.name = "AiGovernanceDefinitionError"
  }
}

/* ------------------------------- validation ------------------------------- */

/** Object type of a governed target, or the `*` wildcard for a policy. */
export function normalizeAiObjectType(value: unknown, allowWildcard = false): string {
  if (typeof value !== "string") {
    throw new AiGovernanceDefinitionError("objectType must be a string")
  }
  const trimmed = value.trim().toLowerCase()
  if (trimmed === AI_POLICY_WILDCARD) {
    if (allowWildcard) return trimmed
    throw new AiGovernanceDefinitionError("a request must name a concrete object type")
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(trimmed)) {
    throw new AiGovernanceDefinitionError(
      `'${value}' is not a valid object type (lower snake_case, max 64 characters)`,
    )
  }
  return trimmed
}

export function validateAiActionType(value: unknown, allowWildcard = false): string {
  if (allowWildcard && value === AI_POLICY_WILDCARD) return AI_POLICY_WILDCARD
  if (!isAiActionType(value)) {
    throw new AiGovernanceDefinitionError(
      `unknown AI action '${String(value)}' (create, update, delete, send_external)`,
    )
  }
  return value
}

export function validateAiPolicyMode(value: unknown): string {
  if (!isAiPolicyMode(value)) {
    throw new AiGovernanceDefinitionError(
      `unknown policy mode '${String(value)}' (require_approval, auto_apply, forbidden)`,
    )
  }
  return value
}

export function validateAiActionStatus(value: unknown): string {
  if (!isAiActionRequestStatus(value)) {
    throw new AiGovernanceDefinitionError(`unknown AI action status '${String(value)}'`)
  }
  return value
}

function validateAiActorType(value: unknown): string {
  if (!isAiActorType(value)) {
    throw new AiGovernanceDefinitionError(`unknown AI actor type '${String(value)}' (user, agent)`)
  }
  return value
}

function validateAiDecision(value: unknown): string {
  if (!isAiApprovalDecision(value)) {
    throw new AiGovernanceDefinitionError(
      `unknown decision '${String(value)}' (approved, rejected)`,
    )
  }
  return value
}

/* --------------------------------- inputs --------------------------------- */

export type CreateAiPolicyInput = {
  objectType?: string | null
  action?: string | null
  mode?: string | null
  description?: string | null
  enabled?: boolean | null
}

export type UpdateAiPolicyInput = Partial<CreateAiPolicyInput>

export type AiPolicySearchOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  objectType?: string
  mode?: string
}

export type CreateAiActionRequestInput = {
  actorType?: string | null
  actorId: string
  agentId?: string | null
  model?: string | null
  runId?: string | null
  correlationId?: string | null
  objectType: string
  recordId?: string | null
  action: string
  before?: unknown
  after?: unknown
  rationale?: string | null
  status?: string | null
  policyId?: string | null
  policyMode?: string | null
  requestedRole?: string | null
  expiresAt?: Date | null
  decidedAt?: Date | null
}

export type UpdateAiActionRequestInput = {
  status?: string
  decidedAt?: Date | null
  appliedAt?: Date | null
  applyResult?: unknown
  applyError?: string | null
  revertedAt?: Date | null
  revertError?: string | null
}

export type AiActionRequestSearchOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
  objectType?: string
  recordId?: string
  runId?: string
  actorId?: string
}

export type RecordAiDecisionInput = {
  requestId: string
  decision: string
  approverId: string
  approverRole?: string | null
  requesterRole?: string | null
  reason?: string | null
  correlationId?: string | null
}

export type AiActionClaim = {
  claimedBy: string
  claimedAt: Date
}

/* ------------------------------- repository ------------------------------- */

const policyBase = createBaseRepository(aiPolicies)

async function findRequest(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<AiActionRequest | null> {
  const rows = await db
    .select()
    .from(aiActionRequests)
    .where(and(eq(aiActionRequests.id, id), eq(aiActionRequests.workspaceId, workspaceId)))
    .limit(1)
  return rows[0] ?? null
}

export function createAiGovernanceRepository() {
  return {
    /* -------------------------------- policies ------------------------------- */

    async searchPolicies(db: Database, opts: AiPolicySearchOptions) {
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200)
      const conditions: SQL[] = []
      if (opts.objectType !== undefined) {
        conditions.push(eq(aiPolicies.objectType, normalizeAiObjectType(opts.objectType, true)))
      }
      if (opts.mode !== undefined) {
        conditions.push(eq(aiPolicies.mode, validateAiPolicyMode(opts.mode)))
      }
      const result = await policyBase.list(db, {
        workspaceId: opts.workspaceId,
        limit,
        ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
        ...(opts.order === undefined ? {} : { order: opts.order }),
        where: conditions,
      })
      return { data: result.data as AiPolicy[], pagination: result.pagination }
    },

    /**
     * Every live, enabled policy in the workspace. Resolution (most
     * specific scope wins) is a PURE FUNCTION in the domain layer
     * (`resolveAiPolicy`), so it is unit-testable without a database and
     * the same code decides in the UI preview and on the server.
     */
    async listActivePolicies(db: Database, workspaceId: string): Promise<AiPolicy[]> {
      return db
        .select()
        .from(aiPolicies)
        .where(
          and(
            eq(aiPolicies.workspaceId, workspaceId),
            isNull(aiPolicies.deletedAt),
            eq(aiPolicies.enabled, true),
          ),
        )
        .orderBy(asc(aiPolicies.createdAt))
    },

    async findPolicyById(db: Database, workspaceId: string, id: string): Promise<AiPolicy | null> {
      return (await policyBase.findById(db, workspaceId, id)) as AiPolicy | null
    },

    async createPolicy(
      db: Database,
      workspaceId: string,
      input: CreateAiPolicyInput,
      actorId?: string,
    ): Promise<AiPolicy> {
      const rows = await db
        .insert(aiPolicies)
        .values({
          workspaceId,
          objectType: normalizeAiObjectType(input.objectType ?? AI_POLICY_WILDCARD, true),
          action: validateAiActionType(input.action ?? AI_POLICY_WILDCARD, true),
          mode: validateAiPolicyMode(input.mode ?? "require_approval"),
          description: input.description ?? null,
          enabled: input.enabled ?? true,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new AiGovernanceDefinitionError("ai_policies.create returned no row")
      return row
    },

    async updatePolicy(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateAiPolicyInput,
      actorId?: string,
    ): Promise<AiPolicy | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (patch.objectType !== undefined) {
        values.objectType = normalizeAiObjectType(patch.objectType, true)
      }
      if (patch.action !== undefined) values.action = validateAiActionType(patch.action, true)
      if (patch.mode !== undefined) values.mode = validateAiPolicyMode(patch.mode)
      if (patch.description !== undefined) values.description = patch.description
      if (patch.enabled !== undefined) values.enabled = patch.enabled
      if (actorId !== undefined) values.updatedBy = actorId
      const rows = await db
        .update(aiPolicies)
        .set(values)
        .where(
          and(
            eq(aiPolicies.id, id),
            eq(aiPolicies.workspaceId, workspaceId),
            isNull(aiPolicies.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async softDeletePolicy(
      db: Database,
      workspaceId: string,
      id: string,
      actorId?: string,
    ): Promise<void> {
      await policyBase.softDelete(db, workspaceId, id, actorId)
    },

    /* -------------------------------- requests ------------------------------- */

    async createRequest(
      db: Database,
      workspaceId: string,
      input: CreateAiActionRequestInput,
      actorId?: string,
    ): Promise<AiActionRequest> {
      const rows = await db
        .insert(aiActionRequests)
        .values({
          workspaceId,
          actorType: validateAiActorType(input.actorType ?? "agent"),
          actorId: input.actorId,
          agentId: input.agentId ?? null,
          model: input.model ?? null,
          runId: input.runId ?? null,
          correlationId: input.correlationId ?? null,
          objectType: normalizeAiObjectType(input.objectType),
          recordId: input.recordId ?? null,
          action: validateAiActionType(input.action),
          before: input.before ?? null,
          after: input.after ?? null,
          rationale: input.rationale ?? null,
          status: validateAiActionStatus(input.status ?? "pending"),
          policyId: input.policyId ?? null,
          policyMode: validateAiPolicyMode(input.policyMode ?? "require_approval"),
          requestedRole: input.requestedRole ?? null,
          expiresAt: input.expiresAt ?? null,
          decidedAt: input.decidedAt ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new AiGovernanceDefinitionError("ai_action_requests.create returned no row")
      return row
    },

    findRequestById: findRequest,

    async searchRequests(db: Database, opts: AiActionRequestSearchOptions) {
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200)
      const conditions: SQL[] = [eq(aiActionRequests.workspaceId, opts.workspaceId)]
      if (opts.status !== undefined) {
        conditions.push(eq(aiActionRequests.status, validateAiActionStatus(opts.status)))
      }
      if (opts.objectType !== undefined) {
        conditions.push(eq(aiActionRequests.objectType, normalizeAiObjectType(opts.objectType)))
      }
      if (opts.recordId !== undefined) {
        conditions.push(eq(aiActionRequests.recordId, opts.recordId))
      }
      if (opts.runId !== undefined) conditions.push(eq(aiActionRequests.runId, opts.runId))
      if (opts.actorId !== undefined) conditions.push(eq(aiActionRequests.actorId, opts.actorId))
      const rows = await db
        .select()
        .from(aiActionRequests)
        .where(and(...conditions))
        .orderBy(
          opts.order === "asc" ? asc(aiActionRequests.createdAt) : desc(aiActionRequests.createdAt),
        )
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows
      const last = data[data.length - 1]
      return { data, pagination: { nextCursor: hasMore ? (last?.id ?? null) : null, limit } }
    },

    async updateRequest(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateAiActionRequestInput,
    ): Promise<AiActionRequest | null> {
      const values: Record<string, unknown> = { updatedAt: new Date() }
      if (patch.status !== undefined) values.status = validateAiActionStatus(patch.status)
      if (patch.decidedAt !== undefined) values.decidedAt = patch.decidedAt
      if (patch.appliedAt !== undefined) values.appliedAt = patch.appliedAt
      if (patch.applyResult !== undefined) values.applyResult = patch.applyResult
      if (patch.applyError !== undefined) values.applyError = patch.applyError
      if (patch.revertedAt !== undefined) values.revertedAt = patch.revertedAt
      if (patch.revertError !== undefined) values.revertError = patch.revertError
      const rows = await db
        .update(aiActionRequests)
        .set(values)
        .where(and(eq(aiActionRequests.id, id), eq(aiActionRequests.workspaceId, workspaceId)))
        .returning()
      return rows[0] ?? null
    },

    /**
     * EXACTLY-ONCE, half one. Only a request that is still `approved` and
     * has never been claimed can be claimed, and the UPDATE is the claim:
     * the loser of a race gets zero rows and `claimed: false`.
     */
    async claimRequestApply(
      db: Database,
      workspaceId: string,
      id: string,
      claim: AiActionClaim,
    ): Promise<{ request: AiActionRequest | null; claimed: boolean }> {
      const rows = await db
        .update(aiActionRequests)
        .set({
          applyClaimedAt: claim.claimedAt,
          applyClaimedBy: claim.claimedBy,
          updatedAt: claim.claimedAt,
        })
        .where(
          and(
            eq(aiActionRequests.id, id),
            eq(aiActionRequests.workspaceId, workspaceId),
            eq(aiActionRequests.status, "approved"),
            isNull(aiActionRequests.applyClaimedAt),
          ),
        )
        .returning()
      const claimed = rows[0]
      if (claimed) return { request: claimed, claimed: true }
      return { request: await findRequest(db, workspaceId, id), claimed: false }
    },

    /** EXACTLY-ONCE, half two: the same claim, for undo. */
    async claimRequestRevert(
      db: Database,
      workspaceId: string,
      id: string,
      claim: AiActionClaim,
    ): Promise<{ request: AiActionRequest | null; claimed: boolean }> {
      const rows = await db
        .update(aiActionRequests)
        .set({
          revertClaimedAt: claim.claimedAt,
          revertClaimedBy: claim.claimedBy,
          updatedAt: claim.claimedAt,
        })
        .where(
          and(
            eq(aiActionRequests.id, id),
            eq(aiActionRequests.workspaceId, workspaceId),
            eq(aiActionRequests.status, "applied"),
            isNull(aiActionRequests.revertClaimedAt),
          ),
        )
        .returning()
      const claimed = rows[0]
      if (claimed) return { request: claimed, claimed: true }
      return { request: await findRequest(db, workspaceId, id), claimed: false }
    },

    /* ------------------------------- approvals ------------------------------- */

    /**
     * Record THE decision for a request. `created: false` means the
     * request was already decided — the caller must not apply anything.
     * Enforced by `ai_action_approvals_request_idx`, so two approvers
     * clicking at the same instant produce one approval, not two.
     */
    async recordDecision(
      db: Database,
      workspaceId: string,
      input: RecordAiDecisionInput,
    ): Promise<{ approval: AiActionApproval; created: boolean }> {
      const inserted = await db
        .insert(aiActionApprovals)
        .values({
          workspaceId,
          requestId: input.requestId,
          decision: validateAiDecision(input.decision),
          approverId: input.approverId,
          approverRole: input.approverRole ?? null,
          requesterRole: input.requesterRole ?? null,
          reason: input.reason ?? null,
          correlationId: input.correlationId ?? null,
          createdBy: input.approverId,
          updatedBy: input.approverId,
        })
        .onConflictDoNothing({ target: [aiActionApprovals.requestId] })
        .returning()
      const created = inserted[0]
      if (created) return { approval: created, created: true }

      const existing = await db
        .select()
        .from(aiActionApprovals)
        .where(
          and(
            eq(aiActionApprovals.workspaceId, workspaceId),
            eq(aiActionApprovals.requestId, input.requestId),
          ),
        )
        .limit(1)
      const row = existing[0]
      if (!row) {
        throw new AiGovernanceDefinitionError(
          "ai_action_approvals.recordDecision: conflict without a row",
        )
      }
      return { approval: row, created: false }
    },

    async findApprovalByRequest(
      db: Database,
      workspaceId: string,
      requestId: string,
    ): Promise<AiActionApproval | null> {
      const rows = await db
        .select()
        .from(aiActionApprovals)
        .where(
          and(
            eq(aiActionApprovals.workspaceId, workspaceId),
            eq(aiActionApprovals.requestId, requestId),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },
  }
}

export type AiGovernanceRepository = ReturnType<typeof createAiGovernanceRepository>
