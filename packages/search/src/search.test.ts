import { describe, expect, test } from "bun:test"
import { getSearchProvider } from "./search"

describe("search", () => {
  test("default provider returns empty hits", async () => {
    const res = await getSearchProvider().search({ workspaceId: "w", query: "acme", limit: 20 })
    expect(res.hits).toEqual([])
  })
})
