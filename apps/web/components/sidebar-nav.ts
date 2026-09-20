import { ALL_ROUTES, type NavItem, type NavSection } from "./nav-sections"

/**
 * Pure navigation rules for the sidebar. Kept out of the component so they
 * are unit-testable without rendering React — the convention the rest of
 * `apps/web` follows (every test here is a `.test.ts` over pure logic).
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

/** Does any item in this group read as current? */
export function sectionHasActive(pathname: string, section: NavSection): boolean {
  return section.items.some((item) => isActiveRoute(pathname, item.href))
}

/**
 * Badge text for a nav count. Four digits in a narrow sidebar push the label
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

/**
 * Accessible label for a nav entry.
 *
 * Folds in the count, because a badge is a visual affordance a screen reader
 * would otherwise read as a bare number floating after the label. Folds in
 * the group too when collapsed, since the rail shows no headings and
 * "Search" alone does not say which part of the product it belongs to.
 */
export function navItemAriaLabel(item: NavItem, groupLabel?: string): string {
  const parts = [item.label]
  if (groupLabel !== undefined) parts.push(groupLabel)
  const badge = formatNavCount(item.count)
  if (badge !== undefined) parts.push(badge)
  return parts.join(", ")
}
