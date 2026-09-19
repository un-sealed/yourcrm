import { describe, expect, test } from "bun:test"
import { expectDenied, makeServiceContext } from "@yourcrm/testing"
import type {
  ReportExecutionRequest,
  ReportExecutionResult,
  ReportRowScope,
} from "../reports/types"
import {
  AiWriteToolNotAllowedError,
  createAiCrmTools,
  createAiQueryTool,
  createAiToolRegistry,
} from "./tools"
import type { AiReportQueryPort, AiTool } from "./types"

const WORKSPACE = "ws_tools"

function createEngine() {
  const seen: { request: ReportExecutionRequest; scope: ReportRowScope }[] = []
  const reports: AiReportQueryPort = {
    describeObjects: () => [
      {
        objectType: "deal",
        label: "Deals",
        fields: [{ name: "stage", label: "Stage", type: "text" }],
      },
    ],
    execute: async (
      _workspaceId: string,
      request: ReportExecutionRequest,
      scope: ReportRowScope,
    ): Promise<ReportExecutionResult> => {
      seen.push({ request, scope })
      return {
        objectType: request.objectType,
        mode: request.aggregations ? "grouped" : "table",
        scope: scope.kind,
        columns: [],
        rows: [],
        rowCount: 0,
        limit: 25,
        truncated: false,
      }
    },
  }
  return { reports, seen }
}

function ctxFor(role: string, actorId = "user_1") {
  return makeServiceContext({ workspaceId: WORKSPACE, actorId, role })
}

describe("ai-assistant/tool-registry", () => {
  test("the P0 registry exposes exactly the two read-only tools", () => {
    const registry = createAiCrmTools(createEngine())
    expect(registry.list().map((tool) => tool.name)).toEqual(["crm_describe_objects", "crm_query"])
    expect(registry.list().every((tool) => tool.access === "read")).toBe(true)
    expect(registry.get("crm_query")?.name).toBe("crm_query")
    expect(registry.get("crm_delete_everything")).toBeNull()
  })

  test("definitions are JSON-Schema tool definitions the provider can send", () => {
    const definitions = createAiCrmTools(createEngine()).definitions()
    const query = definitions.find((definition) => definition.name === "crm_query")
    expect(query?.parameters.type).toBe("object")
    expect((query?.parameters.required as string[]).includes("objectType")).toBe(true)
  })

  /**
   * Regression: a gateway rejected a parameter-less tool whose schema left
   * `required` out — `null is not of type "array"` (seen live). Every tool
   * schema must be a complete JSON Schema object.
   */
  test("every tool schema is complete: type, properties and a required array", () => {
    for (const definition of createAiCrmTools(createEngine()).definitions()) {
      expect(definition.parameters.type, definition.name).toBe("object")
      expect(typeof definition.parameters.properties, definition.name).toBe("object")
      expect(Array.isArray(definition.parameters.required), definition.name).toBe(true)
      expect(definition.description.length, definition.name).toBeGreaterThan(20)
    }
  })

  /** The seam spec 38 will build on: no write tool can be registered in P0. */
  test("registering a non-read tool is refused at construction", () => {
    const writeTool = {
      name: "crm_update_deal",
      description: "would mutate",
      parameters: { type: "object" },
      access: "write",
      execute: async () => ({ result: null, summary: "" }),
    } as unknown as AiTool
    expect(() => createAiToolRegistry([writeTool])).toThrow(AiWriteToolNotAllowedError)
    expect(() => createAiToolRegistry([writeTool])).toThrow("spec 38-ai-governance")
  })
})

describe("ai-assistant/crm_query", () => {
  test("row scope follows the caller's role, not the arguments", async () => {
    const engine = createEngine()
    const tool = createAiQueryTool(engine)

    await tool.execute(ctxFor("admin", "u_admin"), { objectType: "deal" })
    await tool.execute(ctxFor("member", "u_member"), { objectType: "deal" })

    expect(engine.seen[0]?.scope).toEqual({ kind: "workspace" })
    expect(engine.seen[1]?.scope).toEqual({ kind: "own", actorId: "u_member" })
  })

  test("flat conditions compile into the one filter model", async () => {
    const engine = createEngine()
    await createAiQueryTool(engine).execute(ctxFor("admin"), {
      objectType: "deal",
      combinator: "or",
      filters: [
        { field: "stage", operator: "eq", value: "won" },
        { field: "amount", operator: "gte", value: 1000 },
      ],
      aggregations: [{ fn: "count" }],
      groupBy: "stage",
      limit: 10,
    })
    const request = engine.seen[0]?.request
    expect(request?.filter?.combinator).toBe("or")
    expect(request?.filter?.children).toHaveLength(2)
    expect(request?.groupBy).toBe("stage")
    expect(request?.aggregations).toEqual([{ fn: "count", field: null, label: null }])
    expect(request?.limit).toBe(10)
  })

  test("a malformed argument object is rejected before the engine is touched", async () => {
    const engine = createEngine()
    await expect(
      createAiQueryTool(engine).execute(ctxFor("admin"), { objectType: "" }),
    ).rejects.toThrow()
    await expect(
      createAiQueryTool(engine).execute(ctxFor("admin"), {
        objectType: "deal",
        filters: [{ field: "stage", operator: "noSuchOperator" }],
      }),
    ).rejects.toThrow()
    expect(engine.seen).toHaveLength(0)
  })

  test("a caller with no workspace or actor is denied before anything runs", async () => {
    const engine = createEngine()
    await expectDenied(() =>
      createAiQueryTool(engine).execute(
        { workspaceId: "", actorId: "", role: "admin" },
        { objectType: "deal" },
      ),
    )
    expect(engine.seen).toHaveLength(0)
  })

  test("the summary names the scope so the UI can show it", async () => {
    const engine = createEngine()
    const execution = await createAiQueryTool(engine).execute(ctxFor("viewer", "u_v"), {
      objectType: "deal",
    })
    expect(execution.summary).toContain("own scope")
  })
})
