import type { ServiceContext } from "../index"
import type { AuditWriter, EventEmitter } from "../ports"
import type { AiActionType, AiActorType, AiPolicyMode } from "./schemas"

/**
 * AI governance ports (spec 38-ai-governance, P0).
 *
 * `@yourcrm/crm` has no database dependency, so this service never imports
 * `@yourcrm/database`. It depends on the structural ports below; the API
 * layer adapts the drizzle repository (`ai-governance-repository.ts`),
 * `writeAudit`, the memberships table and the owning modules' domain
 * services to them, and the hermetic test fakes satisfy them the same way.
 *
 * Four of these ports exist specifically to keep the properties that make
 * this module worth having:
 *
 *  - `AiGovernanceStore.recordDecision` returns `created`, and
 *    `claimRequestApply` / `claimRequestRevert` return `claimed`:
 *    EXACTLY-ONCE is a database uniqueness result, not a decision the
 *    service makes in memory.
 *  - `AiActorRoleResolver` re-reads an actor's LIVE workspace role at
 *    decision time, for BOTH the requester and the approver: PERMISSION
 *    INHERITANCE cannot go stale, and an action can never run with rights
 *    neither of them holds right now.
 *  - `AiActionApplierPort` is the ONLY way a governed change reaches a
 *    record, and it is a DOMAIN SERVICE — governance never writes another
 *    module's tables.
 */

/* --------------------------------- records -------------------------------- */

/** Pass-through record: inputs are zod-validated, outputs flow to envelopes. */
export type AiActionRequestRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  actorId: string
  objectType: string
  action: string
  status: string
}

export type AiActionApprovalRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  requestId: string
  decision: string
  approverId: string
}

export type AiPolicyRecord = Record<string, unknown> & {
  id: string
  workspaceId: string
  objectType: string
  action: string
  mode: string
}

export type AiActionRequestListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  status?: string
  objectType?: string
  recordId?: string
  runId?: string
  actorId?: string
}

