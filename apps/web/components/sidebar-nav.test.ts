import { describe, expect, test } from "bun:test"
import {
  formatNavCount,
  isActiveRoute,
  navItemAriaLabel,
  railSections,
  resolvePanelSection,
  sectionForPath,
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

  test("every section's rail icon is a real route, so no glyph falls back blank", () => {
    const known = new Set(ALL_ROUTES.map((route) => route.href))
    for (const section of NAV_SECTIONS) {
      expect(known.has(section.icon)).toBe(true)
    }
  })
})

describe("sidebar/sectionForPath", () => {
  test("finds the section holding the route", () => {
    expect(sectionForPath("/app/deals")?.id).toBe("sales")
    expect(sectionForPath("/app/whatsapp")?.id).toBe("inbox")
    expect(sectionForPath("/app/settings/onboarding")?.id).toBe("settings")
  })

  test("every nav route resolves to a section", () => {
    for (const route of ALL_ROUTES) {
      expect(sectionForPath(route.href)).not.toBe(null)
    }
  })

  test("a record detail page stays in its parent's section", () => {
    // /app/people/abc-123 is not itself a nav entry, so it lights "People"
    // and the panel keeps showing Customers instead of jumping away while
    // the user drills into a record.
    expect(sectionForPath("/app/people/abc-123")?.id).toBe("customers")
    expect(sectionForPath("/app/deals/xyz/edit")?.id).toBe("sales")
  })

  test("a route outside the nav resolves to null rather than guessing", () => {
    expect(sectionForPath("/app/nowhere")).toBe(null)
  })
})

describe("sidebar/resolvePanelSection", () => {
  test("the route wins when nothing was picked", () => {
    expect(resolvePanelSection("/app/invoices", null).id).toBe("sales")
  })

  test("a rail pick wins, so a section can be browsed from elsewhere", () => {
    expect(resolvePanelSection("/app/deals", "insights").id).toBe("insights")
  })

  test("an unknown pick falls back to the route instead of going blank", () => {
    expect(resolvePanelSection("/app/deals", "not-a-section").id).toBe("sales")
  })

  test("a route outside the nav with no pick shows the first section", () => {
    // Never blank: an unrecognised route still needs a usable panel.
    const first = NAV_SECTIONS[0]
    if (first === undefined) throw new Error("NAV_SECTIONS is empty")
    expect(resolvePanelSection("/app/nowhere", null).id).toBe(first.id)
  })
})

describe("sidebar/railSections", () => {
  test("splits the rail into its main run and pinned tail", () => {
    const { top, bottom } = railSections()
    expect(top.length + bottom.length).toBe(NAV_SECTIONS.length)
    expect(bottom.map((section) => section.id)).toEqual(["support", "settings"])
    expect(top.every((section) => section.placement !== "bottom")).toBe(true)
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
})
