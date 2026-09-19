import {
  and,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Database } from "../client"
import { activities } from "../schema/activities"
import { companies } from "../schema/companies"
import { deals } from "../schema/deals"
import { leads } from "../schema/leads"
import { people } from "../schema/people"
import {
  isReportAggregateFunction,
  isReportVisibility,
  REPORT_DEFAULT_ROW_LIMIT,
  REPORT_MAX_ROW_LIMIT,
  reports,
  type Report,
  type ReportAggregateFunction,
  type ReportAggregationConfig,
  type ReportColumnConfig,
  type ReportFilterNode,
  type ReportFilterTree,
  type ReportSortConfig,
  type ReportVisibility,
} from "../schema/reports"
import { tasks } from "../schema/tasks"
import { createBaseRepository, type BaseTable } from "./base-repository"

/**
 * Reports repository: saved report definitions plus the execution engine.
 *
 * SECURITY MODEL (read this before changing anything below)
 * ---------------------------------------------------------
 * 1. NO user-supplied string ever reaches SQL text. Object types, field
 *    names, aggregate functions, sort directions and column selections are
 *    looked up in `REPORT_OBJECTS` — an allowlist derived from the drizzle
 *    schema — and resolved to `PgColumn` objects or to constant `sql`
 *    fragments. An unknown key throws; it is never echoed into SQL.
 * 2. Every user-supplied *value* (filter operands, limits) is bound as a
 *    query parameter by drizzle, never concatenated.
 * 3. Result aliases are generated (`col_1`, `metric_1`, ...), so even the
 *    identifiers in the projection are ours, not the caller's.
 * 4. Every execution is scoped by `ReportRowScope`, which the domain
 *    service derives from the caller's permissions. The repository refuses
 *    to build a statement without one, so "workspace-scoped only" cannot
 *    happen by omission.
 *
 * Reading other modules' tables is deliberate and read-only: a report
 * engine is generic by definition. The registry below is the entire
 * surface — no other table can be reached from a report definition.
 */

/* ------------------------------ registry ------------------------------ */

/** Same vocabulary as `FilterFieldType` in `@yourcrm/ui`'s FilterBuilder. */
export type ReportFieldType = "text" | "number" | "date" | "boolean" | "select"

export type ReportFieldDef = {
  name: string
  label: string
  type: ReportFieldType
  column: PgColumn
  /** Fixed option list for `select` fields (drives the web filter builder). */
  options?: readonly string[]
}

export type ReportObjectDef = {
  objectType: string
  label: string
  table: BaseTable
  /** Allowlisted, reportable fields keyed by their public field name. */
  fields: Record<string, ReportFieldDef>
  /**
   * Columns that make a row "the caller's own". Used by the `own` row scope
   * so a lower-privileged actor only ever sees records they own or created.
   */
  actorColumns: PgColumn[]
}

function field(
  name: string,
  label: string,
  type: ReportFieldType,
  column: PgColumn,
  options?: readonly string[],
): ReportFieldDef {
  return options === undefined
    ? { name, label, type, column }
    : { name, label, type, column, options }
}

function fieldsOf(defs: ReportFieldDef[]): Record<string, ReportFieldDef> {
  const out: Record<string, ReportFieldDef> = {}
  for (const def of defs) out[def.name] = def
  return out
}

/**
 * Reportable objects. Adding an object here is the ONLY way to make it
 * reachable from a report definition; adding a field is the only way to
 * make it filterable, groupable, aggregatable or selectable.
 */
