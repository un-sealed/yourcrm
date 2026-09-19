import { readFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Database } from "../client"
import {
  workflowRunSteps,
  workflowRuns,
  workflows,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunStep,
} from "../schema/automation"
import {
  createAutomationRepository,
  describeWorkflowTargets,
  normalizeWorkflowName,
  resolveWorkflowTargetField,
  validateWorkflowActions,
  validateWorkflowConditions,
  validateWorkflowStatus,
  WorkflowDefinitionError,
} from "./automation-repository"

const WS = "11111111-1111-4111-8111-111111111111"
const WORKFLOW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const STEP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const MIGRATION = new URL("../../migrations/0190_automation.sql", import.meta.url)

/** Thenable chain stub: every query builder call returns the proxy; each await pops one result. */
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

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: WORKFLOW_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    ownerId: null,
    name: "Welcome flow",
    description: null,
    triggerEvent: "person.created",
    triggerEntityType: null,
    conditions: null,
    actions: [{ type: "create_task", title: "Call them" }],
    status: "disabled",
    lastRunAt: null,
    ...overrides,
  }
}

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: RUN_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    workflowId: WORKFLOW_ID,
    triggerEventId: "evt_1",
    triggerEvent: "person.created",
    entityType: "person",
    entityId: "person_1",
    triggerPayload: null,
    status: "queued",
    depth: 0,
    parentRunId: null,
    actorId: null,
    actorRole: null,
    correlationId: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

function makeStep(overrides: Partial<WorkflowRunStep> = {}): WorkflowRunStep {
  return {
    id: STEP_ID,
    workspaceId: WS,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    runId: RUN_ID,
    stepIndex: 0,
    actionType: "create_task",
    status: "running",
    result: null,
    error: null,
    finishedAt: null,
    ...overrides,
  }
}

describe("automation/schema", () => {
  test("all three tables expose the BaseRecord column contract", () => {
    for (const table of [workflows, workflowRuns, workflowRunSteps]) {
      const cols = table as unknown as Record<string, unknown>
      for (const col of ["id", "workspaceId", "createdAt", "updatedAt", "deletedAt"]) {
        expect(cols[col], col).toBeDefined()
      }
    }
  })

  test("a run carries its idempotency key, actor and cascade depth", () => {
    const cols = workflowRuns as unknown as Record<string, unknown>
    expect(cols.triggerEventId).toBeDefined()
    expect(cols.depth).toBeDefined()
    expect(cols.parentRunId).toBeDefined()
    expect(cols.actorId).toBeDefined()
    expect(cols.actorRole).toBeDefined()
  })

  test("a step is addressed by (run, index)", () => {
    const cols = workflowRunSteps as unknown as Record<string, unknown>
    expect(cols.runId).toBeDefined()
    expect(cols.stepIndex).toBeDefined()
    expect(cols.result).toBeDefined()
  })
})

describe("automation/validation", () => {
  test("names trim and collapse whitespace", () => {
    expect(normalizeWorkflowName("  Welcome   flow ")).toBe("Welcome flow")
    expect(() => normalizeWorkflowName("   ")).toThrow(WorkflowDefinitionError)
    expect(() => normalizeWorkflowName("x".repeat(256))).toThrow(WorkflowDefinitionError)
  })

  test("only the P0 action types are storable", () => {
    expect(validateWorkflowActions([{ type: "add_tag", tag: "vip" }])).toHaveLength(1)
    expect(() => validateWorkflowActions([{ type: "send_email" }])).toThrow(/unknown type/)
    expect(() => validateWorkflowActions([])).toThrow(/at least one action/)
    expect(() => validateWorkflowActions("nope")).toThrow(/must be an array/)
  })

  test("action count is capped", () => {
    const many = Array.from({ length: 21 }, () => ({ type: "add_tag", tag: "x" }))
    expect(() => validateWorkflowActions(many)).toThrow(/at most 20 actions/)
  })

  test("conditions must be a FilterBuilder group", () => {
    expect(validateWorkflowConditions(null)).toBeNull()
    const tree = {
      type: "group",
      id: "g1",
      combinator: "and",
      children: [{ type: "condition", id: "c1", field: "status", operator: "eq", value: "vip" }],
    }
    expect(validateWorkflowConditions(tree)?.children).toHaveLength(1)
    expect(() => validateWorkflowConditions({ op: "and", conditions: [] })).toThrow(
      /FilterBuilder group/,
    )
    expect(() =>
      validateWorkflowConditions({ type: "condition", id: "c1", field: "a", operator: "eq" }),
    ).toThrow(/FilterBuilder group/)
  })

  test("status is enabled or disabled", () => {
    expect(validateWorkflowStatus("enabled")).toBe("enabled")
    expect(() => validateWorkflowStatus("published")).toThrow(WorkflowDefinitionError)
  })
})

