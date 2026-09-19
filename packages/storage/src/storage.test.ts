import { describe, expect, test } from "bun:test"
import { StorageService } from "./storage"

describe("storage", () => {
  test("healthcheck presigns without network", async () => {
    const svc = new StorageService({
      endpoint: "http://localhost:9000",
      region: "us-east-1",
      bucket: "yourcrm",
      accessKey: "minioadmin",
      secretKey: "minioadmin",
      forcePathStyle: true,
    })
    const health = await svc.healthcheck()
    expect(health.ok).toBe(true)
    expect(health.bucket).toBe("yourcrm")
  })
})
