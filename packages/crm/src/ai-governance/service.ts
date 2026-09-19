import { AiEvents, createEvent, getEventBus } from "@yourcrm/events"
import { requirePermission } from "@yourcrm/permissions"
import {
  assertAiActionAllowed,
  assertAiActorResolved,
  assertHumanApprover,
  assertNotSelfApproval,
  aiGovernancePermission,
  AI_ACTION_OBJECT,
  AI_POLICY_OBJECT,
  type AiActionTarget,
} from "./access"
import { resolveAiPolicy } from "./policy"
import {
  aiActionRequestQuerySchema,
  aiPolicyQuerySchema,
  approveAiActionSchema,
  createAiActionRequestSchema,
  createAiPolicySchema,
  rejectAiActionSchema,
  revertAiActionSchema,
  updateAiPolicySchema,
  AI_ACTION_DEFAULT_TTL_MINUTES,
  type AiActionType,
} from "./schemas"
import type {
  AiActionApplyOutcome,
  AiActionApprovalRecord,
  AiActionDecisionOutcome,
  AiActionMutation,
  AiActionRequestListResult,
  AiActionRequestOutcome,
  AiActionRequestRecord,
  AiActionRevertOutcome,
  AiGovernanceServiceContext,
  AiGovernanceServiceDeps,
  AiPolicyListResult,
  AiPolicyRecord,
} from "./types"

/**
 * AI governance service (spec 38-ai-governance, P0).
 *
 * THE GATE EVERY AI WRITE PASSES THROUGH. An AI agent does not mutate
 * records; it proposes an `ai_action_request` and waits. A human decides.
 * Only then does this service call the owning module's domain service.
 *
 * THE FIVE PROPERTIES
 * -------------------
 * 1. NO PRIVILEGE ESCALATION. An approved action executes with the
 *    permissions of the requesting actor AND the approver — the
 *    intersection, enforced by running the shared `requirePermission()`
 *    once per actor against the same target action (`access.ts`). Both
 *    roles are re-resolved LIVE at decision time, so a demotion takes
 *    effect on everything still in the queue. A viewer cannot approve a
 *    `person:update`, because a viewer cannot update a person.
 *
 * 2. SELF-APPROVAL IS REFUSED. The requesting actor cannot approve its own
 *    request, and any non-`user` actor is refused outright — an AI can
 *    never approve anything, including its own proposal.
 *
 * 3. APPLY IS EXACTLY-ONCE. Two database facts, not in-memory bookkeeping:
 *    a UNIQUE index on `ai_action_approvals (request_id)` means a request
 *    can only ever collect ONE decision, and applying begins with a
 *    conditional UPDATE claim (`status = 'approved' AND apply_claimed_at
 *    IS NULL`) whose loser gets `claimed: false` and returns without
 *    touching the applier. Revert claims the same way.
 *
 * 4. EVERYTHING IS ATTRIBUTABLE. Request, approval, rejection, apply and
 *    revert each write an audit row with `source: "ai"` carrying the
 *    model, the run id, the actor and the correlation id. Applying also
 *    produces the owning module's own audit row, because it goes through
 *    that module's service.
 *
 * 5. NOTHING BYPASSES THE QUEUE. `deps.applier` is referenced in exactly
 *    two private functions, `claimAndApply` and `claimAndRevert`, and
 *    neither can be reached without a successful database claim on a
 *    request that is already `approved` / `applied`. The public surface is
 *    frozen as `AI_GOVERNANCE_SERVICE_METHODS` and asserted by a test, so
 *    adding a method that writes a record directly breaks the build.
 *
 * Nothing here touches Postgres, Redis or HTTP: state leaves through
 * `AiGovernanceStore` and changes leave through `AiActionApplierPort`.
 */

export class AiActionRequestNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`AI action request ${id} not found`)
    this.name = "AiActionRequestNotFoundError"
  }
}

export class AiPolicyNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`AI policy ${id} not found`)
    this.name = "AiPolicyNotFoundError"
  }
}