describe("automation/definitions", () => {
  test("create returns the inserted definition, disabled by default", async () => {
    const repo = createAutomationRepository()
    const row = makeWorkflow()
    const result = await repo.create(mockDb([[row]]), WS, {
      name: "Welcome flow",
      triggerEvent: "person.created",
      actions: [{ type: "create_task", title: "Call them" }],
    })
    expect(result).toBe(row)
  })

  test("create rejects a bad definition before touching the db", async () => {
    const repo = createAutomationRepository()
    await expect(
      repo.create(mockDb(), WS, {
        name: "  ",
        triggerEvent: "person.created",
        actions: [{ type: "create_task", title: "x" }],
      }),
    ).rejects.toThrow(WorkflowDefinitionError)
    await expect(
      repo.create(mockDb(), WS, {
        name: "Bad actions",
        triggerEvent: "person.created",
        actions: [{ type: "launch_missiles" }],
      }),
    ).rejects.toThrow(/unknown type/)
  })

  test("search returns the cursor pagination envelope", async () => {
    const repo = createAutomationRepository()
    const rows = [
      makeWorkflow({ id: "id-1" }),
      makeWorkflow({ id: "id-2" }),
      makeWorkflow({ id: "id-3" }),
    ]
    const result = await repo.search(mockDb([rows]), {
      workspaceId: WS,
      limit: 2,
      query: "welcome",
    })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "id-2", limit: 2 })
  })

  test("search rejects an unknown status filter", async () => {
    const repo = createAutomationRepository()
    await expect(repo.search(mockDb([[]]), { workspaceId: WS, status: "paused" })).rejects.toThrow(
      WorkflowDefinitionError,
    )
  })

  test("update returns null when the row is missing", async () => {
    const repo = createAutomationRepository()
    await expect(repo.update(mockDb([[]]), WS, "missing", { name: "Renamed" })).resolves.toBeNull()
  })

  test("listEnabledByTrigger asks for one event's live, enabled definitions", async () => {
    const repo = createAutomationRepository()
    const rows = [makeWorkflow({ status: "enabled" })]
    await expect(repo.listEnabledByTrigger(mockDb([rows]), WS, "person.created")).resolves.toEqual(
      rows,
    )
  })
})

describe("automation/idempotent-writes", () => {
  test("createRun reports a fresh insert", async () => {
    const repo = createAutomationRepository()
    const row = makeRun()
    const result = await repo.createRun(mockDb([[row]]), WS, {
      workflowId: WORKFLOW_ID,
      triggerEventId: "evt_1",
      triggerEvent: "person.created",
    })
    expect(result).toEqual({ run: row, created: true })
  })

  test("createRun returns the existing run when the event was already seen", async () => {
    const repo = createAutomationRepository()
    const row = makeRun()
    // step 0: insert ... ON CONFLICT DO NOTHING -> [] (conflict)
    // step 1: select the winner -> [row]
    const result = await repo.createRun(mockDb([[], [row]]), WS, {
      workflowId: WORKFLOW_ID,
      triggerEventId: "evt_1",
      triggerEvent: "person.created",
    })
    expect(result).toEqual({ run: row, created: false })
  })

  test("createRun rejects an unknown status rather than storing it", async () => {
    const repo = createAutomationRepository()
    await expect(
      repo.createRun(mockDb(), WS, {
        workflowId: WORKFLOW_ID,
        triggerEventId: "evt_1",
        triggerEvent: "person.created",
        status: "paused",
      }),
    ).rejects.toThrow(/unknown run status/)
  })

  test("claimRunStep claims a fresh slot, then reports the loser on retry", async () => {
    const repo = createAutomationRepository()
    const step = makeStep()
    await expect(
      repo.claimRunStep(mockDb([[step]]), WS, {
        runId: RUN_ID,
        stepIndex: 0,
        actionType: "create_task",
      }),
    ).resolves.toEqual({ step, claimed: true })

    const done = makeStep({ status: "succeeded" })
    await expect(
      repo.claimRunStep(mockDb([[], [done]]), WS, {
        runId: RUN_ID,
        stepIndex: 0,
        actionType: "create_task",
      }),
    ).resolves.toEqual({ step: done, claimed: false })
  })

  test("claimRunStep rejects a negative index", async () => {
    const repo = createAutomationRepository()
    await expect(
      repo.claimRunStep(mockDb(), WS, { runId: RUN_ID, stepIndex: -1, actionType: "add_tag" }),
    ).rejects.toThrow(/non-negative/)
  })

  test("a conflict with no surviving row is an error, never a silent skip", async () => {
    const repo = createAutomationRepository()
    await expect(
      repo.createRun(mockDb([[], []]), WS, {
        workflowId: WORKFLOW_ID,
        triggerEventId: "evt_1",
        triggerEvent: "person.created",
      }),
    ).rejects.toThrow(/conflict without a row/)
  })
})

