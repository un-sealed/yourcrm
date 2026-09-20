"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@yourcrm/ui"
import { NAV_SECTIONS, type NavItem } from "./nav-sections"
import { NavIcon } from "./nav-icons"
import { SidebarUser } from "./sidebar-user"
import { formatNavCount, isActiveRoute, navItemAriaLabel } from "./sidebar-nav"

/**
 * Primary navigation, built as a dark slab.
 *
 * The three previous attempts all failed the same way, and it was a
 * material problem rather than a layout one: each was neutral-on-neutral —
 * a grey list on a near-white surface, where the active row could only
 * differ from its neighbours by a few percent of lightness. There is no
 * arrangement of that palette that reads as anything but flat, because the
 * whole column occupies one narrow band of the tonal range.
 *
 * So the navigation stops being a surface and becomes its own material: a
 * dark slab, constant in both themes, flush to the window edge. This is the
 * dominant pattern in the tools this product is measured against (Linear,
 * Vercel, Supabase, and the Spline dashboard supplied as a reference), and
 * it buys three things the light versions could not:
 *
 *   - Tonal room. Idle / hover / active can be three genuinely separate
 *     steps (#12151c → #1b2029 → #232936) instead of three shades of white.
 *   - A saturated accent. `--nav-brand` on a dark ground reads as colour;
 *     the same accent on white reads as a slightly blue grey.
 *   - A content area that pops, because the chrome now visibly recedes.
 *
 * It also restores the ONE gradient the spec reserves (§2) for the upgrade
 * card, which was dropped when it out-shouted a light sidebar's active row.
 * On a dark slab it is the brightest thing by design, which is the point.
 *
 * Collapsing narrows the same slab to an icon rail rather than removing it,
 * so navigation never costs you the whole sidebar. Group headings drop on
 * the rail — there is no room — and fold into each entry's aria-label so
 * the grouping survives for screen readers.
 */

const PANEL_WIDTH = "w-64"
const RAIL_WIDTH = "w-[68px]"

function PanelIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
    </svg>
  )
}

function SparkIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 3l2.4 5.3 5.6.6-4.2 3.9 1.2 5.6L12 15.8 7 18.4l1.2-5.6L4 8.9l5.6-.6z" />
    </svg>
  )
}

function Row({
  item,
  active,
  expanded,
  groupLabel,
}: {
  item: NavItem
  active: boolean
  expanded: boolean
  groupLabel: string
}) {
  const badge = formatNavCount(item.count)
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={navItemAriaLabel(item, expanded ? undefined : groupLabel)}
      title={expanded ? undefined : item.label}
      className={cn(
        "group relative flex h-9 items-center rounded-ctl text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand",
        expanded ? "gap-3 px-3" : "justify-center px-0",
        active
          ? // The inset top highlight is what keeps this from reading as a
            // flat patch: on a dark ground a 1px lighter edge is how a raised
            // surface is drawn, where in light mode the same job needs a
            // drop shadow that the slab would swallow.
            "bg-nav-active font-medium text-nav-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.07)]"
          : "text-nav-ink-2 hover:bg-nav-hover hover:text-nav-ink",
      )}
    >
      {active && expanded ? (
        // Inside the row, not outside it: an earlier version hung the bar off
        // the left edge and the rail clipped it against the viewport.
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-nav-brand"
        />
      ) : null}
      <NavIcon
        href={item.href}
        className={cn(
          "h-[18px] w-[18px] shrink-0 transition-colors",
          active ? "text-nav-brand" : "text-nav-ink-muted group-hover:text-nav-ink-2",
        )}
      />
      {expanded ? (
        <>
          <span className="truncate">{item.label}</span>
          {badge === undefined ? null : (
            <span
              aria-hidden="true"
              className="ml-auto shrink-0 rounded-pill bg-nav-hover px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-nav-ink-2"
            >
              {badge}
            </span>
          )}
        </>
      ) : badge === undefined ? null : (
        // No room for a number on the rail, so the badge degrades to a dot.
        // The count still reaches a screen reader through aria-label.
        <span
          aria-hidden="true"
          className="absolute right-2.5 top-2 h-1.5 w-1.5 rounded-full bg-nav-brand"
        />
      )}
    </Link>
  )
}

