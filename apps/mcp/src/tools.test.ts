import { describe, expect, test } from "bun:test"
import type { Session, WorkspaceRole } from "@yourcrm/auth"
import { PermissionDeniedError } from "@yourcrm/permissions"
import { MCP_UNAUTHORIZED_MESSAGE, type McpSession } from "./auth"
import { createDevMcpRuntime, DEV_WORKSPACE_ID } from "./dev-runtime"
import { createMcpToolset, type McpJsonSchema } from "./tools"

/**
 * The properties that make an MCP server safe to point at a CRM.
 *
 * Read `tools.ts` first: each test below names the property it pins.
 */

function sessionFor(actorId: string, role: WorkspaceRole): Session {
  return {
    user: { id: actorId, email: `${actorId}@yourcrm.test` },
    memberships: [{ workspaceId: DEV_WORKSPACE_ID, role }],
    workspaceId: DEV_WORKSPACE_ID,
  }
}

function callerFor(actorId: string, role: WorkspaceRole): McpSession {
  return { session: sessionFor(actorId, role), correlationId: `corr_${actorId}`, clientId: "probe" }
}

const ANONYMOUS: McpSession = { session: null, correlationId: "corr_anon", clientId: "probe" }

function setup() {
  const dev = createDevMcpRuntime()
  return { dev, toolset: createMcpToolset(dev.runtime) }
}

type QueryResult = {
  objectType: string
  scope: string
  rows: Record<string, unknown>[]
  rowCount: number
}

type SearchResult = { data: { recordId: string }[] }

describe("mcp/catalogue", () => {
  test("the P0 catalogue covers records, search and governed writes", () => {
    const { toolset } = setup()
    expect(toolset.tools.map((tool) => tool.name)).toEqual([
      "yourcrm_ping",
      "yourcrm_describe_objects",
      "yourcrm_query_records",
      "yourcrm_list_people",
      "yourcrm_list_companies",
      "yourcrm_list_deals",
      "yourcrm_list_tasks",
      "yourcrm_list_activities",
      "yourcrm_search",
      "yourcrm_propose_create_record",
      "yourcrm_propose_update_record",
      "yourcrm_propose_create_task",
    ])
  })

  /**
   * REGRESSION (ai-core hit this live): a gateway rejected a tool schema
   * whose `required` was missing with `null is not of type "array"`. The
   * MCP SDK's zod-to-JSON-Schema conversion drops `required` when nothing
   * is required, which is why `index.ts` emits these objects verbatim.
   */
  test("every tool schema is a complete JSON Schema, parameter-less ones included", () => {
    const { toolset } = setup()
    for (const tool of toolset.tools) {
      const schema: McpJsonSchema = tool.inputSchema
      expect(schema.type, tool.name).toBe("object")
      expect(typeof schema.properties, tool.name).toBe("object")
      expect(Array.isArray(schema.required), tool.name).toBe(true)
      expect(schema.additionalProperties, tool.name).toBe(false)
      expect(tool.description.length, tool.name).toBeGreaterThan(20)
    }
    const ping = toolset.get("yourcrm_ping")
    expect(ping?.inputSchema.properties).toEqual({})
    expect(ping?.inputSchema.required).toEqual([])
    expect(toolset.get("yourcrm_describe_objects")?.inputSchema.required).toEqual([])
  })

  test("read tools reuse the assistant's query schema rather than a new one", () => {
    const { toolset } = setup()
    // `objectType` required on the general tool, fixed (and therefore
    // absent) on the per-object list tools.
    expect(toolset.get("yourcrm_query_records")?.inputSchema.required).toContain("objectType")
    expect(toolset.get("yourcrm_list_deals")?.inputSchema.required).not.toContain("objectType")
    expect(toolset.get("yourcrm_list_deals")?.inputSchema.properties).not.toHaveProperty(
      "objectType",
    )
    // ...but everything else the assistant offers is still there.
    expect(toolset.get("yourcrm_list_deals")?.inputSchema.properties).toHaveProperty("filters")
  })
})