export const REPORT_OBJECTS: Record<string, ReportObjectDef> = {
  person: {
    objectType: "person",
    label: "People",
    table: people,
    actorColumns: [people.ownerId, people.createdBy],
    fields: fieldsOf([
      field("firstName", "First name", "text", people.firstName),
      field("lastName", "Last name", "text", people.lastName),
      field("title", "Job title", "text", people.title),
      field("status", "Status", "select", people.status, ["active", "archived"]),
      field("preferredChannel", "Preferred channel", "select", people.preferredChannel, [
        "email",
        "phone",
        "sms",
        "whatsapp",
      ]),
      field("companyId", "Company", "text", people.companyId),
      field("ownerId", "Owner", "text", people.ownerId),
      field("createdAt", "Created", "date", people.createdAt),
      field("updatedAt", "Updated", "date", people.updatedAt),
    ]),
  },
  company: {
    objectType: "company",
    label: "Companies",
    table: companies,
    actorColumns: [companies.ownerId, companies.createdBy],
    fields: fieldsOf([
      field("name", "Name", "text", companies.name),
      field("domain", "Domain", "text", companies.domain),
      field("industry", "Industry", "text", companies.industry),
      field("size", "Size", "text", companies.size),
      field("status", "Status", "select", companies.status, ["active", "archived"]),
      field("ownerId", "Owner", "text", companies.ownerId),
      field("createdAt", "Created", "date", companies.createdAt),
      field("updatedAt", "Updated", "date", companies.updatedAt),
    ]),
  },
  deal: {
    objectType: "deal",
    label: "Deals",
    table: deals,
    actorColumns: [deals.ownerId, deals.createdBy],
    fields: fieldsOf([
      field("name", "Name", "text", deals.name),
      field("amount", "Amount", "number", deals.amount),
      field("currency", "Currency", "text", deals.currency),
      field("stage", "Stage", "text", deals.stage),
      field("probability", "Probability", "number", deals.probability),
      field("expectedCloseDate", "Expected close", "date", deals.expectedCloseDate),
      field("companyId", "Company", "text", deals.companyId),
      field("personId", "Person", "text", deals.personId),
      field("ownerId", "Owner", "text", deals.ownerId),
      field("createdAt", "Created", "date", deals.createdAt),
      field("updatedAt", "Updated", "date", deals.updatedAt),
    ]),
  },
  lead: {
    objectType: "lead",
    label: "Leads",
    table: leads,
    actorColumns: [leads.ownerId, leads.createdBy],
    fields: fieldsOf([
      field("firstName", "First name", "text", leads.firstName),
      field("lastName", "Last name", "text", leads.lastName),
      field("email", "Email", "text", leads.email),
      field("companyName", "Company name", "text", leads.companyName),
      field("source", "Source", "text", leads.source),
      field("status", "Status", "text", leads.status),
      field("score", "Score", "number", leads.score),
      field("ownerId", "Owner", "text", leads.ownerId),
      field("createdAt", "Created", "date", leads.createdAt),
      field("updatedAt", "Updated", "date", leads.updatedAt),
    ]),
  },
  task: {
    objectType: "task",
    label: "Tasks",
    table: tasks,
    actorColumns: [tasks.ownerId, tasks.assigneeId, tasks.createdBy],
    fields: fieldsOf([
      field("title", "Title", "text", tasks.title),
      field("status", "Status", "text", tasks.status),
      field("priority", "Priority", "text", tasks.priority),
      field("dueDate", "Due date", "date", tasks.dueDate),
      field("completedAt", "Completed", "date", tasks.completedAt),
      field("assigneeId", "Assignee", "text", tasks.assigneeId),
      field("ownerId", "Owner", "text", tasks.ownerId),
      field("createdAt", "Created", "date", tasks.createdAt),
      field("updatedAt", "Updated", "date", tasks.updatedAt),
    ]),
  },
  activity: {
    objectType: "activity",
    label: "Activities",
    table: activities,
    actorColumns: [activities.ownerId, activities.createdBy],
    fields: fieldsOf([
      field("title", "Title", "text", activities.title),
      field("type", "Type", "text", activities.type),
      field("status", "Status", "text", activities.status),
      field("subjectType", "Related to", "text", activities.subjectType),
      field("dueAt", "Due", "date", activities.dueAt),
      field("completedAt", "Completed", "date", activities.completedAt),
      field("ownerId", "Owner", "text", activities.ownerId),
      field("createdAt", "Created", "date", activities.createdAt),
      field("updatedAt", "Updated", "date", activities.updatedAt),
    ]),
  },
}

export const REPORT_OBJECT_TYPES = Object.keys(REPORT_OBJECTS)

export class ReportDefinitionError extends Error {
  readonly code = "INVALID_REPORT"
  constructor(message: string) {
    super(message)
    this.name = "ReportDefinitionError"
  }
}

/** Allowlist gate for the object type. Unknown keys never reach SQL. */
export function resolveReportObject(objectType: unknown): ReportObjectDef {
  if (typeof objectType !== "string") {
    throw new ReportDefinitionError("reports: objectType must be a string")
  }
  const found = REPORT_OBJECTS[objectType]
  if (!found) {
    throw new ReportDefinitionError(
      `reports: unknown object type '${objectType}' (allowed: ${REPORT_OBJECT_TYPES.join(", ")})`,
    )
  }
  return found
}