export type AiActionRequestListResult = {
  data: AiActionRequestRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

export type AiPolicyListQuery = {
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  objectType?: string
  mode?: string
}

export type AiPolicyListResult = {
  data: AiPolicyRecord[]
  pagination: { nextCursor: string | null; limit: number }
}

/* -------------------------------- the target ------------------------------- */

/**
 * The proposed change, as the applier receives it.
 *
 * POLYMORPHIC ON PURPOSE: `objectType` + `recordId` are plain values, so
 * governance can gate a module it has never heard of. `before` is what a
 * revert restores; `after` is what an apply writes.
 */
export type AiActionMutation = {
  objectType: string
  recordId: string | null
  action: AiActionType
  before: unknown
  after: unknown
}

export type AiActionApplyResult = {
  /** The record the change landed on — a create finally has an id here. */
  recordId: string
  result?: Record<string, unknown>
}

/* ---------------------------------- ports --------------------------------- */

/**
 * THE APPLY SEAM.
 *
 * Applying an approved action means calling the owning module's own domain
 * service — the same path a human edit takes, so its validation, its
 * events and its audit row all happen exactly as they would by hand. This
 * module never writes another module's tables, and there is no second code
 * path that bypasses it.
 *
 * The `ctx` handed to these methods is the INHERITED context: the
 * requesting actor's id with a role that the requester and the approver
 * both still hold. The concrete service then runs its own
 * `requirePermission()` on top, which is the second, independent check.
 *
 * `revertAiAction` must restore `before`:
 *   - `update` -> write `before` back over `after`
 *   - `create` -> delete (soft-delete) the record the apply created
 *   - `delete` -> restore the record
 *   - `send_external` -> not reversible; throw, and the request stays
 *     `applied` with the failure recorded
 *
 * The integrator wires the concrete services (see
 * `apps/api/src/routes/modules/ai-governance.ts`).
 */
export type AiActionApplierPort = {
  applyAiAction(ctx: ServiceContext, input: AiActionMutation): Promise<AiActionApplyResult>
  revertAiAction(
    ctx: ServiceContext,
    input: AiActionMutation & { appliedRecordId: string | null },
  ): Promise<AiActionApplyResult>
}

/**
 * Resolves an actor's LIVE workspace role. Returns `null` when the actor
 * is not (or no longer) a member — in which case the action is refused,
 * never downgraded to a default role.
 *
 * Deliberately identical in shape to `WorkflowActorRoleResolver`: this is
 * the same answer to the same question (how does a non-human actor inherit
 * permissions?) and the product has exactly one answer to it.
 */
export type AiActorRoleResolver = (workspaceId: string, actorId: string) => Promise<string | null>

export type AiActionClaim = {
  claimedBy: string
  claimedAt: Date
}

export type AiGovernanceStore = {
  /* policies */
  listPolicies(workspaceId: string, query: AiPolicyListQuery): Promise<AiPolicyListResult>
  listActivePolicies(workspaceId: string): Promise<AiPolicyRecord[]>
  findPolicyById(workspaceId: string, id: string): Promise<AiPolicyRecord | null>
  createPolicy(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<AiPolicyRecord>
  updatePolicy(
    workspaceId: string,
    id: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<AiPolicyRecord | null>
  softDeletePolicy(workspaceId: string, id: string, actorId?: string): Promise<void>

  /* requests */
  listRequests(
    workspaceId: string,
    query: AiActionRequestListQuery,
  ): Promise<AiActionRequestListResult>
  findRequestById(workspaceId: string, id: string): Promise<AiActionRequestRecord | null>
  createRequest(
    workspaceId: string,
    input: Record<string, unknown>,
    actorId?: string,
  ): Promise<AiActionRequestRecord>
  updateRequest(
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
  ): Promise<AiActionRequestRecord | null>
  /**
   * Record THE one decision this request may receive.
   * `created: false` means it was already decided — the caller must not
   * apply anything. Backed by a UNIQUE index on `request_id`.
   */
  recordDecision(
    workspaceId: string,
    input: Record<string, unknown>,
  ): Promise<{ approval: AiActionApprovalRecord; created: boolean }>
  findApprovalByRequest(
    workspaceId: string,
    requestId: string,
  ): Promise<AiActionApprovalRecord | null>
  /**
   * Claim an approved request for applying. `claimed: false` means
   * somebody (or some retry) already owns it — the caller must NOT call
   * the applier.
   */
  claimRequestApply(
    workspaceId: string,
    id: string,
    claim: AiActionClaim,
  ): Promise<{ request: AiActionRequestRecord | null; claimed: boolean }>
  /** The same claim, for undo: only an `applied` request can be claimed. */
  claimRequestRevert(
    workspaceId: string,
    id: string,
    claim: AiActionClaim,
  ): Promise<{ request: AiActionRequestRecord | null; claimed: boolean }>
}

/** Structural mirror of `WriteAuditInput` (no database import here). */
export type AiGovernanceAuditInput = {
  workspaceId: string
  actorId?: string | null
  action: string
  object: string
  recordId?: string | null
  before?: unknown
  after?: unknown
  correlationId?: string | null
  source?: "user" | "automation" | "ai" | "integration" | "mcp"
}

/**
 * Caller context.
 *
 * `actorType` is what separates a human from a machine at the service
 * boundary: it defaults to `user`, and an `agent` context is refused by
 * every decision method. The HTTP layer always sets `user` (a session is
 * a person); an in-process AI agent sets `agent` when it proposes.
 */
export type AiGovernanceServiceContext = ServiceContext & {
  actorType?: AiActorType
  /** Opaque id of the proposing agent, when `actorType` is `agent`. */
  agentId?: string | null
}

export type AiGovernanceServiceDeps = {
  store: AiGovernanceStore
  audit: AuditWriter<AiGovernanceAuditInput>
  events?: EventEmitter
  applier: AiActionApplierPort
  /** Live role lookup for the requester AND the approver. */
  resolveActorRole: AiActorRoleResolver
  /** Injectable clock so expiry and claim timing are deterministic. */
  now?: () => Date
}

/* --------------------------------- results -------------------------------- */

/** What the policy said about a proposal, and what happened as a result. */
export type AiActionRequestOutcome = {
  request: AiActionRequestRecord
  /** The mode that decided this request. */
  mode: AiPolicyMode
  /** `true` when an `auto_apply` policy applied it inside this call. */
  applied: boolean
}

export type AiActionDecisionOutcome = {
  request: AiActionRequestRecord
  approval: AiActionApprovalRecord
  /** `false` when the claim was lost, i.e. somebody applied it first. */
  applied: boolean
}

export type AiActionApplyOutcome = {
  request: AiActionRequestRecord
  /** `false` means this call did nothing — another call already applied. */
  applied: boolean
}

export type AiActionRevertOutcome = {
  request: AiActionRequestRecord
  reverted: boolean
}

/**
 * THE PORT AN AI AGENT CALLS.
 *
 * Spec 36's agents (and MCP tools, and any future AI feature) depend on
 * this narrow interface, never on the service as a whole: propose, then
 * wait. There is deliberately no "apply" on it — an AI actor cannot
 * approve, and therefore cannot reach the applier.
 */
export type AiActionProposalPort = {
  requestAction(ctx: AiGovernanceServiceContext, input: unknown): Promise<AiActionRequestOutcome>
}
