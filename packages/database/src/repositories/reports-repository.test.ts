import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { PgDialect } from "drizzle-orm/pg-core"
import type { Database } from "../client"
import { reports, type Report, type ReportFilterTree } from "../schema/reports"
import {
  compileReportFilter,
  createReportsRepository,
  describeReportObjects,
  planReportExecution,
  REPORT_OBJECTS,
  REPORT_OBJECT_TYPES,
  resolveReportField,
  resolveReportObject,
  validateReportDefinition,
  type ReportObjectDef,
  type ReportRowScope,
} from "./reports-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const ACTOR = "22222222-2222-4222-8222-222222222222"
const REPORT_ID = "33333333-3333-4333-8333-333333333333"
const MIGRATION = new URL("../../migrations/0160_reports.sql", import.meta.url)

const dialect = new PgDialect()

/** Thenable chain stub: every builder call returns the proxy; each await pops one result. */
function mockDb(queued: unknown[][] = []) {
  let step = 0
  const proxy = new Proxy(function () {}, {
    get(_target, prop: string | symbol) {
      if (prop === "then") {
        return (resolve: (value: unknown) => void) => {
          resolve(queued[step] ?? [])
          step += 1
        }
      }
      return (..._args: unknown[]) => proxy
    },
  })
  return proxy as unknown as Database
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: REPORT_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: ACTOR,
    updatedBy: null,
    deletedAt: null,
    ownerId: ACTOR,
    name: "Open deals by stage",
    description: null,
    objectType: "deal",
    visibility: "shared",
    filter: null,
    groupBy: "stage",
    aggregations: [{ fn: "count" }],
    columns: null,
    sort: null,
    rowLimit: 100,
    lastRunAt: null,
    ...overrides,
  }
}

function condition(field: string, operator: string, value?: unknown): ReportFilterTree {
  return {
    type: "group",
    id: "root",
    combinator: "and",
    children: [
      { type: "condition", id: "c1", field, operator, ...(value === undefined ? {} : { value }) },
    ],
  }
}

function compiled(request: Parameters<typeof planReportExecution>[1], scope: ReportRowScope) {
  return dialect.sqlToQuery(planReportExecution(WS, request, scope).statement)
}

const WORKSPACE_SCOPE: ReportRowScope = { kind: "workspace" }
const OWN_SCOPE: ReportRowScope = { kind: "own", actorId: ACTOR }

describe("reports/schema", () => {
  test("reports expose the BaseRecord column contract plus the definition columns", () => {
    const cols = reports as unknown as Record<string, unknown>
    for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt", "ownerId"]) {
      expect(cols[col], col).toBeDefined()
    }
    for (const col of ["name", "objectType", "visibility", "filter", "groupBy", "aggregations"]) {
      expect(cols[col], col).toBeDefined()
    }
  })
})

describe("reports/registry", () => {
  test("every reportable object exposes fields and ownership columns", () => {
    expect(REPORT_OBJECT_TYPES.length).toBeGreaterThan(0)
    for (const key of REPORT_OBJECT_TYPES) {
      const object = REPORT_OBJECTS[key] as ReportObjectDef
      expect(Object.keys(object.fields).length).toBeGreaterThan(0)
      expect(object.actorColumns.length).toBeGreaterThan(0)
    }
  })

  test("unknown object types and fields are rejected by the allowlist", () => {
    expect(() => resolveReportObject("secrets")).toThrow(/unknown object type/)
    expect(() => resolveReportObject(42)).toThrow(/must be a string/)
    const person = resolveReportObject("person")
    expect(resolveReportField(person, "firstName").name).toBe("firstName")
    expect(() => resolveReportField(person, "notes")).toThrow(/unknown field/)
  })

  test("the field catalogue is serialisable (no drizzle columns leak out)", () => {
    const described = describeReportObjects()
    expect(described.map((o) => o.objectType)).toEqual(REPORT_OBJECT_TYPES)
    const person = described.find((o) => o.objectType === "person")
    expect(JSON.stringify(person)).toContain("firstName")
    const status = person?.fields.find((f) => f.name === "status")
    expect(status?.options).toEqual(["active", "archived"])
  })
})