/** Allowlist gate for a field name. Unknown names never reach SQL. */
export function resolveReportField(object: ReportObjectDef, name: unknown): ReportFieldDef {
  if (typeof name !== "string") {
    throw new ReportDefinitionError(`reports: field name must be a string on ${object.objectType}`)
  }
  const found = object.fields[name]
  if (!found) {
    throw new ReportDefinitionError(
      `reports: unknown field '${name}' on ${object.objectType} (allowed: ${Object.keys(object.fields).join(", ")})`,
    )
  }
  return found
}

/** Serialisable field catalogue for the web builder (no drizzle columns). */
export function describeReportObjects(): {
  objectType: string
  label: string
  fields: { name: string; label: string; type: ReportFieldType; options?: string[] }[]
}[] {
  return REPORT_OBJECT_TYPES.map((key) => {
    const object = REPORT_OBJECTS[key] as ReportObjectDef
    return {
      objectType: object.objectType,
      label: object.label,
      fields: Object.values(object.fields).map((f) =>
        f.options === undefined
          ? { name: f.name, label: f.label, type: f.type }
          : { name: f.name, label: f.label, type: f.type, options: [...f.options] },
      ),
    }
  })
}

/* --------------------------- filter compiler --------------------------- */

/** Operators of `@yourcrm/ui`'s FilterBuilder — the one filter model. */
export const REPORT_FILTER_OPERATORS = [
  "eq",
  "neq",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "isEmpty",
  "isNotEmpty",
  "between",
] as const

export type ReportFilterOperator = (typeof REPORT_FILTER_OPERATORS)[number]

/** Guard rails against pathological trees (spec 17: bounded server work). */
const MAX_FILTER_DEPTH = 5
const MAX_FILTER_NODES = 100

function isGroupNode(node: ReportFilterNode): node is Extract<ReportFilterNode, { type: "group" }> {
  return node.type === "group"
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function coerceScalar(def: ReportFieldDef, value: unknown, path: string): unknown {
  if (value === null || value === undefined) {
    throw new ReportDefinitionError(`${path}: operator needs a value`)
  }
  if (def.type === "number") {
    const parsed = typeof value === "number" ? value : Number(String(value).trim())
    if (!Number.isFinite(parsed)) {
      throw new ReportDefinitionError(`${path}: '${String(value)}' is not a number`)
    }
    return parsed
  }
  if (def.type === "boolean") {
    if (typeof value === "boolean") return value
    const text = String(value).trim().toLowerCase()
    if (text === "true") return true
    if (text === "false") return false
    throw new ReportDefinitionError(`${path}: '${String(value)}' is not a boolean`)
  }
  if (def.type === "date") {
    if (value instanceof Date) return value
    const text = String(value).trim()
    if (text === "") throw new ReportDefinitionError(`${path}: date value must not be empty`)
    if (Number.isNaN(new Date(text).getTime())) {
      throw new ReportDefinitionError(`${path}: '${text}' is not a date`)
    }
    return text
  }
  const text = typeof value === "string" ? value : String(value)
  if (text.length > 1024) throw new ReportDefinitionError(`${path}: value is too long`)
  return text
}

function coerceList(def: ReportFieldDef, value: unknown, path: string): unknown[] {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part !== "")
  if (raw.length === 0) throw new ReportDefinitionError(`${path}: list operator needs values`)
  if (raw.length > 100) throw new ReportDefinitionError(`${path}: at most 100 values`)
  return raw.map((entry) => coerceScalar(def, entry, path))
}

function likeCondition(def: ReportFieldDef, value: unknown, path: string, shape: string): SQL {
  const text = escapeLikePattern(String(coerceScalar(def, value, path)))
  // The pattern is built in JS and bound as a parameter — never inlined.
  return ilike(def.column, shape.replace("{}", text))
}

