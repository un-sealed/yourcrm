import { describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { anonymousMcpSession, devMcpSession, MCP_UNAUTHORIZED_MESSAGE } from "./auth"
import { createDevMcpRuntime } from "./dev-runtime"
import { createMcpServer, defaultMcpRuntime, defaultMcpSessionResolver } from "./index"
import { createUnconfiguredMcpRuntime } from "./runtime"

/**
 * The protocol surface, exercised by a REAL MCP client over a linked
 * transport pair. `tools/list` and `tools/call` here are the same requests
 * Claude Desktop sends over stdio — a catalogue that has only ever been
 * read from an array is not a catalogue anyone has listed.
 */

type ToolSchema = {
  type: string
  properties: Record<string, unknown>
  required?: unknown
  additionalProperties?: unknown
}

async function connect(deps: Parameters<typeof createMcpServer>[0]): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer(deps)
  const client = new Client({ name: "test-client", version: "1.0.0" })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

function textOf(result: Record<string, unknown>): string {
  const content = result.content
  if (!Array.isArray(content)) return ""
  const first: unknown = content[0]
  if (typeof first === "object" && first !== null && "text" in first) {
    const text = (first as { text: unknown }).text
    return typeof text === "string" ? text : ""
  }
  return ""
}

describe("mcp/protocol", () => {
  test("tools/list emits complete JSON Schema, `required` array included", async () => {
    const client = await connect({
      runtime: createDevMcpRuntime().runtime,
      resolveCaller: () => devMcpSession(),
    })
    const listed = await client.listTools()
    expect(listed.tools).toHaveLength(12)
    for (const tool of listed.tools) {
      const schema = tool.inputSchema as unknown as ToolSchema
      expect(schema.type, tool.name).toBe("object")
      expect(Array.isArray(schema.required), tool.name).toBe(true)
      expect(schema.additionalProperties, tool.name).toBe(false)
    }
    // THE regression: a parameter-less tool still ships `required: []`.
    const ping = listed.tools.find((tool) => tool.name === "yourcrm_ping")
    expect((ping?.inputSchema as unknown as ToolSchema).required).toEqual([])
    await client.close()
  })

  test("tools/call reaches a domain service and returns its JSON", async () => {
    const client = await connect({
      runtime: createDevMcpRuntime().runtime,
      resolveCaller: () => devMcpSession(),
    })
    const result = await client.callTool({
      name: "yourcrm_list_deals",
      arguments: { columns: ["name", "stage"], limit: 2 },
    })
    const payload = JSON.parse(textOf(result)) as { scope: string; rows: unknown[] }
    expect(payload.scope).toBe("workspace")
    expect(payload.rows).toHaveLength(2)
    await client.close()
  })

  /**
   * A tool failure is a RESULT, not a protocol error, so the model can
   * read it — but it still carries nothing an anonymous caller could use.
   */
  test("an anonymous client gets an isError result and no information", async () => {
    const client = await connect({
      runtime: createDevMcpRuntime().runtime,
      resolveCaller: () => anonymousMcpSession(),
    })
    const result = await client.callTool({
      name: "yourcrm_propose_update_record",
      arguments: { objectType: "deal", recordId: "deal_1" },
    })
    expect(result.isError).toBe(true)
    const payload = JSON.parse(textOf(result)) as { error: { code: string; message: string } }
    expect(payload.error).toEqual({ code: "UNAUTHORIZED", message: MCP_UNAUTHORIZED_MESSAGE })
    // The catalogue is still public — it describes capabilities, not data.
    expect((await client.listTools()).tools).toHaveLength(12)
    await client.close()
  })

  test("a server with no CRM wired lists tools and refuses every call", async () => {
    const client = await connect({
      runtime: createUnconfiguredMcpRuntime(),
      resolveCaller: () => devMcpSession(),
    })
    expect((await client.listTools()).tools).toHaveLength(12)
    const result = await client.callTool({ name: "yourcrm_describe_objects", arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("MCP_RUNTIME_NOT_CONFIGURED")
    await client.close()
  })

  test("production defaults are closed: no CRM, no caller", async () => {
    const runtime = defaultMcpRuntime("production")
    expect(() => runtime.reports.describeObjects()).toThrow("no CRM runtime wired")
    const caller = await defaultMcpSessionResolver("production")()
    expect(caller.session).toBeNull()
    // ...and development is usable, which is the whole point of the split.
    expect((await defaultMcpSessionResolver("development")()).session).not.toBeNull()
  })
})
