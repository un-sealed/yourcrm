import type { AiReportQueryPort } from "@yourcrm/crm/src/ai-assistant"
import type {
  ReportExecutionRequest,
  ReportExecutionResult,
  ReportFilterNode,
  ReportObjectCatalogEntry,
  ReportResultColumn,
  ReportRowScope,
} from "@yourcrm/crm/src/reports"
import {
  createAiGovernanceService,
  type AiActionApprovalRecord,
  type AiActionRequestRecord,
  type AiGovernanceStore,
} from "@yourcrm/crm/src/ai-governance"
import {
  createSearchService,
  type SearchDocumentRecord,
  type SearchHitListResult,
  type SearchStore,
  type SearchStoreQuery,
} from "@yourcrm/crm/src/search"
import type { McpAuditInput, McpRuntime } from "./runtime"

/**
 * A fixture CRM behind the real domain services (dev + tests only).
 *
 * ## Why this exists
 *
 * The production ports need the database package, which `apps/mcp` must
 * not depend on (see `runtime.ts` for the blocker). Without *some* runtime the
 * stdio server could never be driven by a real MCP client, and the
 * permission properties could never be tested end to end. So this file
 * provides the STORES — the layer below the services — in memory, and
 * wires the REAL services on top:
 *
 *  - the assistant's own tools run against {@link createDevReportsEngine},
 *    which applies the same `ReportRowScope` contract the SQL engine does;
 *  - `createSearchService` — the real service, over an in-memory index;
 *  - `createAiGovernanceService` — the real service, over an in-memory
 *    queue, with an applier that THROWS. Nothing in this process can apply
 *    an approved action, so "an MCP write mutates nothing" is a property
 *    of the wiring and not of the test's restraint.
 *
 * Fixtures are owned by different users on purpose: `user_member` owns
 * some records and `user_viewer` owns one, so row scoping is visible.
 */

/* ------------------------------- fixtures -------------------------------- */

export const DEV_WORKSPACE_ID = "ws_dev"

/** Fixture actors and the role the dev runtime resolves for each. */
export const DEV_ROLES: Record<string, string> = {
  user_dev: "owner",
  user_admin: "admin",
  user_member: "member",
  user_viewer: "viewer",
}

type DevRow = Record<string, unknown> & { id: string; ownerId: string }

function rows(entries: DevRow[]): DevRow[] {
  return entries
}

/** The fixture CRM. Small, but owned by several people. */
export function createDevDataset(): Record<string, DevRow[]> {
  return {
    person: rows([
      {
        id: "per_1",
        firstName: "Ada",
        lastName: "Lovelace",
        title: "CTO",
        status: "active",
        companyId: "com_1",
        ownerId: "user_member",
      },
      {
        id: "per_2",
        firstName: "Grace",
        lastName: "Hopper",
        title: "Admiral",
        status: "active",
        companyId: "com_2",
        ownerId: "user_dev",
      },
      {
        id: "per_3",
        firstName: "Alan",
        lastName: "Turing",
        title: "Head of Research",
        status: "archived",
        companyId: "com_1",
        ownerId: "user_viewer",
      },
    ]),
    company: rows([
      {
        id: "com_1",
        name: "Analytical Engines Ltd",
        domain: "analytical.example",
        industry: "Hardware",
        status: "active",
        ownerId: "user_member",
      },
      {
        id: "com_2",
        name: "Harbour Systems",
        domain: "harbour.example",
        industry: "Software",
        status: "active",
        ownerId: "user_dev",
      },
    ]),
    deal: rows([
      {
        id: "deal_1",
        name: "Analytical Engines — platform",
        amount: 48000,
        currency: "EUR",
        stage: "proposal",
        probability: 60,
        companyId: "com_1",
        personId: "per_1",
        ownerId: "user_member",
      },
      {
        id: "deal_2",
        name: "Harbour Systems — renewal",
        amount: 12500,
        currency: "EUR",
        stage: "negotiation",
        probability: 80,
        companyId: "com_2",
        personId: "per_2",
        ownerId: "user_dev",
      },
      {
        id: "deal_3",
        name: "Turing Institute — pilot",
        amount: 6000,
        currency: "EUR",
        stage: "qualification",
        probability: 30,
        companyId: "com_1",
        personId: "per_3",
        ownerId: "user_viewer",
      },
    ]),
    task: rows([
      {
        id: "task_1",
        title: "Send the revised proposal",
        status: "open",
        priority: "high",
        dueDate: "2026-10-01",
        assigneeId: "user_member",
        ownerId: "user_member",
      },
      {
        id: "task_2",
        title: "Schedule the renewal call",
        status: "open",
        priority: "medium",
        dueDate: "2026-09-25",
        assigneeId: "user_dev",
        ownerId: "user_dev",
      },
    ]),
    activity: rows([
      {
        id: "act_1",
        title: "Discovery call with Ada",
        type: "call",
        status: "completed",
        subjectType: "deal",
        ownerId: "user_member",
      },
      {
        id: "act_2",
        title: "Renewal email sent",
        type: "email",
        status: "completed",
        subjectType: "deal",
        ownerId: "user_dev",
      },
    ]),
  }
}