function compileCondition(
  object: ReportObjectDef,
  node: Extract<ReportFilterNode, { type: "condition" }>,
  path: string,
): SQL {
  const def = resolveReportField(object, node.field)
  const operator = node.operator
  if (!(REPORT_FILTER_OPERATORS as readonly string[]).includes(operator)) {
    throw new ReportDefinitionError(`${path}: unsupported operator '${String(operator)}'`)
  }
  const column = def.column
  switch (operator as ReportFilterOperator) {
    case "eq":
      return eq(column, coerceScalar(def, node.value, path))
    case "neq":
      // `<> value` skips NULL rows in SQL; "is not X" should include them.
      return sql`(${column} IS DISTINCT FROM ${coerceScalar(def, node.value, path)})`
    case "contains":
      return likeCondition(def, node.value, path, "%{}%")
    case "startsWith":
      return likeCondition(def, node.value, path, "{}%")
    case "endsWith":
      return likeCondition(def, node.value, path, "%{}")
    case "gt":
      return sql`(${column} > ${coerceScalar(def, node.value, path)})`
    case "gte":
      return sql`(${column} >= ${coerceScalar(def, node.value, path)})`
    case "lt":
      return sql`(${column} < ${coerceScalar(def, node.value, path)})`
    case "lte":
      return sql`(${column} <= ${coerceScalar(def, node.value, path)})`
    case "in":
      return inArray(column, coerceList(def, node.value, path))
    case "notIn":
      return notInArray(column, coerceList(def, node.value, path))
    case "isEmpty":
      return def.type === "text" || def.type === "select"
        ? (or(isNull(column), eq(column, "")) as SQL)
        : isNull(column)
    case "isNotEmpty":
      return def.type === "text" || def.type === "select"
        ? (and(isNotNull(column), sql`(${column} <> '')`) as SQL)
        : isNotNull(column)
    case "between": {
      const pair = Array.isArray(node.value) ? node.value : []
      if (pair.length !== 2) {
        throw new ReportDefinitionError(`${path}: between needs exactly two values`)
      }
      const low = coerceScalar(def, pair[0], `${path}.from`)
      const high = coerceScalar(def, pair[1], `${path}.to`)
      return sql`(${column} BETWEEN ${low} AND ${high})`
    }
  }
}

type FilterBudget = { nodes: number }

function compileNode(
  object: ReportObjectDef,
  node: unknown,
  path: string,
  depth: number,
  budget: FilterBudget,
): SQL | undefined {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new ReportDefinitionError(`${path}: filter node must be an object`)
  }
  budget.nodes += 1
  if (budget.nodes > MAX_FILTER_NODES) {
    throw new ReportDefinitionError(`filter: at most ${MAX_FILTER_NODES} nodes`)
  }
  if (depth > MAX_FILTER_DEPTH) {
    throw new ReportDefinitionError(`filter: nested more than ${MAX_FILTER_DEPTH} levels`)
  }
  const typed = node as ReportFilterNode
  if (isGroupNode(typed)) {
    if (typed.combinator !== "and" && typed.combinator !== "or") {
      throw new ReportDefinitionError(`${path}: combinator must be 'and' or 'or'`)
    }
    if (!Array.isArray(typed.children)) {
      throw new ReportDefinitionError(`${path}: group needs a children array`)
    }
    const parts: SQL[] = []
    for (let i = 0; i < typed.children.length; i++) {
      const compiled = compileNode(
        object,
        typed.children[i],
        `${path}.children[${String(i)}]`,
        depth + 1,
        budget,
      )
      if (compiled) parts.push(compiled)
    }
    if (parts.length === 0) return undefined
    const combined = typed.combinator === "and" ? and(...parts) : or(...parts)
    return combined
  }
  if (typed.type !== "condition") {
    throw new ReportDefinitionError(`${path}: node type must be 'group' or 'condition'`)
  }
  return compileCondition(object, typed, path)
}

/**
 * Compile a stored filter tree into a parameterised drizzle predicate.
 * Returns `undefined` for "no filter" (empty group = match everything).
 */
export function compileReportFilter(
  object: ReportObjectDef,
  filter: ReportFilterTree | null | undefined,
): SQL | undefined {
  if (filter === null || filter === undefined) return undefined
  if (filter.type !== "group") {
    throw new ReportDefinitionError("filter: root node must be a group")
  }
  return compileNode(object, filter, "filter", 0, { nodes: 0 })
}

/* ---------------------------- execution plan ---------------------------- */

/**
 * Row visibility for one execution. The domain service derives this from
 * the caller's permissions; the repository never guesses it.
 *
 * - `workspace`: every live row in the workspace (workspace admins/owners).
 * - `own`: only rows the actor owns, is assigned or created.
 */
export type ReportRowScope = { kind: "workspace" } | { kind: "own"; actorId: string }

export type ReportExecutionRequest = {
  objectType: string
  filter?: ReportFilterTree | null
  groupBy?: string | null
  aggregations?: ReportAggregationConfig[] | null
  columns?: ReportColumnConfig | null
  sort?: ReportSortConfig | null
  limit?: number | null
}

export type ReportResultColumn = {
  /** Stable key in every result row. */
  key: string
  /** Registry field name, or null for `count(*)`. */
  field: string | null
  label: string
  type: ReportFieldType
  role: "dimension" | "metric"
}