describe("reports/sql-injection", () => {
  test("a field name carrying SQL is rejected, never interpolated", () => {
    const malicious = `stage" ; DROP TABLE reports; --`
    expect(() =>
      planReportExecution(WS, { objectType: "deal", groupBy: malicious }, WORKSPACE_SCOPE),
    ).toThrow(/unknown field/)
    expect(() =>
      planReportExecution(
        WS,
        { objectType: "deal", columns: [{ field: malicious }] },
        WORKSPACE_SCOPE,
      ),
    ).toThrow(/unknown field/)
    expect(() =>
      planReportExecution(
        WS,
        { objectType: "deal", filter: condition(malicious, "eq", "x") },
        WORKSPACE_SCOPE,
      ),
    ).toThrow(/unknown field/)
  })

  test("an object type carrying SQL is rejected", () => {
    expect(() =>
      planReportExecution(WS, { objectType: "deals; DROP TABLE reports" }, WORKSPACE_SCOPE),
    ).toThrow(/unknown object type/)
  })

  test("an aggregate function carrying SQL is rejected", () => {
    expect(() =>
      planReportExecution(
        WS,
        {
          objectType: "deal",
          groupBy: "stage",
          aggregations: [
            { fn: "sum(amount) FROM reports; --" as unknown as "sum", field: "amount" },
          ],
        },
        WORKSPACE_SCOPE,
      ),
    ).toThrow(/unknown function/)
  })

  test("a sort direction carrying SQL is rejected", () => {
    expect(() =>
      planReportExecution(
        WS,
        {
          objectType: "deal",
          columns: [{ field: "name" }],
          sort: [{ field: "name", direction: "asc; DROP TABLE reports" as unknown as "asc" }],
        },
        WORKSPACE_SCOPE,
      ),
    ).toThrow(/direction must be/)
  })

  test("hostile filter VALUES land in bound parameters, never in the SQL text", () => {
    const payload = "'); DROP TABLE people; --"
    const query = compiled(
      {
        objectType: "person",
        columns: [{ field: "firstName" }],
        filter: condition("firstName", "eq", payload),
      },
      WORKSPACE_SCOPE,
    )
    expect(query.sql).not.toContain("DROP")
    expect(query.sql).not.toContain(payload)
    expect(query.params).toContain(payload)
    expect(query.sql).toContain('"people"."first_name" = $')
  })

  test("LIKE metacharacters in contains are escaped and still parameterised", () => {
    const query = compiled(
      {
        objectType: "person",
        columns: [{ field: "firstName" }],
        filter: condition("firstName", "contains", "100%_x"),
      },
      WORKSPACE_SCOPE,
    )
    expect(query.params).toContain("%100\\%\\_x%")
    expect(query.sql).not.toContain("100")
  })

  test("the projection only ever uses generated aliases", () => {
    const plan = planReportExecution(
      WS,
      { objectType: "deal", groupBy: "stage", aggregations: [{ fn: "sum", field: "amount" }] },
      WORKSPACE_SCOPE,
    )
    expect(plan.aliases).toEqual(["col_1", "metric_1"])
    const query = dialect.sqlToQuery(plan.statement)
    expect(query.sql).toContain('AS "col_1"')
    expect(query.sql).toContain('AS "metric_1"')
    expect(query.sql).toContain('sum("deals"."amount")')
  })
})

