import { and, asc, desc, eq, ilike, isNull, or, type SQL } from "drizzle-orm"
import type { Database } from "../client"
import { notifications } from "../schema/system"
import { tags } from "../schema/tags"
import {
  isWorkflowActionType,
  isWorkflowRunStatus,
  isWorkflowRunStepStatus,
  isWorkflowStatus,
  WORKFLOW_MAX_ACTIONS,
  workflowRunSteps,
  workflowRuns,
  workflows,
  type NewWorkflow,
  type Workflow,
  type WorkflowActionConfig,
  type WorkflowFilterNode,
  type WorkflowFilterTree,
  type WorkflowRun,
  type WorkflowRunStep,
} from "../schema/automation"
import { createBaseRepository } from "./base-repository"
import { createCompaniesRepository } from "./companies-repository"
import { createDealsRepository } from "./deals-repository"
import { createLeadsRepository } from "./leads-repository"
import { createPeopleRepository } from "./people-repository"
import { createTagsRepository, normalizeTagName } from "./tags-repository"
import { createTasksRepository } from "./tasks-repository"

/**
 * Workflow automation repository (spec 25-automation, P0).
 *
 * Three concerns, one file because they share a transaction boundary in
 * practice: definitions (`workflows`), runs (`workflow_runs`) and step
 * results (`workflow_run_steps`).
 *
 * THE TWO IDEMPOTENT WRITES
 * -------------------------
 * `createWorkflowRun` and `claimWorkflowRunStep` both insert with
 * `ON CONFLICT DO NOTHING` against a UNIQUE index and, on conflict, select
 * the existing row and report `created: false` / `claimed: false`. That is
 * the whole idempotency mechanism: it lives in Postgres, not in a cache,
 * so two workers racing on the same redelivered event still produce one
 * run and one attempt per action.
 *
 * Everything user-supplied is validated here before it reaches SQL:
 * statuses and action types against the schema allowlists, names and JSON
 * shapes structurally. Values are always bound by drizzle, never
 * interpolated.
 */

export class WorkflowDefinitionError extends Error {
  readonly code = "INVALID_WORKFLOW"
  constructor(message: string) {
    super(message)
    this.name = "WorkflowDefinitionError"
  }
}

/* ------------------------------ validation ------------------------------- */

/** Trimmed, non-empty workflow name (max 255, mirrors the column). */
export function normalizeWorkflowName(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new WorkflowDefinitionError("workflow name must not be empty")
  if (trimmed.length > 255) {
    throw new WorkflowDefinitionError("workflow name must be at most 255 characters")
  }
  return trimmed
}

function isFilterNode(value: unknown): value is WorkflowFilterNode {
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  if (node.type === "condition") {
    return (
      typeof node.id === "string" &&
      typeof node.field === "string" &&
      typeof node.operator === "string"
    )
  }
  if (node.type === "group") {
    return (
      typeof node.id === "string" &&
      (node.combinator === "and" || node.combinator === "or") &&
      Array.isArray(node.children) &&
      node.children.every(isFilterNode)
    )
  }
  return false
}

/**
 * Structural check on a stored condition tree. The root is always a group
 * (an empty group means "match everything"); the encoding is the one
 * `@yourcrm/ui`'s FilterBuilder produces, restated in `schema/automation.ts`.
 */
export function validateWorkflowConditions(value: unknown): WorkflowFilterTree | null {
  if (value === null || value === undefined) return null
  if (!isFilterNode(value) || value.type !== "group") {
    throw new WorkflowDefinitionError("conditions must be a FilterBuilder group node")
  }
  return value
}

/**
 * Ordered action list. Only the P0 action types are storable, so a
 * definition can never name an action the executor has no binding for.
 */