export type ReportExecutionPlan = {
  statement: SQL
  columns: ReportResultColumn[]
  /** Generated SQL alias per column, positionally aligned with `columns`. */
  aliases: string[]
  mode: "table" | "grouped"
  limit: number
  scope: ReportRowScope["kind"]
}

export type ReportExecutionResult = {
  objectType: string
  mode: "table" | "grouped"
  scope: ReportRowScope["kind"]
  columns: ReportResultColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  limit: number
  /** True when more rows matched than the row limit allowed. */
  truncated: boolean
}

/**
 * Aggregate builders. The SQL text of each fragment is a compile-time
 * constant; only the column reference varies, and that comes from the
 * registry. There is no code path that turns a caller's string into a
 * function name.
 */
const AGGREGATE_BUILDERS: Record<ReportAggregateFunction, (column: PgColumn) => SQL> = {
  count: (column) => sql`count(${column})`,
  sum: (column) => sql`sum(${column})`,
  avg: (column) => sql`avg(${column})`,
  min: (column) => sql`min(${column})`,
  max: (column) => sql`max(${column})`,
}

const COUNT_ROWS = sql`count(*)`

const SORT_DIRECTIONS = { asc: sql`ASC`, desc: sql`DESC` } as const

const NUMERIC_AGGREGATES: readonly ReportAggregateFunction[] = ["sum", "avg"]

function aggregateLabel(config: ReportAggregationConfig, def: ReportFieldDef | null): string {
  if (config.label !== null && config.label !== undefined && config.label.trim() !== "") {
    return config.label.trim()
  }
  const fn = config.fn.toUpperCase()
  return def === null ? "Count" : `${fn} of ${def.label}`
}

function uniqueKey(taken: Set<string>, candidate: string): string {
  let key = candidate
  let suffix = 2
  while (taken.has(key)) {
    key = `${candidate}_${String(suffix)}`
    suffix += 1
  }
  taken.add(key)
  return key
}

function clampLimit(limit: number | null | undefined): number {
  const raw = typeof limit === "number" && Number.isFinite(limit) ? Math.trunc(limit) : NaN
  if (Number.isNaN(raw)) return REPORT_DEFAULT_ROW_LIMIT
  return Math.min(Math.max(raw, 1), REPORT_MAX_ROW_LIMIT)
}

/** Predicate restricting rows to the caller's own records. */
function scopePredicate(object: ReportObjectDef, scope: ReportRowScope): SQL | undefined {
  if (scope.kind === "workspace") return undefined
  if (!scope.actorId) {
    throw new ReportDefinitionError("reports: own-scope execution needs an actor id")
  }
  const parts = object.actorColumns.map((column) => eq(column, scope.actorId))
  const combined = parts.length === 1 ? parts[0] : or(...parts)
  if (!combined) throw new ReportDefinitionError("reports: object has no ownership columns")
  return combined
}

/**
 * Build the SELECT for one execution. Pure — no database access — so tests
 * can serialise it with `PgDialect` and assert that user input only ever
 * appears in the bound parameters.
 */
