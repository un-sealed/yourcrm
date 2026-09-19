import { describe, expect, test } from "bun:test"
import {
  flattenGroups,
  groupHits,
  hitOptionId,
  hrefForHit,
  nextActiveIndex,
  objectLabel,
  type SearchHit,
} from "./types"

function hit(
  overrides: Partial<SearchHit> & Pick<SearchHit, "objectType" | "recordId">,
): SearchHit {
  return {
    id: `${overrides.objectType}-${overrides.recordId}`,
    workspaceId: "ws_1",
    title: "Ada Lovelace",
    subtitle: null,
    snippet: null,
    rank: 1,
    ownerId: null,
    visibility: "workspace",
    recordUpdatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("search/grouping", () => {
  test("groups by object type in index order, keeping rank order inside a group", () => {
    const groups = groupHits([
      hit({ objectType: "deal", recordId: "d1", rank: 0.9 }),
      hit({ objectType: "person", recordId: "p1", rank: 0.8 }),
      hit({ objectType: "person", recordId: "p2", rank: 0.7 }),
    ])
    expect(groups.map((g) => g.objectType)).toEqual(["person", "deal"])
    expect(groups[0]?.label).toBe("People")
    expect(groups[0]?.hits.map((h) => h.recordId)).toEqual(["p1", "p2"])
  })

  test("unknown object types sort last and keep their raw label", () => {
    const groups = groupHits([
      hit({ objectType: "unicorn", recordId: "u1" }),
      hit({ objectType: "person", recordId: "p1" }),
    ])
    expect(groups.map((g) => g.objectType)).toEqual(["person", "unicorn"])
    expect(objectLabel("unicorn")).toBe("unicorn")
  })

  test("flattening walks the groups in render order", () => {
    const groups = groupHits([
      hit({ objectType: "deal", recordId: "d1" }),
      hit({ objectType: "person", recordId: "p1" }),
    ])
    expect(flattenGroups(groups).map((h) => h.recordId)).toEqual(["p1", "d1"])
  })

  test("empty results group to nothing", () => {
    expect(groupHits([])).toEqual([])
    expect(flattenGroups([])).toEqual([])
  })
})

describe("search/links", () => {
  test("known object types link to their record page", () => {
    expect(hrefForHit({ objectType: "person", recordId: "p1" })).toBe("/app/people/p1")
    expect(hrefForHit({ objectType: "invoice", recordId: "i1" })).toBe("/app/invoices/i1")
  })

  test("unrouted object types are not clickable", () => {
    expect(hrefForHit({ objectType: "unicorn", recordId: "u1" })).toBeNull()
  })

  test("option ids are stable and unique per record", () => {
    expect(hitOptionId({ objectType: "person", recordId: "p1" })).toBe("search-hit-person-p1")
  })
})

describe("search/keyboard", () => {
  test("moves down and up through the flat list", () => {
    expect(nextActiveIndex(0, 1, 3)).toBe(1)
    expect(nextActiveIndex(2, -1, 3)).toBe(1)
  })

  test("wraps at both ends", () => {
    expect(nextActiveIndex(2, 1, 3)).toBe(0)
    expect(nextActiveIndex(0, -1, 3)).toBe(2)
  })

  test("selects the first row on ArrowDown and the last on ArrowUp from nothing", () => {
    expect(nextActiveIndex(-1, 1, 3)).toBe(0)
    expect(nextActiveIndex(-1, -1, 3)).toBe(2)
  })

  test("stays unselected when there is nothing to select", () => {
    expect(nextActiveIndex(-1, 1, 0)).toBe(-1)
    expect(nextActiveIndex(0, 1, 0)).toBe(-1)
  })
})
