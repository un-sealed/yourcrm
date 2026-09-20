import { ALL_ROUTES, NAV_SECTIONS, type NavItem, type NavSection } from "./nav-sections"

/**
 * Pure navigation rules for the two-tier sidebar. Kept out of the component
 * so they are unit-testable without rendering React — the convention the
 * rest of `apps/web` follows (every test here is a `.test.ts` over pure
 * logic).
 */

/**
 * Is `href` the entry that should read as current for `pathname`?
 *
 * Nested routes highlight their parent (`/app/settings/notifications` lights
 * "Settings"), but never when another nav entry is itself the exact match —
 * `/app/settings/onboarding` is its own entry, so "Settings" must not also
 * light up and give the user two current items.
 */
export function isActiveRoute(pathname: string, href: string): boolean {
  if (pathname === href) return true
  // The dashboard is `/app/dashboard`, not a prefix of everything under
  // `/app`, so it only ever matches exactly.
  if (href === "/app/dashboard") return false
  if (!pathname.startsWith(`${href}/`)) return false
  return !ALL_ROUTES.some((route) => route.href === pathname)
}

/** Does any item in this section read as current? */
export function sectionHasActive(pathname: string, section: NavSection): boolean {
  return section.items.some((item) => isActiveRoute(pathname, item.href))
}

/**
 * Which section the current route lives in, or `null` for a route outside
 * the nav entirely (a record detail page, say). `null` matters: the panel
 * must not silently snap back to the first section and tell the user they
 * are somewhere they are not.
 */
export function sectionForPath(pathname: string): NavSection | null {
  return NAV_SECTIONS.find((section) => sectionHasActive(pathname, section)) ?? null
}

/**
 * The section the panel should show.
 *
 * The route wins by default, so navigating anywhere — a link, the command
 * palette, the back button — brings the panel with it. `override` is the
 * section the user picked on the rail, which lets them browse a section
 * they are not currently in; the caller clears it whenever the route
 * changes. Falls back to the first section only when the route is outside
 * the nav *and* nothing was picked, so the panel is never blank.
 */
export function resolvePanelSection(pathname: string, override: string | null): NavSection {
  if (override !== null) {
    const picked = NAV_SECTIONS.find((section) => section.id === override)
    if (picked !== undefined) return picked
  }
  const first = NAV_SECTIONS[0]
  if (first === undefined) throw new Error("NAV_SECTIONS is empty")
  return sectionForPath(pathname) ?? first
}

/** Rail sections in their two runs: the main list, and the pinned tail. */
export function railSections(): { top: NavSection[]; bottom: NavSection[] } {
  return {
    top: NAV_SECTIONS.filter((section) => section.placement !== "bottom"),
    bottom: NAV_SECTIONS.filter((section) => section.placement === "bottom"),
  }
}

/**
 * Badge text for a nav count. Four digits in a narrow panel push the label
 * into an ellipsis, so anything past 999 is abbreviated rather than
 * truncated. `undefined` for a missing or nonsensical count, so the caller
 * renders no badge at all rather than an empty pill.
 */
export function formatNavCount(count: number | undefined): string | undefined {
  if (count === undefined || !Number.isFinite(count) || count <= 0) return undefined
  if (count > 9999) return "9k+"
  if (count > 999) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return String(count)
}

/** Accessible label for a nav entry, including its count when it has one. */
export function navItemAriaLabel(item: NavItem): string {
  const badge = formatNavCount(item.count)
  return badge === undefined ? item.label : `${item.label}, ${badge}`
}