export function planReportExecution(
  workspaceId: string,
  request: ReportExecutionRequest,
  scope: ReportRowScope,
): ReportExecutionPlan {
  const object = resolveReportObject(request.objectType)
  const table = object.table
  const limit = clampLimit(request.limit)

  const aggregations = request.aggregations ?? []
  if (aggregations.length > 10) {
    throw new ReportDefinitionError("reports: at most 10 aggregations")
  }
  const grouped = aggregations.length > 0 || (request.groupBy ?? null) !== null
  const groupDef =
    request.groupBy === null || request.groupBy === undefined
      ? null
      : resolveReportField(object, request.groupBy)

  const projection: SQL[] = []
  const columns: ReportResultColumn[] = []
  const aliases: string[] = []
  const keys = new Set<string>()
  const sortable = new Map<string, SQL>()

  if (grouped) {
    if (groupDef) {
      const alias = `col_${String(projection.length + 1)}`
      const key = uniqueKey(keys, groupDef.name)
      projection.push(sql`${groupDef.column} AS ${sql.identifier(alias)}`)
      aliases.push(alias)
      columns.push({
        key,
        field: groupDef.name,
        label: groupDef.label,
        type: groupDef.type,
        role: "dimension",
      })
      sortable.set(key, sql`${groupDef.column}`)
      sortable.set(groupDef.name, sql`${groupDef.column}`)
    }
    const metrics = aggregations.length > 0 ? aggregations : [{ fn: "count" as const }]
    metrics.forEach((config, index) => {
      if (!isReportAggregateFunction(config.fn)) {
        throw new ReportDefinitionError(
          `aggregations[${String(index)}]: unknown function '${String(config.fn)}'`,
        )
      }
      const hasField = config.field !== null && config.field !== undefined && config.field !== ""
      if (!hasField && config.fn !== "count") {
        throw new ReportDefinitionError(
          `aggregations[${String(index)}]: ${config.fn} needs a field`,
        )
      }
      const def = hasField ? resolveReportField(object, config.field) : null
      if (def && NUMERIC_AGGREGATES.includes(config.fn) && def.type !== "number") {
        throw new ReportDefinitionError(
          `aggregations[${String(index)}]: ${config.fn} needs a numeric field, '${def.name}' is ${def.type}`,
        )
      }
      const expression =
        def === null
          ? COUNT_ROWS
          : (AGGREGATE_BUILDERS[config.fn] as (c: PgColumn) => SQL)(def.column)
      const alias = `metric_${String(index + 1)}`
      const key = uniqueKey(keys, def === null ? "count" : `${config.fn}_${def.name}`)
      projection.push(sql`${expression} AS ${sql.identifier(alias)}`)
      aliases.push(alias)
      columns.push({
        key,
        field: def?.name ?? null,
        label: aggregateLabel(config, def),
        type: config.fn === "count" ? "number" : (def?.type ?? "number"),
        role: "metric",
      })
      sortable.set(key, expression)
    })
  } else {
    const fallback: ReportColumnConfig = Object.values(object.fields)
      .slice(0, 6)
      .map((def) => ({ field: def.name, label: def.label }))
    const selected: ReportColumnConfig =
      request.columns && request.columns.length > 0 ? request.columns : fallback
    if (selected.length > 25) throw new ReportDefinitionError("reports: at most 25 columns")
    selected.forEach((entry, index) => {
      const def = resolveReportField(object, entry.field)
      const alias = `col_${String(index + 1)}`
      const key = uniqueKey(keys, def.name)
      projection.push(sql`${def.column} AS ${sql.identifier(alias)}`)
      aliases.push(alias)
      columns.push({
        key,
        field: def.name,
        label:
          entry.label !== null && entry.label !== undefined && entry.label.trim() !== ""
            ? entry.label.trim()
            : def.label,
        type: def.type,
        role: "dimension",
      })
      sortable.set(key, sql`${def.column}`)
      sortable.set(def.name, sql`${def.column}`)
    })
  }

  if (projection.length === 0) {
    throw new ReportDefinitionError("reports: a report must select at least one column")
  }

  const predicates: SQL[] = [eq(table.workspaceId, workspaceId), isNull(table.deletedAt)]
  const scoped = scopePredicate(object, scope)
  if (scoped) predicates.push(scoped)
  const filtered = compileReportFilter(object, request.filter)
  if (filtered) predicates.push(filtered)
  const where = and(...predicates) as SQL

  const orderParts: SQL[] = []
  for (const [index, entry] of (request.sort ?? []).entries()) {
    if (entry.direction !== "asc" && entry.direction !== "desc") {
      throw new ReportDefinitionError(`sort[${String(index)}]: direction must be asc or desc`)
    }
    const expression = sortable.get(entry.field)
    if (!expression) {
      throw new ReportDefinitionError(
        `sort[${String(index)}]: '${String(entry.field)}' is not a selected column`,
      )
    }
    orderParts.push(sql`${expression} ${SORT_DIRECTIONS[entry.direction]}`)
  }

  // Fetch one extra row so callers can report truncation honestly.
  const fetchLimit = limit + 1
  let statement = sql`SELECT ${sql.join(projection, sql`, `)} FROM ${table} WHERE ${where}`
  if (grouped && groupDef) {
    statement = sql`${statement} GROUP BY ${groupDef.column}`
  }
  if (orderParts.length > 0) {
    statement = sql`${statement} ORDER BY ${sql.join(orderParts, sql`, `)}`
  }
  statement = sql`${statement} LIMIT ${fetchLimit}`

  return {
    statement,
    columns,
    aliases,
    mode: grouped ? "grouped" : "table",
    limit,
    scope: scope.kind,
  }
}

/* ------------------------------ validation ------------------------------ */

export type CreateReportInput = {
  name: string
  description?: string | null
  objectType: string
  visibility?: ReportVisibility | null
  ownerId?: string | null
  filter?: ReportFilterTree | null
  groupBy?: string | null
  aggregations?: ReportAggregationConfig[] | null
  columns?: ReportColumnConfig | null
  sort?: ReportSortConfig | null
  rowLimit?: number | null
}

