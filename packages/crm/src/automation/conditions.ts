import type { WorkflowFilterNode, WorkflowFilterTree, WorkflowTriggerEnvelope } from "./types"

/**
 * Condition evaluation for workflow automation.
 *
 * Conditions are a `FilterTree` — the same model the FilterBuilder
 * produces and reports execute — but evaluated IN MEMORY against the
 * triggering event instead of compiled to SQL. Same encoding, same
 * operators, different back end; there is still exactly one filter model.
 *
 * Evaluation is a pure function of (tree, event): no I/O, no clock, no
 * permissions. That keeps the interesting part of the engine trivially
 * testable and keeps permission decisions where they belong — in
 * `service.ts`, immediately before each action.
 */

/**
 * Flatten an event envelope into the record conditions are written
 * against. Precedence is deliberate: the `after` state wins, because a
 * user writing "status is won" means the new value. The `before.` and
 * `event.` prefixes stay available for change detection, e.g.
 * `before.stage`.
 */
export function toWorkflowConditionRecord(event: WorkflowTriggerEnvelope): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  const before = asRecord(event.before)
  const after = asRecord(event.after)
  for (const [key, value] of Object.entries(before)) record[`before.${key}`] = value
  for (const [key, value] of Object.entries(after)) record[`after.${key}`] = value
  for (const [key, value] of Object.entries(before)) record[key] = value
  for (const [key, value] of Object.entries(after)) record[key] = value
  record["event.name"] = event.event
  record["event.entityType"] = event.entityType ?? null
  record["event.entityId"] = event.entityId ?? null
  record["event.actorId"] = event.actorId ?? null
  record["event.actorType"] = event.actorType ?? "user"
  return record
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  return false
}

function toComparable(value: unknown): number | string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return value
  if (typeof value === "boolean") return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") {
    const asNumber = Number(value)
    if (value.trim() !== "" && Number.isFinite(asNumber)) return asNumber
    const asDate = Date.parse(value)
    if (!Number.isNaN(asDate)) return asDate
    return value.toLowerCase()
  }
  return null
}

function compare(left: unknown, right: unknown): number | null {
  const a = toComparable(left)
  const b = toComparable(right)
  if (a === null || b === null) return null
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1
  const as = String(a)
  const bs = String(b)
  return as === bs ? 0 : as < bs ? -1 : 1
}

function looseEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || left === undefined || right === null || right === undefined) return false
  if (typeof left === "boolean" || typeof right === "boolean") {
    return String(left) === String(right)
  }
  return String(left).toLowerCase() === String(right).toLowerCase()
}

function asText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).toLowerCase()
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === "string") return value.split(",").map((part) => part.trim())
  return value === null || value === undefined ? [] : [value]
}

/**
 * Evaluate one condition. An unknown operator is FALSE, never true: a
 * definition the engine does not understand must not fire actions.
 */
function evaluateCondition(
  field: string,
  operator: string,
  operand: unknown,
  record: Record<string, unknown>,
): boolean {
  const actual = record[field]
  switch (operator) {
    case "eq":
      return looseEquals(actual, operand)
    case "neq":
      return !looseEquals(actual, operand)
    case "contains":
      return asText(actual).includes(asText(operand))
    case "startsWith":
      return asText(actual).startsWith(asText(operand))
    case "endsWith":
      return asText(actual).endsWith(asText(operand))
    case "gt":
      return (compare(actual, operand) ?? 0) > 0
    case "gte":
      return (compare(actual, operand) ?? -1) >= 0
    case "lt":
      return (compare(actual, operand) ?? 0) < 0
    case "lte":
      return (compare(actual, operand) ?? 1) <= 0
    case "in":
      return asList(operand).some((candidate) => looseEquals(actual, candidate))
    case "notIn":
      return !asList(operand).some((candidate) => looseEquals(actual, candidate))
    case "isEmpty":
      return isEmptyValue(actual)
    case "isNotEmpty":
      return !isEmptyValue(actual)
    case "between": {
      const [low, high] = asList(operand)
      const lowCmp = compare(actual, low)
      const highCmp = compare(actual, high)
      return lowCmp !== null && highCmp !== null && lowCmp >= 0 && highCmp <= 0
    }
    default:
      return false
  }
}

function evaluateNode(node: WorkflowFilterNode, record: Record<string, unknown>): boolean {
  if (node.type === "condition") {
    return evaluateCondition(node.field, node.operator, node.value, record)
  }
  // An empty group matches everything — "no conditions" must not mean
  // "never runs", which is how a disabled-by-accident workflow happens.
  if (node.children.length === 0) return true
  return node.combinator === "or"
    ? node.children.some((child) => evaluateNode(child, record))
    : node.children.every((child) => evaluateNode(child, record))
}

function isFilterNode(value: unknown): value is WorkflowFilterNode {
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  if (node.type === "condition") {
    return typeof node.field === "string" && typeof node.operator === "string"
  }
  return node.type === "group" && Array.isArray(node.children) && node.children.every(isFilterNode)
}

/**
 * Does this event satisfy the workflow's conditions? `null`/absent
 * conditions and an empty root group both mean "always".
 *
 * A malformed tree (one that is not the FilterBuilder encoding) returns
 * FALSE: the engine refuses to act on a definition it cannot read.
 */
export function matchesWorkflowConditions(
  conditions: unknown,
  event: WorkflowTriggerEnvelope,
): boolean {
  if (conditions === null || conditions === undefined) return true
  if (!isFilterNode(conditions) || conditions.type !== "group") return false
  return evaluateNode(conditions as WorkflowFilterTree, toWorkflowConditionRecord(event))
}

/**
 * Does this workflow's trigger match the event at all? Event name plus the
 * optional entity-type narrowing. The store already filters by event name
 * and enabled status; this re-checks in memory so a manual/test run and a
 * dispatched run take exactly the same path.
 */
export function matchesWorkflowTrigger(
  workflow: Record<string, unknown>,
  event: WorkflowTriggerEnvelope,
): boolean {
  if (workflow.triggerEvent !== event.event) return false
  const entityType = workflow.triggerEntityType
  if (typeof entityType !== "string" || entityType.trim() === "") return true
  return entityType === event.entityType
}

const TEMPLATE_PATTERN = /\{\{\s*([\w.]{1,64})\s*\}\}/g

/**
 * Substitute `{{field}}` placeholders from the triggering record, e.g.
 * "Follow up with {{firstName}}". Unknown fields render as an empty
 * string rather than leaking the placeholder into user-visible text.
 *
 * Only `[\w.]` is accepted inside the braces, and the result is plain
 * text that goes into a bound query parameter — there is no expression
 * language here and no evaluation of user input.
 */
export function renderWorkflowTemplate(template: string, record: Record<string, unknown>): string {
  return template.replace(TEMPLATE_PATTERN, (_match, field: string) => {
    const value = record[field]
    if (value === null || value === undefined) return ""
    if (typeof value === "object") return ""
    return String(value)
  })
}