const DEV_CATALOG: ReportObjectCatalogEntry[] = [
  {
    objectType: "person",
    label: "People",
    fields: [
      { name: "firstName", label: "First name", type: "text" },
      { name: "lastName", label: "Last name", type: "text" },
      { name: "title", label: "Job title", type: "text" },
      { name: "status", label: "Status", type: "select", options: ["active", "archived"] },
      { name: "companyId", label: "Company", type: "text" },
      { name: "ownerId", label: "Owner", type: "text" },
    ],
  },
  {
    objectType: "company",
    label: "Companies",
    fields: [
      { name: "name", label: "Name", type: "text" },
      { name: "domain", label: "Domain", type: "text" },
      { name: "industry", label: "Industry", type: "text" },
      { name: "status", label: "Status", type: "select", options: ["active", "archived"] },
      { name: "ownerId", label: "Owner", type: "text" },
    ],
  },
  {
    objectType: "deal",
    label: "Deals",
    fields: [
      { name: "name", label: "Name", type: "text" },
      { name: "amount", label: "Amount", type: "number" },
      { name: "currency", label: "Currency", type: "text" },
      { name: "stage", label: "Stage", type: "text" },
      { name: "probability", label: "Probability", type: "number" },
      { name: "companyId", label: "Company", type: "text" },
      { name: "personId", label: "Person", type: "text" },
      { name: "ownerId", label: "Owner", type: "text" },
    ],
  },
  {
    objectType: "task",
    label: "Tasks",
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "status", label: "Status", type: "text" },
      { name: "priority", label: "Priority", type: "text" },
      { name: "dueDate", label: "Due date", type: "date" },
      { name: "assigneeId", label: "Assignee", type: "text" },
      { name: "ownerId", label: "Owner", type: "text" },
    ],
  },
  {
    objectType: "activity",
    label: "Activities",
    fields: [
      { name: "title", label: "Title", type: "text" },
      { name: "type", label: "Type", type: "text" },
      { name: "status", label: "Status", type: "text" },
      { name: "subjectType", label: "Related to", type: "text" },
      { name: "ownerId", label: "Owner", type: "text" },
    ],
  },
]

/* ---------------------------- reports engine ------------------------------ */

export class DevUnknownObjectError extends Error {
  readonly code = "BAD_REQUEST"
  constructor(objectType: string) {
    super(`unknown object type "${objectType}"`)
    this.name = "DevUnknownObjectError"
  }
}

function comparable(value: unknown): string | number | null {
  if (typeof value === "number") return value
  if (typeof value === "string") return value
  if (value instanceof Date) return value.getTime()
  return null
}

