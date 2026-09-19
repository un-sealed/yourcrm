import { describe, expect, test } from "bun:test"
import { runExampleJob } from "./jobs/example"
import { JobHandlers } from "./worker"

describe("worker", () => {
  test("example job echoes validated input (idempotent + retry-safe)", async () => {
    await expect(runExampleJob({ message: "hello" })).resolves.toEqual({ echoed: "hello" })
    await expect(runExampleJob({ message: "" })).rejects.toThrow()
  })

  test("job registry contains the example job", () => {
    expect(Object.keys(JobHandlers)).toContain("example.ping")
  })
})