describe("mcp/permission-inheritance", () => {
  /**
   * PROPERTY 1 — no permission bypass. The same tool, the same arguments,
   * two callers: the viewer's answer is a strict subset of the admin's,
   * and the result says so (`scope: own`). This is `resolveReportRowScope`
   * doing its job through MCP exactly as it does through the API.
   */
  test("a viewer sees through MCP exactly what a viewer sees in the API", async () => {
    const { toolset } = setup()
    const asAdmin = (await toolset.call("yourcrm_list_deals", {}, callerFor("user_admin", "admin")))
      .result as QueryResult
    const asViewer = (
      await toolset.call("yourcrm_list_deals", {}, callerFor("user_viewer", "viewer"))
    ).result as QueryResult

    expect(asAdmin.scope).toBe("workspace")
    expect(asAdmin.rows.map((row) => row.id)).toEqual(["deal_1", "deal_2", "deal_3"])
    expect(asViewer.scope).toBe("own")
    expect(asViewer.rows.map((row) => row.id)).toEqual(["deal_3"])
    // A strict subset, not a differently-worded answer.
    for (const id of asViewer.rows.map((row) => row.id)) {
      expect(asAdmin.rows.map((row) => row.id)).toContain(id)
    }
  })

  test("aggregates are scoped too — a member cannot count the workspace", async () => {
    const { toolset } = setup()
    const args = { objectType: "deal", aggregations: [{ fn: "count", label: "deals" }] }
    const asOwner = (
      await toolset.call("yourcrm_query_records", args, callerFor("user_dev", "owner"))
    ).result as QueryResult
    const asMember = (
      await toolset.call("yourcrm_query_records", args, callerFor("user_member", "member"))
    ).result as QueryResult
    expect(asOwner.scope).toBe("workspace")
    expect(asOwner.rows[0]).toEqual({ deals: 3 })
    expect(asMember.scope).toBe("own")
    expect(asMember.rows[0]).toEqual({ deals: 1 })
  })

  test("search hides a private record from the member who does not own it", async () => {
    const { toolset } = setup()
    const args = { query: "Harbour" }
    const asAdmin = (await toolset.call("yourcrm_search", args, callerFor("user_admin", "admin")))
      .result as SearchResult
    const asMember = (
      await toolset.call("yourcrm_search", args, callerFor("user_member", "member"))
    ).result as SearchResult
    expect(asAdmin.data.map((hit) => hit.recordId)).toContain("deal_2")
    expect(asMember.data.map((hit) => hit.recordId)).not.toContain("deal_2")
    expect(asMember.data.map((hit) => hit.recordId)).toContain("com_2")
  })

  test("a viewer may not propose a change — `run_ai` is a member-and-up act", async () => {
    const { dev, toolset } = setup()
    await expect(
      toolset.call(
        "yourcrm_propose_create_task",
        { title: "Call them back", rationale: "they asked" },
        callerFor("user_viewer", "viewer"),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(dev.requests).toHaveLength(0)
  })

  test("identity comes from the session: arguments cannot widen the scope", async () => {
    const { toolset } = setup()
    const result = (
      await toolset.call(
        "yourcrm_list_deals",
        // A hopeful client trying to pass itself off as somebody else.
        { workspaceId: "ws_other", actorId: "user_admin", role: "owner", scope: "workspace" },
        callerFor("user_viewer", "viewer"),
      )
    ).result as QueryResult
    expect(result.scope).toBe("own")
    expect(result.rows.map((row) => row.id)).toEqual(["deal_3"])
  })
})

describe("mcp/unauthenticated", () => {
  /**
   * PROPERTY 4 — an unauthenticated client gets nothing, and learns
   * nothing. The refusal is resolved before the tool name is even looked
   * up, so it cannot be used as an oracle for what exists.
   */
  test("every tool refuses an anonymous caller with one constant message", async () => {
    const { toolset } = setup()
    for (const tool of toolset.tools) {
      const error = await toolset
        .call(tool.name, {}, ANONYMOUS)
        .then(() => null)
        .catch((err: unknown) => err)
      expect(error, tool.name).toBeInstanceOf(Error)
      expect((error as Error).message, tool.name).toBe(MCP_UNAUTHORIZED_MESSAGE)
    }
  })

  test("the refusal says nothing about whether the record — or the tool — exists", async () => {
    const { toolset } = setup()
    const messages = await Promise.all(
      [
        // a record that exists
        ["yourcrm_propose_update_record", { objectType: "deal", recordId: "deal_1" }],
        // one that does not
        ["yourcrm_propose_update_record", { objectType: "deal", recordId: "deal_does_not_exist" }],
        // a tool that does not exist either
        ["yourcrm_drop_everything", {}],
      ].map(async ([name, args]) =>
        toolset
          .call(name as string, args as Record<string, unknown>, ANONYMOUS)
          .then(() => "resolved")
          .catch((err: unknown) => (err as Error).message),
      ),
    )
    expect(new Set(messages).size).toBe(1)
    expect(messages[0]).toBe(MCP_UNAUTHORIZED_MESSAGE)
    for (const message of messages) {
      expect(message).not.toContain("deal_1")
      expect(message).not.toContain("yourcrm_drop_everything")
    }
  })

  test("an authenticated caller with no active workspace is anonymous", async () => {
    const { toolset } = setup()
    const caller: McpSession = {
      session: { user: { id: "user_dev", email: "d@x.test" }, memberships: [] },
      correlationId: "c",
      clientId: "probe",
    }
    await expect(toolset.call("yourcrm_ping", {}, caller)).rejects.toThrow(MCP_UNAUTHORIZED_MESSAGE)
  })
})

describe("mcp/audit", () => {
  test("a successful call is audited with caller, tool, arguments and outcome", async () => {
    const { dev, toolset } = setup()
    await toolset.call("yourcrm_list_tasks", { limit: 5 }, callerFor("user_member", "member"))
    const row = dev.auditLog.find((entry) => entry.action === "tool_call")
    expect(row).toBeDefined()
    expect(row?.workspaceId).toBe(DEV_WORKSPACE_ID)
    expect(row?.actorId).toBe("user_member")
    expect(row?.object).toBe("mcp_tool")
    expect(row?.recordId).toBe("yourcrm_list_tasks")
    expect(row?.source).toBe("mcp")
    expect(row?.correlationId).toBe("corr_user_member")
    expect(row?.after).toMatchObject({
      tool: "yourcrm_list_tasks",
      role: "member",
      clientId: "probe",
      arguments: { limit: 5 },
      outcome: "succeeded",
    })
  })

  test("a denied call is audited too — a refusal is an outcome", async () => {
    const { dev, toolset } = setup()
    await toolset
      .call(
        "yourcrm_propose_create_task",
        { title: "x", rationale: "y" },
        callerFor("u_v", "viewer"),
      )
      .catch(() => null)
    const row = dev.auditLog.find((entry) => entry.action === "tool_call")
    expect(row?.after).toMatchObject({ outcome: "denied", errorCode: "FORBIDDEN" })
  })

  test("an unauthenticated call writes no audit row — there is no workspace to write it to", async () => {
    const { dev, toolset } = setup()
    await toolset.call("yourcrm_ping", {}, ANONYMOUS).catch(() => null)
    expect(dev.auditLog).toHaveLength(0)
  })
})

describe("mcp/tools", () => {
  test("ping reports the caller back, so a client can see who it is", async () => {
    const { toolset } = setup()
    const outcome = await toolset.call("yourcrm_ping", {}, callerFor("user_member", "member"))
    expect(outcome.result).toEqual({
      pong: true,
      workspaceId: DEV_WORKSPACE_ID,
      actorId: "user_member",
      role: "member",
    })
  })

  test("describe_objects lists the queryable catalogue", async () => {
    const { toolset } = setup()
    const outcome = await toolset.call(
      "yourcrm_describe_objects",
      {},
      callerFor("user_member", "member"),
    )
    const result = outcome.result as { objects: { objectType: string }[] }
    expect(result.objects.map((entry) => entry.objectType)).toEqual([
      "person",
      "company",
      "deal",
      "task",
      "activity",
    ])
  })

  test("an unknown tool is a NOT_FOUND for an authenticated caller", async () => {
    const { toolset } = setup()
    await expect(toolset.call("yourcrm_nope", {}, callerFor("user_dev", "owner"))).rejects.toThrow(
      "unknown tool",
    )
  })
})