export type UpdateReportInput = Partial<Omit<CreateReportInput, "objectType">> & {
  objectType?: string | undefined
}

/**
 * Structural + allowlist validation of a stored definition. Runs the real
 * planner, so a definition can never be saved unless it compiles to safe
 * SQL. Returns an error message, or null when the definition is valid.
 */
export function validateReportDefinition(input: {
  objectType: string
  filter?: ReportFilterTree | null
  groupBy?: string | null
  aggregations?: ReportAggregationConfig[] | null
  columns?: ReportColumnConfig | null
  sort?: ReportSortConfig | null
  rowLimit?: number | null
}): string | null {
  try {
    planReportExecution(
      "00000000-0000-4000-8000-000000000000",
      {
        objectType: input.objectType,
        filter: input.filter ?? null,
        groupBy: input.groupBy ?? null,
        aggregations: input.aggregations ?? null,
        columns: input.columns ?? null,
        sort: input.sort ?? null,
        limit: input.rowLimit ?? null,
      },
      { kind: "workspace" },
    )
    return null
  } catch (err) {
    return err instanceof Error ? err.message : "invalid report definition"
  }
}

function assertDefinition(current: Report | null, patch: UpdateReportInput): void {
  const objectType = patch.objectType ?? current?.objectType
  if (objectType === undefined) throw new ReportDefinitionError("reports: objectType is required")
  const error = validateReportDefinition({
    objectType,
    filter: patch.filter === undefined ? (current?.filter ?? null) : patch.filter,
    groupBy: patch.groupBy === undefined ? (current?.groupBy ?? null) : patch.groupBy,
    aggregations:
      patch.aggregations === undefined ? (current?.aggregations ?? null) : patch.aggregations,
    columns: patch.columns === undefined ? (current?.columns ?? null) : patch.columns,
    sort: patch.sort === undefined ? (current?.sort ?? null) : patch.sort,
    rowLimit: patch.rowLimit === undefined ? (current?.rowLimit ?? null) : patch.rowLimit,
  })
  if (error) throw new ReportDefinitionError(`reports: invalid definition: ${error}`)
  if (patch.visibility !== undefined && patch.visibility !== null) {
    if (!isReportVisibility(patch.visibility)) {
      throw new ReportDefinitionError("reports: visibility must be private or shared")
    }
  }
}

function normalizeName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ")
  if (trimmed.length === 0) throw new ReportDefinitionError("reports: name must not be empty")
  if (trimmed.length > 255) throw new ReportDefinitionError("reports: name is too long")
  return trimmed
}

/* ------------------------------ repository ------------------------------ */

/**
 * Who may see which saved definitions in a list.
 * - `all`: workspace admins/owners see every definition.
 * - `visible`: everyone else sees shared reports plus their own private ones.
 */
export type ReportListScope = { kind: "all" } | { kind: "visible"; actorId: string }

export type ReportSearchOptions = {
  workspaceId: string
  limit?: number | undefined
  cursor?: string | undefined
  order?: "asc" | "desc" | undefined
  query?: string | undefined
  objectType?: string | undefined
  visibility?: string | undefined
  scope: ReportListScope
}

