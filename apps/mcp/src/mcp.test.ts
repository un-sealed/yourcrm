import { describe, expect, test } from "bun:test"
import { devContext } from "./auth"
import { getTool, tools } from "./tools"

describe("mcp", () => {
  test("tool registry exposes the ping tool", () => {
    expect(tools.map((t) => t.name)).toContain("yourcrm_ping")
  })

  test("ping tool authorizes a session and echoes", async () => {
    const tool = getTool("yourcrm_ping")!
    const result = (await tool.handler({ message: "hello" }, devContext())) as { pong: boolean }
    expect(result.pong).toBe(true)
  })

  test("ping tool rejects anonymous callers", async () => {
    const tool = getTool("yourcrm_ping")!
    await expect(
      tool.handler({ message: "hi" }, { session: null, correlationId: "c" }),
    ).rejects.toThrow()
  })
})