export function validateWorkflowActions(value: unknown): WorkflowActionConfig[] {
  if (!Array.isArray(value)) throw new WorkflowDefinitionError("actions must be an array")
  if (value.length === 0) throw new WorkflowDefinitionError("a workflow needs at least one action")
  if (value.length > WORKFLOW_MAX_ACTIONS) {
    throw new WorkflowDefinitionError(`a workflow may have at most ${WORKFLOW_MAX_ACTIONS} actions`)
  }
  return value.map((action, index) => {
    if (typeof action !== "object" || action === null) {
      throw new WorkflowDefinitionError(`action ${index} must be an object`)
    }
    const type = (action as Record<string, unknown>).type
    if (!isWorkflowActionType(type)) {
      throw new WorkflowDefinitionError(
        `action ${index} has unknown type '${String(type)}' (create_task, update_field, add_tag, notify)`,
      )
    }
    return action as WorkflowActionConfig
  })
}

export function validateWorkflowStatus(value: unknown): string {
  if (!isWorkflowStatus(value)) {
    throw new WorkflowDefinitionError("status must be 'enabled' or 'disabled'")
  }
  return value
}

function validateTriggerEvent(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 64) {
    throw new WorkflowDefinitionError("triggerEvent must be a domain event name")
  }
  return trimmed
}

/* --------------------------------- inputs -------------------------------- */

export type CreateWorkflowInput = {
  name: string
  description?: string | null
  triggerEvent: string
  triggerEntityType?: string | null
  conditions?: unknown
  actions: unknown
  status?: string | null
  ownerId?: string | null
}

export type UpdateWorkflowInput = Partial<CreateWorkflowInput>

export type WorkflowSearchOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  query?: string
  status?: string
  triggerEvent?: string
}

export type CreateWorkflowRunInput = {
  workflowId: string
  triggerEventId: string
  triggerEvent: string
  entityType?: string | null
  entityId?: string | null
  triggerPayload?: unknown
  status?: string | null
  depth?: number
  parentRunId?: string | null
  actorId?: string | null
  actorRole?: string | null
  correlationId?: string | null
  error?: string | null
}

export type UpdateWorkflowRunInput = Partial<{
  status: string
  error: string | null
  startedAt: Date | null
  finishedAt: Date | null
  actorRole: string | null
}>

export type WorkflowRunSearchOptions = {
  workspaceId: string
  limit?: number
  cursor?: string
  order?: "asc" | "desc"
  workflowId?: string
  status?: string
}

export type ClaimWorkflowRunStepInput = {
  runId: string
  stepIndex: number
  actionType: string
}

export type CompleteWorkflowRunStepInput = Partial<{
  status: string
  result: unknown
  error: string | null
}>

function toWorkflowValues(
  input: CreateWorkflowInput | UpdateWorkflowInput,
  actorId?: string,
): Partial<NewWorkflow> {
  const values: Partial<NewWorkflow> = {}
  if (input.name !== undefined) values.name = normalizeWorkflowName(input.name)
  if (input.description !== undefined) values.description = input.description?.trim() || null
  if (input.triggerEvent !== undefined)
    values.triggerEvent = validateTriggerEvent(input.triggerEvent)
  if (input.triggerEntityType !== undefined) {
    values.triggerEntityType = input.triggerEntityType?.trim() || null
  }
  if (input.conditions !== undefined)
    values.conditions = validateWorkflowConditions(input.conditions)
  if (input.actions !== undefined) values.actions = validateWorkflowActions(input.actions)
  if (input.status !== undefined && input.status !== null) {
    values.status = validateWorkflowStatus(input.status)
  }
  if (input.ownerId !== undefined) values.ownerId = input.ownerId
  if (actorId !== undefined) values.updatedBy = actorId
  return values
}

/* --------------------------- action target registry ------------------------ */