function matchesCondition(row: DevRow, field: string, operator: string, value: unknown): boolean {
  const actual = row[field]
  const text = typeof actual === "string" ? actual.toLowerCase() : null
  const needle = typeof value === "string" ? value.toLowerCase() : null
  const left = comparable(actual)
  const right = comparable(value)
  switch (operator) {
    case "eq":
      return actual === value
    case "neq":
      return actual !== value
    case "contains":
      return text !== null && needle !== null && text.includes(needle)
    case "startsWith":
      return text !== null && needle !== null && text.startsWith(needle)
    case "endsWith":
      return text !== null && needle !== null && text.endsWith(needle)
    case "gt":
      return left !== null && right !== null && left > right
    case "gte":
      return left !== null && right !== null && left >= right
    case "lt":
      return left !== null && right !== null && left < right
    case "lte":
      return left !== null && right !== null && left <= right
    case "in":
      return Array.isArray(value) && value.includes(actual)
    case "notIn":
      return Array.isArray(value) && !value.includes(actual)
    case "isEmpty":
      return actual === null || actual === undefined || actual === ""
    case "isNotEmpty":
      return !(actual === null || actual === undefined || actual === "")
    case "between": {
      if (!Array.isArray(value) || value.length !== 2 || left === null) return false
      const low = comparable(value[0])
      const high = comparable(value[1])
      return low !== null && high !== null && left >= low && left <= high
    }
    default:
      return false
  }
}