export function createReportsRepository() {
  const base = createBaseRepository(reports)

  return {
    ...base,

    async create(
      db: Database,
      workspaceId: string,
      input: CreateReportInput,
      actorId?: string,
    ): Promise<Report> {
      assertDefinition(null, input)
      const rows = await db
        .insert(reports)
        .values({
          workspaceId,
          name: normalizeName(input.name),
          description: input.description?.trim() ?? null,
          objectType: input.objectType,
          visibility: input.visibility ?? "shared",
          ownerId: input.ownerId ?? actorId ?? null,
          filter: input.filter ?? null,
          groupBy: input.groupBy ?? null,
          aggregations: input.aggregations ?? null,
          columns: input.columns ?? null,
          sort: input.sort ?? null,
          rowLimit: clampLimit(input.rowLimit),
          ...(actorId === undefined ? {} : { createdBy: actorId, updatedBy: actorId }),
        })
        .returning()
      const row = rows[0]
      if (!row) throw new Error("reports.create: insert returned no rows")
      return row
    },

    /** Cursor-paginated list, filtered by what the caller may see. */
    async search(db: Database, opts: ReportSearchOptions) {
      const conditions: SQL[] = []
      if (opts.query) {
        const pattern = `%${escapeLikePattern(opts.query.trim())}%`
        const match = or(ilike(reports.name, pattern), ilike(reports.description, pattern))
        if (match) conditions.push(match)
      }
      if (opts.objectType) {
        // Allowlist gate: an unknown object type is rejected, not queried.
        conditions.push(eq(reports.objectType, resolveReportObject(opts.objectType).objectType))
      }
      if (opts.visibility) {
        if (!isReportVisibility(opts.visibility)) {
          throw new ReportDefinitionError("reports: unknown visibility filter")
        }
        conditions.push(eq(reports.visibility, opts.visibility))
      }
      if (opts.scope.kind === "visible") {
        const actorId = opts.scope.actorId
        const visible = or(
          eq(reports.visibility, "shared"),
          eq(reports.ownerId, actorId),
          eq(reports.createdBy, actorId),
        )
        if (visible) conditions.push(visible)
      }
      const result = await base.list(db, {
        workspaceId: opts.workspaceId,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.cursor === undefined ? {} : { cursor: opts.cursor }),
        ...(opts.order === undefined ? {} : { order: opts.order }),
        where: conditions,
      })
      return { data: result.data as Report[], pagination: result.pagination }
    },

    async findById(db: Database, workspaceId: string, id: string): Promise<Report | null> {
      const row = await base.findById(db, workspaceId, id)
      return (row as Report | null) ?? null
    },

    async update(
      db: Database,
      workspaceId: string,
      id: string,
      patch: UpdateReportInput,
      actorId?: string,
    ): Promise<Report | null> {
      const current = await this.findById(db, workspaceId, id)
      if (!current) return null
      assertDefinition(current, patch)
      const rows = await db
        .update(reports)
        .set({
          ...(patch.name === undefined ? {} : { name: normalizeName(patch.name) }),
          ...(patch.description === undefined
            ? {}
            : { description: patch.description?.trim() ?? null }),
          ...(patch.objectType === undefined ? {} : { objectType: patch.objectType }),
          ...(patch.visibility === undefined || patch.visibility === null
            ? {}
            : { visibility: patch.visibility }),
          ...(patch.ownerId === undefined ? {} : { ownerId: patch.ownerId }),
          ...(patch.filter === undefined ? {} : { filter: patch.filter }),
          ...(patch.groupBy === undefined ? {} : { groupBy: patch.groupBy }),
          ...(patch.aggregations === undefined ? {} : { aggregations: patch.aggregations }),
          ...(patch.columns === undefined ? {} : { columns: patch.columns }),
          ...(patch.sort === undefined ? {} : { sort: patch.sort }),
          ...(patch.rowLimit === undefined || patch.rowLimit === null
            ? {}
            : { rowLimit: clampLimit(patch.rowLimit) }),
          updatedAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(eq(reports.id, id), eq(reports.workspaceId, workspaceId), isNull(reports.deletedAt)),
        )
        .returning()
      return rows[0] ?? null
    },

    /**
     * Run a report definition. `scope` decides which rows the caller may
     * see and is always supplied by the domain service.
     */
    async execute(
      db: Database,
      workspaceId: string,
      request: ReportExecutionRequest,
      scope: ReportRowScope,
    ): Promise<ReportExecutionResult> {
      const plan = planReportExecution(workspaceId, request, scope)
      const raw = (await db.execute(plan.statement)) as unknown as Record<string, unknown>[]
      const fetched = Array.isArray(raw) ? raw : []
      const truncated = fetched.length > plan.limit
      const kept = truncated ? fetched.slice(0, plan.limit) : fetched
      const rows = kept.map((row) => {
        const mapped: Record<string, unknown> = {}
        plan.columns.forEach((column, index) => {
          const alias = plan.aliases[index]
          mapped[column.key] = alias === undefined ? null : (row[alias] ?? null)
        })
        return mapped
      })
      return {
        objectType: request.objectType,
        mode: plan.mode,
        scope: plan.scope,
        columns: plan.columns,
        rows,
        rowCount: rows.length,
        limit: plan.limit,
        truncated,
      }
    },

    /** Stamp `last_run_at` after a successful execution (telemetry only). */
    async markRun(db: Database, workspaceId: string, id: string, actorId?: string): Promise<void> {
      await db
        .update(reports)
        .set({
          lastRunAt: new Date(),
          ...(actorId === undefined ? {} : { updatedBy: actorId }),
        })
        .where(
          and(eq(reports.id, id), eq(reports.workspaceId, workspaceId), isNull(reports.deletedAt)),
        )
    },
  }
}

export type ReportsRepository = ReturnType<typeof createReportsRepository>
