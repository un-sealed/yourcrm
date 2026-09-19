import type { BadgeTone, FilterFieldDef, FilterTree } from "@yourcrm/ui"

/**
 * Client-side contracts for the automation module.
 *
 * The filter model is `@yourcrm/ui`'s `FilterTree` — the same tree the
 * server stores in `workflows.conditions` and evaluates at run time. The
 * builder round-trips without a translation layer, which is the whole
 * point of having exactly one filter model.
 */

export type WorkflowActionType = "create_task" | "update_field" | "add_tag" | "notify"

export type WorkflowAction =
  | {
      type: "create_task"
      title: string
      description?: string | null
      priority?: string | null
      dueInDays?: number | null
      assigneeId?: string | null
    }
  | { type: "update_field"; field: string; value: string | number | boolean | null }
  | { type: "add_tag"; tag: string }
  | { type: "notify"; userId?: string | null; title: string; body?: string | null }

/** A workflow as returned by `GET /api/v1/automation` (envelope `data`). */
export type Workflow = {
  id: string
  workspaceId: string
  name: string
  description: string | null
  triggerEvent: string
  triggerEntityType: string | null
  conditions: FilterTree | null
  actions: WorkflowAction[]
  status: string
  ownerId: string | null
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

export type WorkflowsListResponse = {
  data: Workflow[]
  pagination: { nextCursor: string | null; limit: number }
}

export type WorkflowRunStatus = "queued" | "running" | "succeeded" | "failed" | "skipped"

export type WorkflowRun = {
  id: string
  workflowId: string
  triggerEvent: string
  triggerEventId: string
  entityType: string | null
  entityId: string | null
  status: string
  depth: number
  actorId: string | null
  actorRole: string | null
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export type WorkflowRunStep = {
  id: string
  stepIndex: number
  actionType: string
  status: string
  result: unknown
  error: string | null
}

export type WorkflowRunDetail = WorkflowRun & { steps: WorkflowRunStep[] }

export type WorkflowRunsListResponse = {
  data: WorkflowRun[]
  pagination: { nextCursor: string | null; limit: number }
}

/** `GET /api/v1/automation/catalogue` — the server's own vocabulary. */
export type WorkflowCatalogue = {
  triggers: { event: string; label: string; domain: string }[]
  actions: { type: string; label: string }[]
  targets: { objectType: string; fields: string[] }[]
  maxActions: number
  maxCascadeDepth: number
}

export const ACTION_TYPE_OPTIONS: { value: WorkflowActionType; label: string }[] = [
  { value: "create_task", label: "Create a task" },
  { value: "update_field", label: "Update a field on the record" },
  { value: "add_tag", label: "Add a tag" },
  { value: "notify", label: "Send an in-app notification" },
]

export const RUN_STATUS_TONES: Record<string, BadgeTone> = {
  queued: "secondary",
  running: "info",
  succeeded: "success",
  failed: "destructive",
  skipped: "outline",
}

/** A blank action of the requested type, so the editor never posts junk. */
export function emptyWorkflowAction(type: WorkflowActionType): WorkflowAction {
  switch (type) {
    case "create_task":
      return { type: "create_task", title: "" }
    case "update_field":
      return { type: "update_field", field: "", value: "" }
    case "add_tag":
      return { type: "add_tag", tag: "" }
    case "notify":
      return { type: "notify", title: "" }
  }
}

/** Client-side mirror of the server's validation, for inline feedback. */
export function describeActionProblem(action: WorkflowAction): string | null {
  switch (action.type) {
    case "create_task":
      return action.title.trim() === "" ? "A task needs a title." : null
    case "update_field":
      return action.field.trim() === "" ? "Choose the field to update." : null
    case "add_tag":
      return action.tag.trim() === "" ? "Name the tag to add." : null
    case "notify":
      return action.title.trim() === "" ? "A notification needs a title." : null
  }
}

/** One-line human summary of an action, for list rows and run history. */
export function describeAction(action: WorkflowAction): string {
  switch (action.type) {
    case "create_task":
      return `Create task "${action.title}"`
    case "update_field":
      return `Set ${action.field} to ${String(action.value)}`
    case "add_tag":
      return `Add tag "${action.tag}"`
    case "notify":
      return `Notify ${action.userId ?? "the workflow owner"}: "${action.title}"`
  }
}

/** Human summary of a whole definition, e.g. on the list page. */
export function describeWorkflow(
  workflow: Pick<Workflow, "triggerEvent" | "actions">,
  catalogue?: WorkflowCatalogue,
): string {
  const trigger =
    catalogue?.triggers.find((t) => t.event === workflow.triggerEvent)?.label ??
    workflow.triggerEvent
  const actions = workflow.actions ?? []
  if (actions.length === 0) return `When ${trigger.toLowerCase()}`
  const first = describeAction(actions[0] as WorkflowAction)
  const rest = actions.length - 1
  return rest === 0
    ? `When ${trigger.toLowerCase()} → ${first}`
    : `When ${trigger.toLowerCase()} → ${first} +${rest} more`
}

/**
 * Fields a condition may test. The engine flattens the triggering event
 * into `field`, `before.field`, `after.field` and `event.*`, so the
 * builder offers the target object's own fields plus the event metadata.
 */
export function toConditionFields(
  catalogue: WorkflowCatalogue | null,
  objectType: string | null,
): FilterFieldDef[] {
  const target = catalogue?.targets.find((t) => t.objectType === objectType)
  const own = (target?.fields ?? []).map<FilterFieldDef>((name) => ({
    name,
    label: name,
    type: "text",
  }))
  return [
    ...own,
    ...(target?.fields ?? []).map<FilterFieldDef>((name) => ({
      name: `before.${name}`,
      label: `${name} (before)`,
      type: "text",
    })),
    { name: "event.entityType", label: "Record type", type: "text" },
    { name: "event.actorType", label: "Changed by", type: "text" },
  ]
}

/** Guess the object a trigger event is about, e.g. `deal.won` -> `deal`. */
export function objectTypeOfTrigger(triggerEvent: string): string | null {
  const domain = triggerEvent.split(".")[0]
  return domain === undefined || domain === "" ? null : domain
}

export function formatRunTimestamp(value: string | null): string {
  return value === null ? "—" : new Date(value).toLocaleString()
}