describe("reports/planner", () => {
  test("table mode selects the requested columns and always scopes the workspace", () => {
    const query = compiled(
      { objectType: "person", columns: [{ field: "firstName" }, { field: "status" }] },
      WORKSPACE_SCOPE,
    )
    expect(query.sql).toContain('"people"."first_name" AS "col_1"')
    expect(query.sql).toContain('"people"."status" AS "col_2"')
    expect(query.sql).toContain('"people"."workspace_id" = $1')
    expect(query.sql).toContain('"people"."deleted_at" is null')
    expect(query.params[0]).toBe(WS)
  })

  test("table mode falls back to a default column set", () => {
    const plan = planReportExecution(WS, { objectType: "task" }, WORKSPACE_SCOPE)
    expect(plan.mode).toBe("table")
    expect(plan.columns.length).toBeGreaterThan(0)
    expect(plan.columns.every((c) => c.role === "dimension")).toBe(true)
  })

  test("grouped mode groups by the dimension and defaults to a row count", () => {
    const plan = planReportExecution(WS, { objectType: "deal", groupBy: "stage" }, WORKSPACE_SCOPE)
    expect(plan.mode).toBe("grouped")
    expect(plan.columns.map((c) => c.key)).toEqual(["stage", "count"])
    const query = dialect.sqlToQuery(plan.statement)
    expect(query.sql).toContain('GROUP BY "deals"."stage"')
    expect(query.sql).toContain("count(*)")
  })

  test("sum/avg require a numeric field", () => {
    expect(() =>
      planReportExecution(
        WS,
        { objectType: "deal", groupBy: "stage", aggregations: [{ fn: "sum", field: "name" }] },
        WORKSPACE_SCOPE,
      ),
    ).toThrow(/needs a numeric field/)
    expect(
      planReportExecution(
        WS,
        { objectType: "deal", groupBy: "stage", aggregations: [{ fn: "sum", field: "amount" }] },
        WORKSPACE_SCOPE,
      ).columns[1]?.role,
    ).toBe("metric")
  })

  test("sorting is limited to selected columns and metrics", () => {
    const query = compiled(
      {
        objectType: "deal",
        groupBy: "stage",
        aggregations: [{ fn: "count" }],
        sort: [{ field: "count", direction: "desc" }],
      },
      WORKSPACE_SCOPE,
    )
    expect(query.sql).toContain("ORDER BY count(*) DESC")
    expect(() =>
      planReportExecution(
        WS,
        {
          objectType: "deal",
          columns: [{ field: "name" }],
          sort: [{ field: "amount", direction: "asc" }],
        },
        WORKSPACE_SCOPE,
      ),
    ).toThrow(/not a selected column/)
  })

  test("the row limit is clamped and fetches one extra row to detect truncation", () => {
    expect(
      planReportExecution(WS, { objectType: "person", limit: 5000 }, WORKSPACE_SCOPE).limit,
    ).toBe(500)
    expect(planReportExecution(WS, { objectType: "person", limit: 0 }, WORKSPACE_SCOPE).limit).toBe(
      1,
    )
    const query = compiled({ objectType: "person", limit: 10 }, WORKSPACE_SCOPE)
    expect(query.params.at(-1)).toBe(11)
  })

  test("filters reject unusable values before reaching the database", () => {
    const person = resolveReportObject("person")
    expect(() => compileReportFilter(person, condition("createdAt", "gt", "not-a-date"))).toThrow(
      /is not a date/,
    )
    expect(() => compileReportFilter(person, condition("firstName", "between", ["a"]))).toThrow(
      /exactly two values/,
    )
    expect(() => compileReportFilter(person, condition("firstName", "like", "x"))).toThrow(
      /unsupported operator/,
    )
    expect(compileReportFilter(person, null)).toBeUndefined()
    expect(
      compileReportFilter(person, { type: "group", id: "root", combinator: "and", children: [] }),
    ).toBeUndefined()
  })

  test("deeply nested filters are refused", () => {
    let node: ReportFilterTree = { type: "group", id: "leaf", combinator: "and", children: [] }
    for (let i = 0; i < 8; i++) {
      node = { type: "group", id: `g${String(i)}`, combinator: "and", children: [node] }
    }
    expect(() => compileReportFilter(resolveReportObject("person"), node)).toThrow(
      /nested more than/,
    )
  })
})

describe("reports/row-scope", () => {
  test("workspace scope adds no ownership predicate", () => {
    const query = compiled({ objectType: "person" }, WORKSPACE_SCOPE)
    expect(query.sql).not.toContain('"people"."owner_id" = ')
  })

  test("own scope restricts rows to records the actor owns or created", () => {
    const query = compiled({ objectType: "person" }, OWN_SCOPE)
    expect(query.sql).toContain('"people"."owner_id" = $')
    expect(query.sql).toContain('"people"."created_by" = $')
    expect(query.params).toContain(ACTOR)
  })

  test("own scope covers assignment where the object has an assignee", () => {
    const query = compiled({ objectType: "task" }, OWN_SCOPE)
    expect(query.sql).toContain('"tasks"."assignee_id" = $')
  })

  test("own scope without an actor is refused instead of falling back to everything", () => {
    expect(() =>
      planReportExecution(WS, { objectType: "person" }, { kind: "own", actorId: "" }),
    ).toThrow(/needs an actor id/)
  })
})

