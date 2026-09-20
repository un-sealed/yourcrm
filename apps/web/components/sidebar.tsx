"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@yourcrm/ui"
import { NAV_SECTIONS, type NavItem } from "./nav-sections"
import { NavIcon } from "./nav-icons"
import { SidebarUser } from "./sidebar-user"
import { formatNavCount, isActiveRoute, navItemAriaLabel } from "./sidebar-nav"

/**
 * One-column navigation, built as an inset card.
 *
 * The concept is an inversion of the usual arrangement. Normally a sidebar
 * is a white slab flush to the window edge and the current item is a grey
 * pill stamped into it — which makes the *selected* row the darkest thing
 * on a light surface, so position reads as a hole rather than a highlight.
 *
 * Here the sidebar is a tinted card (`--surface-2`) floating on the page
 * with a margin all round, and the current row is `--surface-1` with a soft
 * shadow, so it reads as a chip lifted off the card. Everything is one step
 * quieter than the row you are on, which is the whole job of a sidebar.
 *
 * Collapsing narrows the same card to a 64px icon rail rather than removing
 * it, so navigation never costs you the whole sidebar. Group headings drop
 * on the rail — there is no room for them — and fold into each entry's
 * aria-label so the grouping survives for screen readers.
 */

const PANEL_WIDTH = "w-[260px]"
const RAIL_WIDTH = "w-[80px]"

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
        "group relative flex h-9 items-center rounded-ctl text-sm transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong",
        expanded ? "gap-2.5 px-2.5" : "justify-center px-0",
        active
          ? // Lifted off the tinted card rather than stamped into it. The ring
            // does the work in dark mode, where --surface-1 sits *below*
            // --surface-2 and a drop shadow reads as nothing.
            "bg-surface-1 font-medium text-ink-primary shadow-card ring-1 ring-border/70"
          : "text-ink-secondary hover:bg-surface-1/60 hover:text-ink-primary",
      )}
    >
      <NavIcon
        href={item.href}
        className={cn(
          "h-[18px] w-[18px] shrink-0",
          active ? "text-brand" : "text-ink-muted group-hover:text-ink-primary",
        )}
      />
      {expanded ? (
        <>
          <span className="truncate">{item.label}</span>
          {badge === undefined ? null : (
            <span
              aria-hidden="true"
              className="ml-auto shrink-0 rounded-pill bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-secondary"
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
          className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-brand"
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
    // The margin is the design: it is what turns a slab into a card and lets
    // the page colour run behind it on all four sides.
    <div
      className={cn(
        "hidden shrink-0 p-3 md:flex",
        expanded ? PANEL_WIDTH : RAIL_WIDTH,
      )}
    >
      <div className="flex min-h-0 w-full flex-col rounded-card border border-border bg-surface-2">
        <div
          className={cn(
            "flex h-14 shrink-0 items-center",
            expanded ? "gap-2 px-3" : "justify-center px-0",
          )}
        >
          <Link
            href="/app/dashboard"
            aria-label={`${workspaceLabel} home`}
            title={expanded ? undefined : workspaceLabel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl bg-brand text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
          >
            {workspaceLabel.charAt(0).toUpperCase()}
          </Link>
          {expanded ? (
            <>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink-primary">
                {workspaceLabel}
              </span>
              <button
                type="button"
                onClick={onToggle}
                aria-label="Collapse sidebar"
                title="Collapse sidebar"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-ink-muted transition-colors hover:bg-surface-1 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
              >
                <PanelIcon className="h-4 w-4" />
              </button>
            </>
          ) : null}
        </div>

        {!expanded ? (
          <div className="flex shrink-0 justify-center pb-1">
            <button
              type="button"
              onClick={onToggle}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="flex h-8 w-8 items-center justify-center rounded-ctl text-ink-muted transition-colors hover:bg-surface-1 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            >
              <PanelIcon className="h-4 w-4" />
            </button>
          </div>
        ) : null}

        <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {NAV_SECTIONS.map((section) => (
            <div
              key={section.id}
              className={cn(
                expanded
                  ? "mb-2 last:mb-0"
                  : // The rail has no headings, so a hairline keeps the
                    // grouping visible instead of one undifferentiated run
                    // of twenty-eight icons.
                    "mb-2 border-b border-border pb-2 last:mb-0 last:border-0 last:pb-0",
              )}
            >
              {expanded ? (
                <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-ink-muted">
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

        <div className="shrink-0 px-2 pb-1">
          <Link
            href="/app/settings"
            title={expanded ? undefined : "Upgrade to Premium"}
            className={cn(
              "flex h-9 items-center rounded-ctl text-sm font-medium text-brand transition-colors hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong",
              expanded ? "gap-2.5 px-2.5" : "justify-center px-0",
            )}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="h-[18px] w-[18px] shrink-0"
            >
              <path d="M12 3l2.4 5.3 5.6.6-4.2 3.9 1.2 5.6L12 15.8 7 18.4l1.2-5.6L4 8.9l5.6-.6z" />
            </svg>
            {expanded ? <span className="truncate">Upgrade to Premium</span> : null}
          </Link>
        </div>

        <div className="shrink-0 border-t border-border p-2">
          <SidebarUser expanded={expanded} />
        </div>
      </div>
    </div>
  )
}