/** The request is not in a state where this operation makes sense. */
export class AiActionStateError extends Error {
  readonly code = "CONFLICT"
  constructor(message: string) {
    super(message)
    this.name = "AiActionStateError"
  }
}

/** Somebody already decided this request — the UNIQUE index said so. */
export class AiActionAlreadyDecidedError extends Error {
  readonly code = "CONFLICT"
  constructor(decision: string) {
    super(`this request has already been ${decision}`)
    this.name = "AiActionAlreadyDecidedError"
  }
}

/**
 * Correlation-id convention for an AI action, mirroring automation's
 * `wfrun:`. Every audit row and event for one request carries the same id,
 * so an AI change's entire blast radius is greppable from one value — the
 * proposer's own correlation id when it supplied one, this otherwise.
 */
export const AI_ACTION_CORRELATION_PREFIX = "airq:"

export function aiActionCorrelationId(requestId: string): string {
  return `${AI_ACTION_CORRELATION_PREFIX}${requestId}`
}

/** The frozen public surface — see property 5. */
export const AI_GOVERNANCE_SERVICE_METHODS = [
  "apply",
  "approve",
  "createPolicy",
  "deletePolicy",
  "getPolicy",
  "getRequest",
  "listPolicies",
  "listRequests",
  "reject",
  "requestAction",
  "revert",
  "updatePolicy",
] as const

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