export function Sidebar({
  expanded,
  onToggle,
  workspaceLabel,
}: {
  expanded: boolean
  onToggle: () => void
  workspaceLabel: string
}) {
  const pathname = usePathname()

  return (
    <aside
      // `colorScheme: dark` is not decoration: the nav list scrolls, and
      // without it the browser paints a light native scrollbar down the
      // middle of a dark slab whenever the app is in light mode.
      style={{ colorScheme: "dark" }}
      className={cn(
        "hidden shrink-0 flex-col border-r border-nav-border bg-nav md:flex",
        expanded ? PANEL_WIDTH : RAIL_WIDTH,
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-nav-border",
          expanded ? "gap-2.5 px-3" : "justify-center px-0",
        )}
      >
        <Link
          href="/app/dashboard"
          aria-label={`${workspaceLabel} home`}
          title={expanded ? undefined : workspaceLabel}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl bg-gradient-to-br from-brand to-brand-deep text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
        >
          {workspaceLabel.charAt(0).toUpperCase()}
        </Link>
        {expanded ? (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-nav-ink">{workspaceLabel}</p>
              <p className="truncate text-[11px] text-nav-ink-muted">Workspace</p>
            </div>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-nav-ink-muted transition-colors hover:bg-nav-hover hover:text-nav-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
            >
              <PanelIcon className="h-4 w-4" />
            </button>
          </>
        ) : null}
      </div>

      {!expanded ? (
        <div className="flex shrink-0 justify-center pt-2">
          <button
            type="button"
            onClick={onToggle}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="flex h-8 w-8 items-center justify-center rounded-ctl text-nav-ink-muted transition-colors hover:bg-nav-hover hover:text-nav-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
          >
            <PanelIcon className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <nav
        aria-label="Primary"
        className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2 [scrollbar-color:var(--nav-border)_transparent] [scrollbar-width:thin]"
      >
        {NAV_SECTIONS.map((section) => (
          <div
            key={section.id}
            className={cn(
              expanded
                ? "mb-1 last:mb-0"
                : // The rail has no headings, so a hairline keeps the grouping
                  // visible instead of one undifferentiated run of icons.
                  "mb-2 border-b border-nav-border pb-2 last:mb-0 last:border-0 last:pb-0",
            )}
          >
            {expanded ? (
              // Uppercase micro-labels would shout on a white sidebar; on the
              // slab they sit far enough below the item ink to read as chrome.
              <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.09em] text-nav-ink-muted">
                {section.label}
              </p>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => (
                <li key={item.href}>
                  <Row
                    item={item}
                    active={isActiveRoute(pathname, item.href)}
                    expanded={expanded}
                    groupLabel={section.label}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className={cn("shrink-0", expanded ? "px-2.5 pb-2.5 pt-1" : "px-3 pb-2 pt-1")}>
        {expanded ? (
          <Link
            href="/app/settings"
            className="block rounded-card bg-gradient-to-br from-brand to-brand-deep p-3 transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-white">
              <SparkIcon className="h-4 w-4 shrink-0" />
              Upgrade to Premium
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-white/75">
              Unlimited AI runs, custom objects and priority support.
            </p>
          </Link>
        ) : (
          <Link
            href="/app/settings"
            aria-label="Upgrade to Premium"
            title="Upgrade to Premium"
            className="flex h-10 w-10 items-center justify-center rounded-ctl bg-gradient-to-br from-brand to-brand-deep text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
          >
            <SparkIcon className="h-[18px] w-[18px]" />
          </Link>
        )}
      </div>

      <div className="shrink-0 border-t border-nav-border p-2">
        <SidebarUser expanded={expanded} />
      </div>
    </aside>
  )
}