function matchesNode(row: DevRow, node: ReportFilterNode): boolean {
  if (node.type === "condition") {
    return matchesCondition(row, node.field, node.operator, node.value)
  }
  if (node.children.length === 0) return true
  return node.combinator === "or"
    ? node.children.some((child) => matchesNode(row, child))
    : node.children.every((child) => matchesNode(row, child))
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function aggregate(fn: string, values: unknown[]): number | null {
  const numbers = values.map(numeric).filter((entry): entry is number => entry !== null)
  switch (fn) {
    case "count":
      return values.length
    case "sum":
      return numbers.reduce((total, entry) => total + entry, 0)
    case "avg":
      return numbers.length === 0 ? null : numbers.reduce((t, e) => t + e, 0) / numbers.length
    case "min":
      return numbers.length === 0 ? null : Math.min(...numbers)
    case "max":
      return numbers.length === 0 ? null : Math.max(...numbers)
    default:
      return null
  }
}

/**
 * The scope contract, restated in memory: `own` means the caller's own
 * records only. The SQL engine narrows by owner/assignee/creator columns;
 * the fixtures carry `ownerId`, which is the same rule with one column.
 */
function inScope(row: DevRow, scope: ReportRowScope): boolean {
  return scope.kind === "workspace" || row.ownerId === scope.actorId
}

export function createDevReportsEngine(dataset: Record<string, DevRow[]>): AiReportQueryPort {
  return {
    describeObjects: () => DEV_CATALOG,
    execute: async (
      _workspaceId: string,
      request: ReportExecutionRequest,
      scope: ReportRowScope,
    ): Promise<ReportExecutionResult> => {
      const entry = DEV_CATALOG.find((candidate) => candidate.objectType === request.objectType)
      const source = dataset[request.objectType]
      if (!entry || !source) throw new DevUnknownObjectError(request.objectType)

      const filter = request.filter ?? null
      const matched = source
        .filter((row) => inScope(row, scope))
        .filter((row) => (filter === null ? true : matchesNode(row, filter)))
      const limit = request.limit ?? 25

      const aggregations = request.aggregations ?? null
      if (aggregations !== null && aggregations.length > 0) {
        const groupBy = request.groupBy ?? null
        const groups = new Map<string, DevRow[]>()
        for (const row of matched) {
          const key = groupBy === null ? "" : String(row[groupBy] ?? "")
          groups.set(key, [...(groups.get(key) ?? []), row])
        }
        const columns: ReportResultColumn[] = [
          ...(groupBy === null
            ? []
            : [
                {
                  key: groupBy,
                  field: groupBy,
                  label: groupBy,
                  type: "text",
                  role: "dimension" as const,
                },
              ]),
          ...aggregations.map((entryAgg, index) => ({
            key: entryAgg.label ?? `${entryAgg.fn}_${String(index)}`,
            field: entryAgg.field ?? null,
            label: entryAgg.label ?? entryAgg.fn,
            type: "number",
            role: "metric" as const,
          })),
        ]
        const resultRows = [...groups.entries()].map(([key, groupRows]) => {
          const row: Record<string, unknown> = groupBy === null ? {} : { [groupBy]: key }
          aggregations.forEach((entryAgg, index) => {
            const column = columns.find(
              (candidate) =>
                candidate.role === "metric" &&
                candidate.key === (entryAgg.label ?? `${entryAgg.fn}_${String(index)}`),
            )
            const values =
              entryAgg.field == null
                ? groupRows.map(() => 1)
                : groupRows.map((groupRow) => groupRow[entryAgg.field ?? ""])
            if (column) row[column.key] = aggregate(entryAgg.fn, values)
          })
          return row
        })
        return {
          objectType: request.objectType,
          mode: "grouped",
          scope: scope.kind,
          columns,
          rows: resultRows.slice(0, limit),
          rowCount: resultRows.length,
          limit,
          truncated: resultRows.length > limit,
        }
      }

      const fields =
        request.columns == null || request.columns.length === 0
          ? entry.fields.map((field) => field.name)
          : request.columns.map((column) => column.field)
      const columns: ReportResultColumn[] = fields.map((name) => {
        const field = entry.fields.find((candidate) => candidate.name === name)
        return {
          key: name,
          field: name,
          label: field?.label ?? name,
          type: field?.type ?? "text",
          role: "dimension",
        }
      })
      const sort = request.sort ?? null
      const ordered = sort === null ? matched : [...matched].sort(bySort(sort))
      const resultRows = ordered.slice(0, limit).map((row) => {
        const projected: Record<string, unknown> = { id: row.id }
        for (const name of fields) projected[name] = row[name] ?? null
        return projected
      })
      return {
        objectType: request.objectType,
        mode: "table",
        scope: scope.kind,
        columns,
        rows: resultRows,
        rowCount: resultRows.length,
        limit,
        truncated: ordered.length > limit,
      }
    },
  }
}

function bySort(sort: { field: string; direction: "asc" | "desc" }[]) {
  return (left: DevRow, right: DevRow): number => {
    for (const entry of sort) {
      const a = comparable(left[entry.field])
      const b = comparable(right[entry.field])
      if (a === null || b === null || a === b) continue
      const order = a < b ? -1 : 1
      return entry.direction === "desc" ? -order : order
    }
    return 0
  }
}

/* ------------------------------ search index ------------------------------ */

function documentsOf(dataset: Record<string, DevRow[]>): SearchDocumentRecord[] {
  const titleOf = (objectType: string, row: DevRow): string => {
    if (objectType === "person") return `${String(row.firstName)} ${String(row.lastName)}`
    return String(row.name ?? row.title ?? row.id)
  }
  return Object.entries(dataset).flatMap(([objectType, entries]) =>
    entries.map((row) => ({
      id: `doc_${objectType}_${row.id}`,
      workspaceId: DEV_WORKSPACE_ID,
      objectType,
      recordId: row.id,
      title: titleOf(objectType, row),
      subtitle: typeof row.stage === "string" ? row.stage : null,
      ownerId: row.ownerId,
      // One private record, so `canReadAllRecords` is observable.
      visibility: row.id === "deal_2" ? "private" : "workspace",
    })),
  )
}

function createDevSearchStore(dataset: Record<string, DevRow[]>): SearchStore {
  const documents = documentsOf(dataset)
  const unsupported = (): never => {
    throw new Error("the MCP dev runtime does not index records — read-only fixture")
  }
  return {
    query: async (workspaceId: string, query: SearchStoreQuery): Promise<SearchHitListResult> => {
      const needle = query.query.toLowerCase()
      const limit = query.limit ?? 20
      const hits = documents
        .filter((document) => document.workspaceId === workspaceId)
        .filter((document) => query.objects.includes(document.objectType))
        .filter((document) => String(document.title).toLowerCase().includes(needle))
        .filter(
          (document) =>
            document.visibility !== "private" ||
            query.includePrivate === true ||
            document.ownerId === query.actorId,
        )
        .slice(0, limit)
        .map((document) => ({ ...document, rank: 1 }))
      return { data: hits, pagination: { nextCursor: null, limit } }
    },
    upsert: unsupported,
    removeByRecord: unsupported,
    findByRecord: async (workspaceId, objectType, recordId) =>
      documents.find(
        (document) =>
          document.workspaceId === workspaceId &&
          document.objectType === objectType &&
          document.recordId === recordId,
      ) ?? null,
  }
}

/* ---------------------------- governance queue ---------------------------- */

export class DevGovernanceUnsupportedError extends Error {
  readonly code = "NOT_IMPLEMENTED"
  constructor(what: string) {
    super(`the MCP dev runtime does not support ${what} — decisions happen in the CRM app`)
    this.name = "DevGovernanceUnsupportedError"
  }
}

/**
 * In-memory queue behind the REAL governance service. Only the methods
 * `requestAction` needs are implemented; everything a decision would touch
 * refuses, because no MCP tool may decide anything.
 */
export function createDevGovernanceStore(requests: AiActionRequestRecord[]): AiGovernanceStore {
  let sequence = 0
  const unsupported = (what: string): never => {
    throw new DevGovernanceUnsupportedError(what)
  }
  return {
    listPolicies: async () => ({ data: [], pagination: { nextCursor: null, limit: 20 } }),
    listActivePolicies: async () => [],
    findPolicyById: async () => null,
    createPolicy: () => unsupported("policy writes"),
    updatePolicy: () => unsupported("policy writes"),
    softDeletePolicy: () => unsupported("policy writes"),
    listRequests: async (workspaceId) => ({
      data: requests.filter((request) => request.workspaceId === workspaceId),
      pagination: { nextCursor: null, limit: 20 },
    }),
    findRequestById: async (workspaceId, id) =>
      requests.find((request) => request.workspaceId === workspaceId && request.id === id) ?? null,
    createRequest: async (workspaceId, input) => {
      sequence += 1
      const record: AiActionRequestRecord = {
        ...input,
        id: `air_${String(sequence)}`,
        workspaceId,
        actorId: String(input.actorId ?? ""),
        objectType: String(input.objectType ?? ""),
        action: String(input.action ?? ""),
        status: String(input.status ?? "pending"),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      requests.push(record)
      return record
    },
    updateRequest: async (workspaceId, id, patch) => {
      const found = requests.find(
        (request) => request.workspaceId === workspaceId && request.id === id,
      )
      if (!found) return null
      Object.assign(found, patch)
      return found
    },
    recordDecision: (): Promise<{ approval: AiActionApprovalRecord; created: boolean }> =>
      unsupported("approving or rejecting"),
    findApprovalByRequest: async () => null,
    claimRequestApply: () => unsupported("applying"),
    claimRequestRevert: () => unsupported("reverting"),
  }
}

/* -------------------------------- runtime --------------------------------- */

export type DevMcpRuntime = {
  runtime: McpRuntime
  /** Proposals the governance service queued. Nothing else writes here. */
  requests: AiActionRequestRecord[]
  /** The fixture records. A mutation would show up here; none can. */
  dataset: Record<string, DevRow[]>
  auditLog: McpAuditInput[]
  /** Times the applier was reached. Must stay 0 — nothing can apply. */
  applyAttempts: () => number
}

export type DevMcpRuntimeOptions = {
  roles?: Record<string, string>
  dataset?: Record<string, DevRow[]>
}

export function createDevMcpRuntime(options: DevMcpRuntimeOptions = {}): DevMcpRuntime {
  const dataset = options.dataset ?? createDevDataset()
  const roles = options.roles ?? DEV_ROLES
  const requests: AiActionRequestRecord[] = []
  const auditLog: McpAuditInput[] = []
  let applyAttempts = 0

  /**
   * THE APPLY SEAM, deliberately welded shut. An approved action is
   * applied by the CRM app, never by the MCP process — so even a bug that
   * reached the applier from here cannot change a record.
   */
  const refuseToApply = (): never => {
    applyAttempts += 1
    throw new Error("the MCP process never applies an AI action")
  }

  const governance = createAiGovernanceService({
    store: createDevGovernanceStore(requests),
    audit: async (input) => {
      auditLog.push({ ...input, source: input.source ?? "ai" })
    },
    events: { emit: async () => undefined },
    applier: { applyAiAction: refuseToApply, revertAiAction: refuseToApply },
    resolveActorRole: async (_workspaceId, actorId) => roles[actorId] ?? null,
  })

  const search = createSearchService({
    store: createDevSearchStore(dataset),
    audit: async (input) => {
      auditLog.push({ ...input, source: input.source ?? "user" })
    },
  })

  return {
    runtime: {
      reports: createDevReportsEngine(dataset),
      search,
      governance,
      audit: async (input) => {
        auditLog.push(input)
      },
    },
    requests,
    dataset,
    auditLog,
    applyAttempts: () => applyAttempts,
  }
}
