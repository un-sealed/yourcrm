"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@yourcrm/ui"
import { NAV_SECTIONS, type NavItem, type NavSection } from "./nav-sections"
import { NavIcon } from "./nav-icons"
import { SidebarUser } from "./sidebar-user"
import {
  defaultOpenGroups,
  formatNavCount,
  isActiveRoute,
  navItemAriaLabel,
  sectionHasActive,
} from "./sidebar-nav"

/**
 * Left navigation.
 *
 * Three things drive the shape, and each replaces something the previous
 * sidebar did worse:
 *
 *  1. **Collapsing gives you a 64px icon rail, not an empty gutter.** The
 *     old toggle unmounted the sidebar entirely and moved an "expand" button
 *     to the topbar, so collapsing cost you all navigation to buy some width.
 *  2. **Groups collapse.** There are 28 entries across three groups; being
 *     able to fold "Tools" is the difference between scanning and scrolling.
 *  3. **The footer is quiet.** A 130px brand-gradient upgrade card used to
 *     sit under the nav. It is now one row among the other utilities, so the
 *     loudest thing in the sidebar is the page you are on.
 *
 * The active entry wears a neutral `--surface-2` pill with a `--brand` icon
 * rather than a blue wash: with 28 entries a saturated fill is a lot of
 * colour, and tinting the icon marks position just as clearly. `aria-current`
 * carries it for anyone not reading the colour.
 */

const RAIL_WIDTH = "w-16"
const PANEL_WIDTH = "w-[264px]"

function Chevron({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

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

function Badge({ text }: { text: string }) {
  return (
    <span
      aria-hidden="true"
      className="ml-auto shrink-0 rounded-pill bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-secondary group-aria-[current=page]:bg-surface-1"
    >
      {text}
    </span>
  )
}

function NavRow({
  item,
  active,
  expanded,
}: {
  item: NavItem
  active: boolean
  expanded: boolean
}) {
  const badge = formatNavCount(item.count)
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={expanded ? undefined : navItemAriaLabel(item)}
      // The rail has no text, so the native tooltip is the only way to read
      // an entry without expanding.
      title={expanded ? undefined : item.label}
      className={cn(
        "group relative flex h-9 items-center rounded-ctl text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong",
        expanded ? "gap-3 px-2.5" : "justify-center px-0",
        active
          ? "bg-surface-2 font-medium text-ink-primary"
          : "text-ink-secondary hover:bg-surface-2/70 hover:text-ink-primary",
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
          {badge === undefined ? null : <Badge text={badge} />}
        </>
      ) : badge === undefined ? null : (
        // On the rail there is no room for a number, so the badge degrades to
        // a dot. The count still reaches a screen reader through aria-label.
        <span
          aria-hidden="true"
          className="absolute right-2.5 top-2 h-1.5 w-1.5 rounded-full bg-brand"
        />
      )}
    </Link>
  )
}

function Group({
  section,
  pathname,
  expanded,
  open,
  onToggle,
}: {
  section: NavSection
  pathname: string
  expanded: boolean
  open: boolean
  onToggle: () => void
}) {
  const hasActive = sectionHasActive(pathname, section)
  const items = section.items.map((item) => (
    <li key={item.href}>
      <NavRow item={item} active={isActiveRoute(pathname, item.href)} expanded={expanded} />
    </li>
  ))

  // The rail drops group chrome entirely — a label and a disclosure make no
  // sense at 64px — but keeps a hairline so the grouping is still legible.
  if (!expanded) {
    return (
      <div className="mb-2 border-b border-border pb-2 last:mb-0 last:border-0 last:pb-0">
        <ul className="flex flex-col gap-1">{items}</ul>
      </div>
    )
  }

  return (
    <div className="mb-3 last:mb-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 rounded-ctl px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted transition-colors hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
      >
        <span>{section.group}</span>
        {/* A folded group holding the current page still says so. */}
        {!open && hasActive ? (
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand" />
        ) : null}
        <Chevron
          className={cn("ml-auto h-3.5 w-3.5 transition-transform", open ? "" : "-rotate-90")}
        />
      </button>
      {open ? <ul className="mt-0.5 flex flex-col gap-0.5">{items}</ul> : null}
    </div>
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
  const [openGroups, setOpenGroups] = useState(() => defaultOpenGroups(NAV_SECTIONS))

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col border-r border-border bg-surface-1 transition-[width] duration-150 md:flex",
        expanded ? PANEL_WIDTH : RAIL_WIDTH,
      )}
    >
      <div
        className={cn(
          "flex h-14 shrink-0 items-center border-b border-border",
          expanded ? "gap-2 px-3" : "justify-center px-0",
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl bg-brand text-sm font-semibold text-white">
          {workspaceLabel.charAt(0).toUpperCase()}
        </span>
        {expanded ? (
          <>
            {/*
              A link to workspace settings, not a switcher. There is no
              multi-workspace API yet, so a switcher chevron here would be a
              control that cannot do anything.
            */}
            <Link
              href="/app/settings"
              className="min-w-0 flex-1 rounded-ctl px-1 py-1 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            >
              <span className="block truncate text-sm font-semibold text-ink-primary">
                {workspaceLabel}
              </span>
              <span className="block truncate text-[11px] text-ink-muted">Workspace settings</span>
            </Link>
            <button
              type="button"
              onClick={onToggle}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            >
              <PanelIcon className="h-4 w-4" />
            </button>
          </>
        ) : null}
      </div>

      {!expanded ? (
        <div className="flex shrink-0 justify-center border-b border-border py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="flex h-8 w-8 items-center justify-center rounded-ctl text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
          >
            <PanelIcon className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <nav
        aria-label="Primary"
        className="min-h-0 flex-1 overflow-y-auto px-2 py-3"
      >
        {NAV_SECTIONS.map((section) => (
          <Group
            key={section.group}
            section={section}
            pathname={pathname}
            expanded={expanded}
            open={openGroups[section.group] ?? true}
            onToggle={() =>
              setOpenGroups((current) => ({
                ...current,
                [section.group]: !(current[section.group] ?? true),
              }))
            }
          />
        ))}
      </nav>

      {/*
        Utilities. The upgrade prompt is one row here rather than the 130px
        brand-gradient card that used to anchor the sidebar.
        
        It is deliberately NOT a filled brand surface either: rendered solid,
        a full-width blue bar pinned above the fold out-shouted the active
        nav item, so the most prominent thing in the sidebar was an advert
        rather than the page you are on. Brand ink on `--brand-soft` still
        reads as the one promotional element without winning that contest.
        This drops the last use of the gradient the design doc reserved for
        this card (DASHBOARD-REDESIGN.md §2).
      */}
      <div className="shrink-0 border-t border-border p-2">
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
    </aside>
  )
}