describe("automation/runs", () => {
  test("searchRuns paginates", async () => {
    const repo = createAutomationRepository()
    const rows = [makeRun({ id: "r1" }), makeRun({ id: "r2" }), makeRun({ id: "r3" })]
    const result = await repo.searchRuns(mockDb([rows]), { workspaceId: WS, limit: 2 })
    expect(result.data).toHaveLength(2)
    expect(result.pagination).toEqual({ nextCursor: "r2", limit: 2 })
  })

  test("updateRun rejects an unknown status", async () => {
    const repo = createAutomationRepository()
    await expect(repo.updateRun(mockDb(), WS, RUN_ID, { status: "paused" })).rejects.toThrow(
      /unknown run status/,
    )
  })

  test("completeRunStep rejects an unknown step status", async () => {
    const repo = createAutomationRepository()
    await expect(
      repo.completeRunStep(mockDb(), WS, STEP_ID, { status: "cancelled" }),
    ).rejects.toThrow(/unknown step status/)
  })

  test("listRunSteps returns the ordered attempts", async () => {
    const repo = createAutomationRepository()
    const rows = [makeStep({ stepIndex: 0 }), makeStep({ id: "s2", stepIndex: 1 })]
    await expect(repo.listRunSteps(mockDb([rows]), WS, RUN_ID)).resolves.toEqual(rows)
  })
})

describe("automation/action-targets", () => {
  test("only allowlisted objects are updatable", () => {
    expect(resolveWorkflowTargetField("person", "status").objectType).toBe("person")
    expect(() => resolveWorkflowTargetField("invoice", "status")).toThrow(/cannot update 'invoice'/)
  })

  test("identity, workspace and soft-delete columns are unreachable", () => {
    for (const field of ["id", "workspaceId", "deletedAt", "createdAt"]) {
      expect(() => resolveWorkflowTargetField("person", field), field).toThrow(
        /not an automatable field/,
      )
    }
  })

  test("the catalogue lists every writable object and field", () => {
    const targets = describeWorkflowTargets()
    expect(targets.map((t) => t.objectType).sort()).toEqual([
      "company",
      "deal",
      "lead",
      "person",
      "task",
    ])
    expect(targets.find((t) => t.objectType === "deal")?.fields).toContain("ownerId")
  })

  test("updateTargetField rejects an unknown field before touching the db", async () => {
    const repo = createAutomationRepository()
    await expect(
      repo.updateTargetField(mockDb(), WS, { entityType: "person", entityId: "p1" }, "salary", 1),
    ).rejects.toThrow(/not an automatable field/)
  })

  test("updateTargetField surfaces a missing record as an error, not a silent skip", async () => {
    const repo = createAutomationRepository()
    await expect(
      repo.updateTargetField(
        mockDb([[]]),
        WS,
        { entityType: "person", entityId: "p1" },
        "status",
        "active",
      ),
    ).rejects.toThrow(/was not found/)
  })

  test("attachTagByName reuses an existing tag instead of duplicating it", async () => {
    const repo = createAutomationRepository()
    // step 0: tag lookup -> [existing tag]; step 1: attach (update) -> [link]
    const result = await repo.attachTagByName(
      mockDb([[{ id: "tag_1", name: "vip" }], [{ id: "link_1" }]]),
      WS,
      { entityType: "person", entityId: "p1" },
      "  VIP ",
    )
    expect(result).toEqual({ tagId: "tag_1" })
  })

  test("createNotification rejects an empty title", async () => {
    const repo = createAutomationRepository()
    await expect(
      repo.createNotification(mockDb(), WS, { userId: "u1", type: "automation", title: "  " }),
    ).rejects.toThrow(/must not be empty/)
  })

  test("createNotification returns the new row id", async () => {
    const repo = createAutomationRepository()
    await expect(
      repo.createNotification(mockDb([[{ id: "notif_1" }]]), WS, {
        userId: "u1",
        type: "automation",
        title: "New person",
      }),
    ).resolves.toEqual({ notificationId: "notif_1" })
  })
})

describe("automation/migration", () => {
  test("0190 creates the three tables", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS workflows")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS workflow_runs")
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS workflow_run_steps")
  })

  test("the idempotency and step-claim indexes are UNIQUE", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_event_idx\n  ON workflow_runs (workflow_id, trigger_event_id)",
    )
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS workflow_run_steps_index_idx\n  ON workflow_run_steps (run_id, step_index)",
    )
  })

  test("the dispatcher's lookup index exists", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain(
      "workflows_trigger_idx ON workflows (workspace_id, trigger_event, status)",
    )
  })

  test("runs carry a depth counter defaulting to zero", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    expect(sql).toContain("depth INTEGER NOT NULL DEFAULT 0")
  })

  test("foreign keys point only at tables this migration owns", async () => {
    const sql = await readFile(MIGRATION, "utf8")
    const references = [...sql.matchAll(/REFERENCES\s+(\w+)/g)].map((m) => m[1])
    expect(new Set(references)).toEqual(new Set(["workflows", "workflow_runs"]))
    // Owner/actor stay plain uuid columns, like reports and dashboards.
    expect(sql).not.toContain("REFERENCES users")
    expect(sql).not.toContain("REFERENCES tasks")
  })
})