describe("reports/validation", () => {
  test("valid definitions pass and broken ones return a message", () => {
    expect(
      validateReportDefinition({
        objectType: "deal",
        groupBy: "stage",
        aggregations: [{ fn: "count" }],
      }),
    ).toBeNull()
    expect(validateReportDefinition({ objectType: "nope" })).toContain("unknown object type")
    expect(validateReportDefinition({ objectType: "deal", groupBy: "secret" })).toContain(
      "unknown field",
    )
  })
})

describe("reports/repository", () => {
  test("create returns the inserted row", async () => {
    const repo = createReportsRepository()
    const row = makeReport()
    const result = await repo.create(mockDb([[row]]), WS, {
      name: "Open deals by stage",
      objectType: "deal",
      groupBy: "stage",
    })
    expect(result).toBe(row)
  })

  test("create rejects an empty name and an invalid definition before touching the db", async () => {
    const repo = createReportsRepository()
    await expect(repo.create(mockDb(), WS, { name: "  ", objectType: "deal" })).rejects.toThrow(
      /name/,
    )
    await expect(
      repo.create(mockDb(), WS, { name: "Bad", objectType: "deal", groupBy: "nope" }),
    ).rejects.toThrow(/invalid definition/)
  })

  test("create surfaces empty insert results as errors", async () => {
    const repo = createReportsRepository()
    await expect(
      repo.create(mockDb([[]]), WS, { name: "Deals", objectType: "deal" }),
    ).rejects.toThrow(/no rows/)
  })

  test("update returns null when the row is missing", async () => {
    const repo = createReportsRepository()
    await expect(repo.update(mockDb([[]]), WS, "missing", { name: "x" })).resolves.toBeNull()
  })

  test("update validates the merged definition, not just the patch", async () => {
    const repo = createReportsRepository()
    await expect(
      repo.update(mockDb([[makeReport()]]), WS, REPORT_ID, { groupBy: "secret" }),
    ).rejects.toThrow(/unknown field/)
  })

  test("search rejects unknown object-type and visibility filters", async () => {
    const repo = createReportsRepository()
    await expect(
      repo.search(mockDb(), { workspaceId: WS, objectType: "vault", scope: { kind: "all" } }),
    ).rejects.toThrow(/unknown object type/)
    await expect(
      repo.search(mockDb(), { workspaceId: WS, visibility: "secret", scope: { kind: "all" } }),
    ).rejects.toThrow(/unknown visibility/)
  })

  test("execute maps generated aliases back to stable keys and reports truncation", async () => {
    const repo = createReportsRepository()
    const rows = [
      { col_1: "qualification", metric_1: "4" },
      { col_1: "won", metric_1: "2" },
      { col_1: "lost", metric_1: "1" },
    ]
    const result = await repo.execute(
      mockDb([rows]),
      WS,
      { objectType: "deal", groupBy: "stage", aggregations: [{ fn: "count" }], limit: 2 },
      WORKSPACE_SCOPE,
    )
    expect(result.mode).toBe("grouped")
    expect(result.scope).toBe("workspace")
    expect(result.truncated).toBe(true)
    expect(result.rowCount).toBe(2)
    expect(result.rows).toEqual([
      { stage: "qualification", count: "4" },
      { stage: "won", count: "2" },
    ])
  })

  test("execute reports the scope it ran under", async () => {
    const repo = createReportsRepository()
    const result = await repo.execute(mockDb([[]]), WS, { objectType: "person" }, OWN_SCOPE)
    expect(result.scope).toBe("own")
    expect(result.rows).toEqual([])
    expect(result.truncated).toBe(false)
  })
})

describe("reports/migration", () => {
  test("0160 creates the reports table with the agreed indexes", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS reports")
    expect(sql).toContain("object_type VARCHAR(64) NOT NULL")
    expect(sql).toContain("visibility VARCHAR(32) NOT NULL DEFAULT 'shared'")
    expect(sql).toContain("filter JSONB")
    expect(sql).toContain("aggregations JSONB")
    expect(sql).toContain("reports_workspace_object_idx")
    expect(sql).toContain("reports_owner_idx")
  })

  test("reports own no foreign keys to other modules' tables", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).not.toContain("REFERENCES")
    expect(sql).toContain("owner_id UUID")
  })
})