/**
 * Objects an `update_field` action may touch, and the fields it may write.
 *
 * This is the same idea as `REPORT_OBJECTS` in `reports-repository.ts`: an
 * allowlist is the ONLY way to reach a table, and naming a field is the
 * only way to make it writable. Consequences that matter:
 *
 *  - no user string ever becomes a column name; unknown keys throw rather
 *    than silently no-op;
 *  - identity, workspace scoping and soft-delete columns are unreachable,
 *    so an automation cannot move a record between workspaces or
 *    resurrect one;
 *  - each write goes through the owning module's own repository contract,
 *    so that module's normalisation and validation still run. The engine
 *    duplicates no business rules.
 *
 * Permission is checked BEFORE this is reached, against the workflow
 * owner's live role (`@yourcrm/crm/src/automation/access.ts`).
 */
export type WorkflowTargetDef = {
  objectType: string
  fields: readonly string[]
  update(
    db: Database,
    workspaceId: string,
    id: string,
    patch: Record<string, unknown>,
    actorId?: string,
  ): Promise<{ id: string } | null>
}

function targetDef(
  objectType: string,
  fields: readonly string[],
  update: WorkflowTargetDef["update"],
): WorkflowTargetDef {
  return { objectType, fields, update }
}

export const WORKFLOW_TARGET_OBJECTS: Record<string, WorkflowTargetDef> = {
  person: targetDef(
    "person",
    ["firstName", "lastName", "title", "companyId", "ownerId", "notes", "status"],
    async (db, workspaceId, id, patch, actorId) =>
      createPeopleRepository().update(db, workspaceId, id, patch, actorId),
  ),
  company: targetDef(
    "company",
    ["name", "domain", "website", "industry", "size", "ownerId", "description", "status"],
    async (db, workspaceId, id, patch, actorId) =>
      createCompaniesRepository().update(db, workspaceId, id, patch, actorId),
  ),
  lead: targetDef(
    "lead",
    [
      "firstName",
      "lastName",
      "companyName",
      "title",
      "ownerId",
      "notes",
      "source",
      "status",
      "score",
    ],
    async (db, workspaceId, id, patch, actorId) =>
      createLeadsRepository().update(db, workspaceId, id, patch, actorId),
  ),
  deal: targetDef(
    "deal",
    ["name", "amount", "currency", "ownerId", "closeReason", "notes", "probability"],
    async (db, workspaceId, id, patch, actorId) =>
      createDealsRepository().update(db, workspaceId, id, patch, actorId),
  ),
  task: targetDef(
    "task",
    ["title", "description", "assigneeId", "ownerId", "status", "priority"],
    async (db, workspaceId, id, patch, actorId) =>
      createTasksRepository().update(db, workspaceId, id, patch, actorId),
  ),
}

/** Serialisable catalogue of writable targets, for the web builder. */
export function describeWorkflowTargets(): { objectType: string; fields: string[] }[] {
  return Object.values(WORKFLOW_TARGET_OBJECTS).map((def) => ({
    objectType: def.objectType,
    fields: [...def.fields],
  }))
}

export function resolveWorkflowTargetField(objectType: string, field: string): WorkflowTargetDef {
  const def = WORKFLOW_TARGET_OBJECTS[objectType]
  if (!def) {
    throw new WorkflowDefinitionError(
      `automations cannot update '${objectType}' records (allowed: ${Object.keys(WORKFLOW_TARGET_OBJECTS).join(", ")})`,
    )
  }
  if (!def.fields.includes(field)) {
    throw new WorkflowDefinitionError(
      `'${field}' is not an automatable field on ${objectType} (allowed: ${def.fields.join(", ")})`,
    )
  }
  return def
}

/* ------------------------------- repository ------------------------------- */