export function createAiGovernanceService(deps: AiGovernanceServiceDeps) {
  const events = deps.events ?? getEventBus()
  const now = deps.now ?? (() => new Date())

  /* -------------------------------- helpers ------------------------------- */

  function correlationOf(request: AiActionRequestRecord): string {
    return stringOrNull(request.correlationId) ?? aiActionCorrelationId(request.id)
  }

  function actionTypeOf(request: AiActionRequestRecord): AiActionType {
    // Stored values are validated on the way in (zod at the boundary, the
    // repository allowlist at the table), so this is a narrowing, not a
    // trust decision.
    return request.action as AiActionType
  }

  function targetOf(request: AiActionRequestRecord): AiActionTarget {
    return {
      objectType: request.objectType,
      recordId: stringOrNull(request.recordId),
      action: actionTypeOf(request),
    }
  }

  function mutationOf(request: AiActionRequestRecord): AiActionMutation {
    return {
      objectType: request.objectType,
      recordId: stringOrNull(request.recordId),
      action: actionTypeOf(request),
      before: request.before ?? null,
      after: request.after ?? null,
    }
  }

  /** Attribution block carried by every audit row and event this module writes. */
  function attribution(
    request: AiActionRequestRecord,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      requestId: request.id,
      actorType: request.actorType ?? "agent",
      actorId: request.actorId,
      agentId: stringOrNull(request.agentId),
      model: stringOrNull(request.model),
      runId: stringOrNull(request.runId),
      objectType: request.objectType,
      recordId: stringOrNull(request.recordId),
      action: request.action,
      status: request.status,
      ...extra,
    }
  }

  async function writeAiAudit(
    ctx: AiGovernanceServiceContext,
    request: AiActionRequestRecord,
    action: string,
    payload: Record<string, unknown> = {},
    before?: unknown,
  ): Promise<void> {
    await deps.audit({
      workspaceId: request.workspaceId,
      actorId: ctx.actorId,
      action,
      object: AI_ACTION_OBJECT,
      recordId: request.id,
      ...(before === undefined ? {} : { before }),
      after: attribution(request, payload),
      correlationId: correlationOf(request),
      // Every row in an AI action's trail is `source: "ai"`, so the whole
      // trail is one query (DATA-MODEL-CONTRACTS.md audit contract).
      source: "ai",
    })
  }

  async function emitAiEvent(
    name: string,
    request: AiActionRequestRecord,
    actorId: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await events.emit(
      createEvent({
        event: name,
        workspaceId: request.workspaceId,
        actorId,
        actorType: String(request.actorType ?? "agent") === "agent" ? "ai" : "user",
        entityType: AI_ACTION_OBJECT,
        entityId: request.id,
        after: attribution(request, payload),
        correlationId: correlationOf(request),
      }),
    )
  }

  /** Live role for one actor, or a refusal. Never a default fallback. */
  async function liveActor(
    workspaceId: string,
    actorId: string,
    what: "requester" | "approver",
  ): Promise<{ workspaceId: string; actorId: string; role: string }> {
    const id = stringOrNull(actorId) ?? ""
    const role = id === "" ? null : await deps.resolveActorRole(workspaceId, id)
    assertAiActorResolved(workspaceId, id, role, what)
    return { workspaceId, actorId: id, role }
  }

  async function loadRequest(workspaceId: string, id: string): Promise<AiActionRequestRecord> {
    const found = await deps.store.findRequestById(workspaceId, id)
    if (!found) throw new AiActionRequestNotFoundError(id)
    return found
  }

  /**
   * A pending proposal past its expiry is expired, and the transition is
   * persisted the moment anybody looks at it. An AI proposal that nobody
   * reviewed for days describes a world that has moved on.
   */
  async function maybeExpire(request: AiActionRequestRecord): Promise<AiActionRequestRecord> {
    if (request.status !== "pending") return request
    const expiresAt = toDate(request.expiresAt)
    if (expiresAt === null || expiresAt.getTime() > now().getTime()) return request
    const expired = await deps.store.updateRequest(request.workspaceId, request.id, {
      status: "expired",
    })
    return expired ?? { ...request, status: "expired" }
  }

  /* ------------------------------- policies ------------------------------- */

  async function listPolicies(
    ctx: AiGovernanceServiceContext,
    rawQuery: unknown,
  ): Promise<AiPolicyListResult> {
    requirePermission(aiGovernancePermission(ctx, "read", AI_POLICY_OBJECT))
    const query = aiPolicyQuerySchema.parse(rawQuery)
    return deps.store.listPolicies(ctx.workspaceId, query)
  }

  async function getPolicy(ctx: AiGovernanceServiceContext, id: string): Promise<AiPolicyRecord> {
    requirePermission(aiGovernancePermission(ctx, "read", AI_POLICY_OBJECT))
    const found = await deps.store.findPolicyById(ctx.workspaceId, id)
    if (!found) throw new AiPolicyNotFoundError(id)
    return found
  }

  /**
   * Writing policy is an ADMIN act: a policy is what decides whether a
   * human ever sees an AI change, so loosening one is the most powerful
   * button in the module (spec 38 §8 — security/admin roles).
   */
  async function createPolicy(
    ctx: AiGovernanceServiceContext,
    rawInput: unknown,
  ): Promise<AiPolicyRecord> {
    requirePermission(aiGovernancePermission(ctx, "admin", AI_POLICY_OBJECT))
    const input = createAiPolicySchema.parse(rawInput)
    const policy = await deps.store.createPolicy(ctx.workspaceId, input, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "create",
      object: AI_POLICY_OBJECT,
      recordId: policy.id,
      after: policy,
      correlationId: ctx.correlationId ?? null,
      source: "user",
    })
    return policy
  }

  async function updatePolicy(
    ctx: AiGovernanceServiceContext,
    id: string,
    rawPatch: unknown,
  ): Promise<AiPolicyRecord> {
    requirePermission(aiGovernancePermission(ctx, "admin", AI_POLICY_OBJECT))
    const patch = updateAiPolicySchema.parse(rawPatch)
    const before = await deps.store.findPolicyById(ctx.workspaceId, id)
    if (!before) throw new AiPolicyNotFoundError(id)
    const after = await deps.store.updatePolicy(ctx.workspaceId, id, patch, ctx.actorId)
    if (!after) throw new AiPolicyNotFoundError(id)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "update",
      object: AI_POLICY_OBJECT,
      recordId: id,
      before,
      after,
      correlationId: ctx.correlationId ?? null,
      source: "user",
    })
    return after
  }

  async function deletePolicy(
    ctx: AiGovernanceServiceContext,
    id: string,
  ): Promise<AiPolicyRecord> {
    requirePermission(aiGovernancePermission(ctx, "admin", AI_POLICY_OBJECT))
    const before = await deps.store.findPolicyById(ctx.workspaceId, id)
    if (!before) throw new AiPolicyNotFoundError(id)
    await deps.store.softDeletePolicy(ctx.workspaceId, id, ctx.actorId)
    await deps.audit({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action: "delete",
      object: AI_POLICY_OBJECT,
      recordId: id,
      before,
      correlationId: ctx.correlationId ?? null,
      source: "user",
    })
    // Deleting a policy tightens the gate: the scope falls back to the
    // deny-by-human default, never to auto-apply.
    return before
  }

  /* -------------------------------- the queue ------------------------------ */

  async function listRequests(
    ctx: AiGovernanceServiceContext,
    rawQuery: unknown,
  ): Promise<AiActionRequestListResult> {
    requirePermission(aiGovernancePermission(ctx, "read"))
    const query = aiActionRequestQuerySchema.parse(rawQuery)
    return deps.store.listRequests(ctx.workspaceId, query)
  }

  async function getRequest(
    ctx: AiGovernanceServiceContext,
    id: string,
  ): Promise<{ request: AiActionRequestRecord; approval: AiActionApprovalRecord | null }> {
    requirePermission(aiGovernancePermission(ctx, "read"))
    const request = await maybeExpire(await loadRequest(ctx.workspaceId, id))
    const approval = await deps.store.findApprovalByRequest(ctx.workspaceId, id)
    return { request, approval }
  }

  /**
   * THE ENTRY POINT FOR AI. Everything an AI wants to change starts here,
   * as data, before anything happens.
   *
   * Order matters:
   *  1. `run_ai` — may this caller use AI at all?
   *  2. validate the proposal (a rationale is mandatory);
   *  3. resolve the requester's LIVE role and check the TARGET action
   *     against it, so an AI cannot even queue what its principal could
   *     not do by hand. A denial throws before any row exists — a refused
   *     proposal is not a request.
   *  4. resolve the policy: `forbidden` records the proposal as rejected
   *     and returns (the agent gets a governed refusal, not an exception
   *     it might retry); `auto_apply` records it as approved and applies
   *     it through the same claim as a human approval; anything else —
   *     including every unconfigured scope — waits for a person.
   */
  async function requestAction(
    ctx: AiGovernanceServiceContext,
    rawInput: unknown,
  ): Promise<AiActionRequestOutcome> {
    requirePermission(aiGovernancePermission(ctx, "run_ai"))
    const input = createAiActionRequestSchema.parse(rawInput)
    const requester = await liveActor(ctx.workspaceId, ctx.actorId, "requester")
    const target: AiActionTarget = {
      objectType: input.objectType,
      recordId: input.recordId ?? null,
      action: input.action,
    }
    assertAiActionAllowed([requester], target)

    const policies = await deps.store.listActivePolicies(ctx.workspaceId)
    const resolution = resolveAiPolicy(policies, {
      objectType: input.objectType,
      action: input.action,
    })
    const status =
      resolution.mode === "forbidden"
        ? "rejected"
        : resolution.mode === "auto_apply"
          ? "approved"
          : "pending"
    const ttl = input.expiresInMinutes ?? AI_ACTION_DEFAULT_TTL_MINUTES

    const request = await deps.store.createRequest(
      ctx.workspaceId,
      {
        actorType: ctx.actorType ?? "agent",
        actorId: ctx.actorId,
        agentId: input.agentId ?? ctx.agentId ?? null,
        model: input.model ?? null,
        runId: input.runId ?? null,
        correlationId: ctx.correlationId ?? null,
        objectType: input.objectType,
        recordId: input.recordId ?? null,
        action: input.action,
        before: input.before ?? null,
        after: input.after ?? null,
        rationale: input.rationale,
        status,
        policyId: resolution.policyId,
        policyMode: resolution.mode,
        requestedRole: requester.role,
        expiresAt: status === "pending" ? new Date(now().getTime() + ttl * 60_000) : null,
        ...(status === "rejected" ? { decidedAt: now() } : {}),
      },
      ctx.actorId,
    )

    await writeAiAudit(ctx, request, "request", {
      policyMode: resolution.mode,
      policyScope: resolution.scope,
      rationale: request.rationale ?? null,
    })
    await emitAiEvent(AiEvents.ActionRequested, request, ctx.actorId, {
      policyMode: resolution.mode,
      policyScope: resolution.scope,
    })

    if (resolution.mode === "forbidden") {
      return { request, mode: resolution.mode, applied: false }
    }
    if (resolution.mode === "auto_apply") {
      // No human decided, so the intersection is the requester alone —
      // still the full permission check, still claimed, still audited.
      const outcome = await claimAndApply(ctx, request, [requester], requester.role)
      return { request: outcome.request, mode: resolution.mode, applied: outcome.applied }
    }
    return { request, mode: resolution.mode, applied: false }
  }

  /**
   * Approve, then apply. One human act, so it is one call: recording an
   * approval that nothing acts on would leave the queue lying about what
   * happened.
   *
   * The base permission is `read` on purpose. The authority to approve is
   * NOT a separate privilege to be handed out — it is the authority to
   * make the change by hand, which `assertAiActionAllowed` checks against
   * the approver and the requester together. A viewer reaches this method
   * and is refused by that gate, which is exactly the property under test.
   */
  async function approve(
    ctx: AiGovernanceServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<AiActionDecisionOutcome> {
    requirePermission(aiGovernancePermission(ctx, "read"))
    assertHumanApprover(ctx)
    const input = approveAiActionSchema.parse(rawInput ?? {})
    const request = await maybeExpire(await loadRequest(ctx.workspaceId, id))
    if (request.status !== "pending") {
      throw new AiActionStateError(
        `only a pending request can be approved (this one is ${request.status})`,
      )
    }
    assertNotSelfApproval(request.actorId, ctx.actorId)

    // PERMISSION INHERITANCE: both roles read LIVE, both checked against
    // the same target action. The narrower wins because the wider one
    // cannot lend rights it is not being asked for.
    const requester = await liveActor(ctx.workspaceId, request.actorId, "requester")
    const approver = await liveActor(ctx.workspaceId, ctx.actorId, "approver")
    assertAiActionAllowed([requester, approver], targetOf(request))

    const { approval, created } = await deps.store.recordDecision(ctx.workspaceId, {
      requestId: request.id,
      decision: "approved",
      approverId: approver.actorId,
      approverRole: approver.role,
      requesterRole: requester.role,
      reason: input.reason ?? null,
      correlationId: correlationOf(request),
    })
    // EXACTLY-ONCE, first line: the UNIQUE index already holds a decision.
    if (!created) throw new AiActionAlreadyDecidedError(String(approval.decision))

    const approved = (await deps.store.updateRequest(ctx.workspaceId, request.id, {
      status: "approved",
      decidedAt: now(),
    })) ?? { ...request, status: "approved" }

    await writeAiAudit(ctx, approved, "approve", {
      approverId: approver.actorId,
      approverRole: approver.role,
      requesterRole: requester.role,
      reason: input.reason ?? null,
    })
    await emitAiEvent(AiEvents.ActionApproved, approved, approver.actorId, {
      approverId: approver.actorId,
    })

    const outcome = await claimAndApply(ctx, approved, [requester, approver], requester.role)
    return { request: outcome.request, approval, applied: outcome.applied }
  }

  /**
   * Refuse a proposal. Needs only queue access and a reason: refusing an
   * AI write is the safe direction, and must never be harder than
   * approving one. Self-rejection is allowed — withdrawing your own
   * proposal is not an escalation.
   */
  async function reject(
    ctx: AiGovernanceServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<AiActionDecisionOutcome> {
    requirePermission(aiGovernancePermission(ctx, "read"))
    assertHumanApprover(ctx)
    const input = rejectAiActionSchema.parse(rawInput)
    const request = await maybeExpire(await loadRequest(ctx.workspaceId, id))
    if (request.status !== "pending") {
      throw new AiActionStateError(
        `only a pending request can be rejected (this one is ${request.status})`,
      )
    }
    const approver = await liveActor(ctx.workspaceId, ctx.actorId, "approver")

    const { approval, created } = await deps.store.recordDecision(ctx.workspaceId, {
      requestId: request.id,
      decision: "rejected",
      approverId: approver.actorId,
      approverRole: approver.role,
      requesterRole: stringOrNull(request.requestedRole),
      reason: input.reason,
      correlationId: correlationOf(request),
    })
    if (!created) throw new AiActionAlreadyDecidedError(String(approval.decision))

    const rejected = (await deps.store.updateRequest(ctx.workspaceId, request.id, {
      status: "rejected",
      decidedAt: now(),
    })) ?? { ...request, status: "rejected" }

    await writeAiAudit(ctx, rejected, "reject", {
      approverId: approver.actorId,
      approverRole: approver.role,
      reason: input.reason,
    })
    // NOTE: `@yourcrm/events` has no `ai.action_rejected` constant. A
    // missing constant is a blocker to report, never a string literal —
    // the rejection is fully recorded in the audit trail meanwhile.
    return { request: rejected, approval, applied: false }
  }

  /**
   * Apply an already-approved request. Exists for the retry path and for
   * the `auto_apply` policy; a human approval applies inline.
   *
   * Calling it twice is safe and is the point: the second call loses the
   * claim and returns `applied: false` without going near the applier.
   */
  async function apply(ctx: AiGovernanceServiceContext, id: string): Promise<AiActionApplyOutcome> {
    requirePermission(aiGovernancePermission(ctx, "read"))
    assertHumanApprover(ctx)
    const request = await loadRequest(ctx.workspaceId, id)
    if (request.status !== "approved") {
      throw new AiActionStateError(
        `only an approved request can be applied (this one is ${request.status})`,
      )
    }
    const requester = await liveActor(ctx.workspaceId, request.actorId, "requester")
    const approval = await deps.store.findApprovalByRequest(ctx.workspaceId, id)
    // An auto-applied request has no human approver; one that a person
    // approved is re-checked against that person's LIVE role too.
    const actors =
      approval === null
        ? [requester]
        : [requester, await liveActor(ctx.workspaceId, String(approval.approverId), "approver")]
    return claimAndApply(ctx, request, actors, requester.role)
  }

  /**
   * THE ONLY PATH TO THE APPLIER (property 5), and it starts with a
   * database claim.
   *
   * The claim is a conditional UPDATE on `status = 'approved' AND
   * apply_claimed_at IS NULL`. Whoever wins it applies; everybody else —
   * a double click, a retried job, a second worker — gets
   * `claimed: false` and returns having done nothing.
   *
   * The permission intersection is re-asserted AFTER the claim: the claim
   * froze the row, not the roles, and this is the last moment before a
   * record changes.
   *
   * A failed apply deliberately keeps its claim. At-most-once beats a
   * silent second attempt; the error is recorded and a human can propose
   * the action again, which produces a new, separately auditable request.
   */
  async function claimAndApply(
    ctx: AiGovernanceServiceContext,
    request: AiActionRequestRecord,
    actors: readonly { workspaceId: string; actorId: string; role: string }[],
    inheritedRole: string,
  ): Promise<AiActionApplyOutcome> {
    const claim = await deps.store.claimRequestApply(ctx.workspaceId, request.id, {
      claimedBy: ctx.actorId,
      claimedAt: now(),
    })
    if (!claim.claimed) {
      return { request: claim.request ?? request, applied: false }
    }
    const claimed = claim.request ?? request
    assertAiActionAllowed(actors, targetOf(claimed))

    // The inherited context: the REQUESTING actor's identity and live
    // role. The approver's rights were just enforced by the intersection;
    // the domain service will run its own `requirePermission()` on this
    // context, which is the second, independent check.
    const inherited = {
      workspaceId: ctx.workspaceId,
      actorId: String(claimed.actorId),
      role: inheritedRole,
      correlationId: correlationOf(claimed),
    }

    try {
      const result = await deps.applier.applyAiAction(inherited, mutationOf(claimed))
      const applied = (await deps.store.updateRequest(ctx.workspaceId, claimed.id, {
        status: "applied",
        appliedAt: now(),
        applyResult: result,
        applyError: null,
      })) ?? { ...claimed, status: "applied" }
      await writeAiAudit(
        ctx,
        applied,
        "apply",
        { appliedRecordId: result.recordId },
        claimed.before,
      )
      return { request: applied, applied: true }
    } catch (err) {
      const message = errorMessage(err)
      const failed =
        (await deps.store.updateRequest(ctx.workspaceId, claimed.id, {
          applyError: message,
        })) ?? claimed
      await writeAiAudit(ctx, failed, "apply_failed", { error: message })
      throw err
    }
  }

  /**
   * One-click undo (spec 38 §3). Restores the recorded `before` through
   * the owning module's service — never by writing tables here.
   *
   * Checked against the REVERTING human alone, not the original pair:
   * undoing an AI change is the safe direction and must never be harder
   * than making it, the same reason disabling an automation is cheaper
   * than enabling one. It still requires the permission to perform that
   * action on that object by hand.
   */
  async function revert(
    ctx: AiGovernanceServiceContext,
    id: string,
    rawInput: unknown,
  ): Promise<AiActionRevertOutcome> {
    requirePermission(aiGovernancePermission(ctx, "read"))
    assertHumanApprover(ctx)
    const input = revertAiActionSchema.parse(rawInput ?? {})
    const request = await loadRequest(ctx.workspaceId, id)
    if (request.status !== "applied") {
      throw new AiActionStateError(
        `only an applied request can be reverted (this one is ${request.status})`,
      )
    }
    const reverter = await liveActor(ctx.workspaceId, ctx.actorId, "approver")
    assertAiActionAllowed([reverter], targetOf(request))

    const claim = await deps.store.claimRequestRevert(ctx.workspaceId, request.id, {
      claimedBy: ctx.actorId,
      claimedAt: now(),
    })
    if (!claim.claimed) {
      return { request: claim.request ?? request, reverted: false }
    }
    const claimed = claim.request ?? request
    const appliedRecordId =
      stringOrNull((claimed.applyResult as { recordId?: unknown } | null)?.recordId) ??
      stringOrNull(claimed.recordId)

    try {
      const result = await deps.applier.revertAiAction(
        {
          workspaceId: ctx.workspaceId,
          actorId: ctx.actorId,
          role: reverter.role,
          correlationId: correlationOf(claimed),
        },
        { ...mutationOf(claimed), appliedRecordId },
      )
      const reverted = (await deps.store.updateRequest(ctx.workspaceId, claimed.id, {
        status: "reverted",
        revertedAt: now(),
        revertError: null,
      })) ?? { ...claimed, status: "reverted" }
      await writeAiAudit(
        ctx,
        reverted,
        "revert",
        {
          revertedBy: ctx.actorId,
          revertedRecordId: result.recordId,
          reason: input.reason ?? null,
        },
        claimed.after,
      )
      await emitAiEvent(AiEvents.ActionReverted, reverted, ctx.actorId, {
        revertedBy: ctx.actorId,
      })
      return { request: reverted, reverted: true }
    } catch (err) {
      const message = errorMessage(err)
      const failed =
        (await deps.store.updateRequest(ctx.workspaceId, claimed.id, {
          revertError: message,
        })) ?? claimed
      await writeAiAudit(ctx, failed, "revert_failed", { error: message })
      throw err
    }
  }

  return {
    apply,
    approve,
    createPolicy,
    deletePolicy,
    getPolicy,
    getRequest,
    listPolicies,
    listRequests,
    reject,
    requestAction,
    revert,
    updatePolicy,
  }
}

export type AiGovernanceService = ReturnType<typeof createAiGovernanceService>
