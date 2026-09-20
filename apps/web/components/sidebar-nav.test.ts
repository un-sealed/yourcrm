import { describe, expect, test } from "bun:test"
import {
  formatNavCount,
  isActiveRoute,
  navItemAriaLabel,
  sectionHasActive,
} from "./sidebar-nav"
import { ALL_ROUTES, NAV_SECTIONS } from "./nav-sections"

describe("sidebar/isActiveRoute", () => {
  test("an exact match is current", () => {
    expect(isActiveRoute("/app/deals", "/app/deals")).toBe(true)
    expect(isActiveRoute("/app/deals", "/app/people")).toBe(false)
  })

  test("a nested route lights its parent", () => {
    expect(isActiveRoute("/app/settings/notifications", "/app/settings")).toBe(true)
  })

  test("a nested route that is itself an entry does not also light its parent", () => {
    // Both "/app/settings" and "/app/settings/onboarding" are nav entries.
    // Lighting both would show the user two current items at once.
    expect(isActiveRoute("/app/settings/onboarding", "/app/settings")).toBe(false)
    expect(isActiveRoute("/app/settings/onboarding", "/app/settings/onboarding")).toBe(true)
  })

  test("dashboard only ever matches exactly", () => {
    expect(isActiveRoute("/app/dashboard/anything", "/app/dashboard")).toBe(false)
    expect(isActiveRoute("/app/dashboard", "/app/dashboard")).toBe(true)
  })

  test("a partial path segment is not a prefix match", () => {
    // "/app/deals-archive" must not light "/app/deals".
    expect(isActiveRoute("/app/deals-archive", "/app/deals")).toBe(false)
  })
})

describe("nav-sections", () => {
  test("every section fits a panel without scrolling", () => {
    // The whole point of the rail+panel split. If a section grows past this,
    // it wants splitting rather than a scrollbar.
    for (const section of NAV_SECTIONS) {
      expect(section.items.length).toBeLessThanOrEqual(6)
      expect(section.items.length).toBeGreaterThan(0)
    }
  })

  test("section ids are unique and every route appears exactly once", () => {
    const ids = NAV_SECTIONS.map((section) => section.id)
    expect(new Set(ids).size).toBe(ids.length)
    const hrefs = ALL_ROUTES.map((route) => route.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

})




describe("sidebar/sectionHasActive", () => {
  test("reports only the group holding the current route", () => {
    const matches = NAV_SECTIONS.filter((section) => sectionHasActive("/app/deals", section))
    expect(matches.map((section) => section.id)).toEqual(["sales"])
  })

  test("an unknown route lights no section", () => {
    for (const section of NAV_SECTIONS) {
      expect(sectionHasActive("/app/nowhere", section)).toBe(false)
    }
  })
})

describe("sidebar/formatNavCount", () => {
  test("renders no badge for absent, zero or nonsense counts", () => {
    expect(formatNavCount(undefined)).toBeUndefined()
    expect(formatNavCount(0)).toBeUndefined()
    expect(formatNavCount(-3)).toBeUndefined()
    expect(formatNavCount(Number.NaN)).toBeUndefined()
  })

  test("abbreviates past three digits so the label keeps its room", () => {
    expect(formatNavCount(7)).toBe("7")
    expect(formatNavCount(999)).toBe("999")
    expect(formatNavCount(1000)).toBe("1k")
    expect(formatNavCount(1200)).toBe("1.2k")
    expect(formatNavCount(12_000)).toBe("9k+")
  })
})

describe("sidebar/navItemAriaLabel", () => {
  test("folds the count into the label so a badge is not colour-only", () => {
    expect(navItemAriaLabel({ href: "/app/inbox", label: "Inbox", count: 12 })).toBe("Inbox, 12")
    expect(navItemAriaLabel({ href: "/app/inbox", label: "Inbox" })).toBe("Inbox")
  })

  test("folds the group in too, for the rail where headings are not rendered", () => {
    // Collapsed, "Search" alone does not say which part of the product it
    // belongs to, because the visible heading is gone.
    expect(navItemAriaLabel({ href: "/app/search", label: "Search" }, "Insights")).toBe(
      "Search, Insights",
    )
    expect(navItemAriaLabel({ href: "/app/inbox", label: "Inbox", count: 3 }, "Inbox")).toBe(
      "Inbox, Inbox, 3",
    )
  })
})