export function createAutomationRepository() {
  const base = createBaseRepository(workflows)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateWorkflowInput,
      actorId?: string,
    ): Promise<Workflow> {
      const rows = await db
        .insert(workflows)
        .values({
          ...toWorkflowValues(input, actorId),
          workspaceId,
          name: normalizeWorkflowName(input.name),
          triggerEvent: validateTriggerEvent(input.triggerEvent),
          actions: validateWorkflowActions(input.actions),
          // A workflow is off until somebody enables it explicitly.
          status: input.status == null ? "disabled" : validateWorkflowStatus(input.status),
          ownerId: input.ownerId ?? actorId ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new WorkflowDefinitionError("workflows.create: insert returned no rows")
      return row
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      input: UpdateWorkflowInput,
      actorId?: string,
    ): Promise<Workflow | null> {
      const rows = await db
        .update(workflows)
        .set({ ...toWorkflowValues(input, actorId), updatedAt: new Date() })
        .where(
          and(
            eq(workflows.id, id),
            eq(workflows.workspaceId, workspaceId),
            isNull(workflows.deletedAt),
          ),
        )
        .returning()
      return rows[0] ?? null
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Workflow | null> {
      // The shared base narrows rows to the BaseRecord columns; re-cast here
      // so callers get the full Workflow shape.
      return ((await base.findById(db, workspaceId, id)) as Workflow | null) ?? null
    },

    /** Cursor-paginated definition list with search + status/trigger filters. */
    async search(db: Database, opts: WorkflowSearchOptions) {
      const conditions: SQL[] = []
      if (opts.query) {
        const q = `%${opts.query.trim()}%`
        const match = or(ilike(workflows.name, q), ilike(workflows.description, q))
        if (match) conditions.push(match)
      }
      if (opts.status) conditions.push(eq(workflows.status, validateWorkflowStatus(opts.status)))
      if (opts.triggerEvent) {
        conditions.push(eq(workflows.triggerEvent, validateTriggerEvent(opts.triggerEvent)))
      }
      const result = await base.list(db, { ...opts, where: conditions })
      return { data: result.data as Workflow[], pagination: result.pagination }
    },

    /**
     * The dispatcher's hot path: every live, ENABLED workflow in this
     * workspace listening to this event. Disabled definitions never reach
     * the engine, so "off" is enforced in SQL rather than in a branch.
     */
    async listEnabledByTrigger(
      db: Database,
      workspaceId: string,
      triggerEvent: string,
    ): Promise<Workflow[]> {
      return db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.workspaceId, workspaceId),
            eq(workflows.triggerEvent, validateTriggerEvent(triggerEvent)),
            eq(workflows.status, "enabled"),
            isNull(workflows.deletedAt),
          ),
        )
        .orderBy(asc(workflows.createdAt))
    },

    async markWorkflowRan(
      db: Database,
      workspaceId: string,
      id: string,
      at: Date = new Date(),
    ): Promise<void> {
      await db
        .update(workflows)
        .set({ lastRunAt: at })
        .where(and(eq(workflows.id, id), eq(workflows.workspaceId, workspaceId)))
    },

    /* ----------------------------- runs ----------------------------- */

    /**
     * IDEMPOTENT run creation. `workflow_runs_event_idx` is UNIQUE over
     * (workflow_id, trigger_event_id), so a redelivered event conflicts and
     * the existing run comes back with `created: false`. Callers use that
     * flag to decide whether to enqueue — which is why a redelivery never
     * re-applies the workflow's actions.
     */
    async createRun(
      db: Database,
      workspaceId: string,
      input: CreateWorkflowRunInput,
    ): Promise<{ run: WorkflowRun; created: boolean }> {
      const status = input.status == null ? "queued" : input.status
      if (!isWorkflowRunStatus(status)) {
        throw new WorkflowDefinitionError(`unknown run status '${String(status)}'`)
      }
      const inserted = await db
        .insert(workflowRuns)
        .values({
          workspaceId,
          workflowId: input.workflowId,
          triggerEventId: input.triggerEventId,
          triggerEvent: validateTriggerEvent(input.triggerEvent),
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          triggerPayload: input.triggerPayload ?? null,
          status,
          depth: input.depth ?? 0,
          parentRunId: input.parentRunId ?? null,
          actorId: input.actorId ?? null,
          actorRole: input.actorRole ?? null,
          correlationId: input.correlationId ?? null,
          error: input.error ?? null,
        })
        .onConflictDoNothing({ target: [workflowRuns.workflowId, workflowRuns.triggerEventId] })
        .returning()
      const created = inserted[0]
      if (created) return { run: created, created: true }

      const existing = await db
        .select()
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workspaceId, workspaceId),
            eq(workflowRuns.workflowId, input.workflowId),
            eq(workflowRuns.triggerEventId, input.triggerEventId),
          ),
        )
        .limit(1)
      const row = existing[0]
      if (!row) throw new WorkflowDefinitionError("workflow_runs.create: conflict without a row")
      return { run: row, created: false }
    },

    async findRunById(db: Database, workspaceId: string, id: string): Promise<WorkflowRun | null> {
      const rows = await db
        .select()
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, id), eq(workflowRuns.workspaceId, workspaceId)))
        .limit(1)
      return rows[0] ?? null
    },

    async searchRuns(db: Database, opts: WorkflowRunSearchOptions) {
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200)
      const conditions: SQL[] = [eq(workflowRuns.workspaceId, opts.workspaceId)]
      if (opts.workflowId) conditions.push(eq(workflowRuns.workflowId, opts.workflowId))
      if (opts.status) {
        if (!isWorkflowRunStatus(opts.status)) {
          throw new WorkflowDefinitionError(`unknown run status '${opts.status}'`)
        }
        conditions.push(eq(workflowRuns.status, opts.status))
      }
      const rows = await db
        .select()
        .from(workflowRuns)
        .where(and(...conditions))
        .orderBy(opts.order === "asc" ? asc(workflowRuns.createdAt) : desc(workflowRuns.createdAt))
        .limit(limit + 1)
      const hasMore = rows.length > limit
      const data = hasMore ? rows.slice(0, limit) : rows
      const last = data[data.length - 1]
      return {
        data,
        pagination: { nextCursor: hasMore ? (last?.id ?? null) : null, limit },
      }
    },

    async updateRun(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateWorkflowRunInput,
    ): Promise<WorkflowRun | null> {
      if (patch.status !== undefined && !isWorkflowRunStatus(patch.status)) {
        throw new WorkflowDefinitionError(`unknown run status '${patch.status}'`)
      }
      const rows = await db
        .update(workflowRuns)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(workflowRuns.id, id), eq(workflowRuns.workspaceId, workspaceId)))
        .returning()
      return rows[0] ?? null
    },

    /* ---------------------------- run steps ---------------------------- */

    /**
     * IDEMPOTENT step claim. `workflow_run_steps_index_idx` is UNIQUE over
     * (run_id, step_index): the first attempt inserts a `running` row and
     * gets `claimed: true`; a retry of the same job conflicts, gets
     * `claimed: false` plus the previous outcome, and skips the action.
     * That is what makes a retried run resume instead of re-applying.
     */
    async claimRunStep(
      db: Database,
      workspaceId: string,
      input: ClaimWorkflowRunStepInput,
    ): Promise<{ step: WorkflowRunStep; claimed: boolean }> {
      if (!Number.isInteger(input.stepIndex) || input.stepIndex < 0) {
        throw new WorkflowDefinitionError("stepIndex must be a non-negative integer")
      }
      const inserted = await db
        .insert(workflowRunSteps)
        .values({
          workspaceId,
          runId: input.runId,
          stepIndex: input.stepIndex,
          actionType: input.actionType,
          status: "running",
        })
        .onConflictDoNothing({
          target: [workflowRunSteps.runId, workflowRunSteps.stepIndex],
        })
        .returning()
      const created = inserted[0]
      if (created) return { step: created, claimed: true }

      const existing = await db
        .select()
        .from(workflowRunSteps)
        .where(
          and(
            eq(workflowRunSteps.workspaceId, workspaceId),
            eq(workflowRunSteps.runId, input.runId),
            eq(workflowRunSteps.stepIndex, input.stepIndex),
          ),
        )
        .limit(1)
      const row = existing[0]
      if (!row) throw new WorkflowDefinitionError("workflow_run_steps: conflict without a row")
      return { step: row, claimed: false }
    },

    async completeRunStep(
      db: Database,
      workspaceId: string,
      id: string,
      patch: CompleteWorkflowRunStepInput,
    ): Promise<WorkflowRunStep | null> {
      if (patch.status !== undefined && !isWorkflowRunStepStatus(patch.status)) {
        throw new WorkflowDefinitionError(`unknown step status '${patch.status}'`)
      }
      const rows = await db
        .update(workflowRunSteps)
        .set({ ...patch, finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(workflowRunSteps.id, id), eq(workflowRunSteps.workspaceId, workspaceId)))
        .returning()
      return rows[0] ?? null
    },

    async listRunSteps(
      db: Database,
      workspaceId: string,
      runId: string,
    ): Promise<WorkflowRunStep[]> {
      return db
        .select()
        .from(workflowRunSteps)
        .where(
          and(eq(workflowRunSteps.workspaceId, workspaceId), eq(workflowRunSteps.runId, runId)),
        )
        .orderBy(asc(workflowRunSteps.stepIndex))
    },

    /* --------------------------- action sinks --------------------------- */

    /**
     * `update_field` on the triggering record. Object and field are
     * resolved through `WORKFLOW_TARGET_OBJECTS` before anything happens,
     * and the write itself goes through that module's own repository.
     */
    async updateTargetField(
      db: Database,
      workspaceId: string,
      target: { entityType: string; entityId: string },
      field: string,
      value: unknown,
      actorId?: string,
    ): Promise<{ recordId: string }> {
      const def = resolveWorkflowTargetField(target.entityType, field)
      const updated = await def.update(
        db,
        workspaceId,
        target.entityId,
        { [field]: value },
        actorId,
      )
      if (!updated) {
        throw new WorkflowDefinitionError(
          `${target.entityType} ${target.entityId} was not found or is deleted`,
        )
      }
      return { recordId: updated.id }
    },

    /**
     * `add_tag` on the triggering record. Tags are workspace-unique by
     * name (case-insensitively), so this finds or creates, then attaches
     * through the tags repository's own idempotent `attach`.
     */
    async attachTagByName(
      db: Database,
      workspaceId: string,
      target: { entityType: string; entityId: string },
      name: string,
      actorId?: string,
    ): Promise<{ tagId: string }> {
      const repo = createTagsRepository()
      const normalized = normalizeTagName(name)
      const found = await repo.list(db, {
        workspaceId,
        limit: 1,
        where: [ilike(tags.name, normalized)],
      })
      const existing = found.data[0] as { id: string } | undefined
      const tag = existing ?? (await repo.create(db, workspaceId, { name: normalized }, actorId))
      await repo.attach(db, workspaceId, tag.id, target.entityType, target.entityId, actorId)
      return { tagId: tag.id }
    },

    /**
     * `notify` — an in-app notification row on the shared `notifications`
     * table (spec 25 §13: in-app first). Delivery (websocket push, email)
     * stays a worker concern fed by this row, exactly as
     * `@yourcrm/notifications` documents.
     */
    async createNotification(
      db: Database,
      workspaceId: string,
      input: { userId: string; type: string; title: string; body?: string | null },
      actorId?: string,
    ): Promise<{ notificationId: string }> {
      const title = input.title.trim()
      if (title === "") throw new WorkflowDefinitionError("notification title must not be empty")
      const rows = await db
        .insert(notifications)
        .values({
          workspaceId,
          userId: input.userId,
          type: input.type,
          title: title.slice(0, 255),
          body: input.body ?? null,
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new WorkflowDefinitionError("notifications: insert returned no rows")
      return { notificationId: row.id }
    },
  }
}

export type AutomationRepository = ReturnType<typeof createAutomationRepository>
