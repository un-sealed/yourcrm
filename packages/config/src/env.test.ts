import { describe, expect, test } from "bun:test"
import { __resetEnvCache, loadEnv } from "./env"

describe("config/env", () => {
  test("loads defaults for local development", () => {
    __resetEnvCache()
    const env = loadEnv({} as Record<string, string | undefined>)
    expect(env.API_PORT).toBe(4000)
    expect(env.STORAGE_BUCKET).toBe("yourcrm")
  })

  test("rejects a short SESSION_SECRET", () => {
    __resetEnvCache()
    expect(() => loadEnv({ SESSION_SECRET: "short" })).toThrow()
    __resetEnvCache()
  })
})
