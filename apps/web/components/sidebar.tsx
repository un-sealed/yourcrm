"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@yourcrm/ui"
import { type NavItem, type NavSection } from "./nav-sections"
import { NavIcon } from "./nav-icons"
import { SidebarUser } from "./sidebar-user"
import {
  formatNavCount,
  isActiveRoute,
  navItemAriaLabel,
  railSections,
  resolvePanelSection,
  sectionForPath,
} from "./sidebar-nav"

/**
 * Two-tier navigation: a 56px icon rail of sections, and a panel showing
 * only the selected section's items.
 *
 * The problem this solves is that 28 entries do not belong in one list. The
 * previous sidebar stacked all of them under three headings, so finding
 * "Quotes" meant scanning past sixteen unrelated entries under "Tools". Here
 * the rail carries eight sections and the panel never shows more than five
 * items, so there is nothing to scroll and nothing to scan past.
 *
 * Two rules keep the two tiers honest:
 *
 *  - **The route drives the panel.** Navigate anywhere — a link, the command
 *    palette, the back button — and the rail and panel follow. A record
 *    detail page counts as its parent, so drilling into a person keeps the
 *    panel on Customers.
 *  - **A rail click is a preview, not a navigation.** Clicking "Insights"
 *    shows that section without leaving the page you are on, and the pick is
 *    dropped as soon as the route actually changes. Rail entries are
 *    buttons, not links, because they do not go anywhere.
 */

const RAIL_WIDTH = "w-14"
const PANEL_WIDTH = "w-[216px]"

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

function RailButton({
  section,
  selected,
  current,
  onSelect,
}: {
  section: NavSection
  selected: boolean
  current: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={section.label}
      aria-label={section.label}
      aria-pressed={selected}
      className={cn(
        "flex h-10 w-10 items-center justify-center rounded-ctl transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong",
        selected
          ? "bg-surface-2 text-ink-primary"
          : "text-ink-muted hover:bg-surface-2/70 hover:text-ink-primary",
      )}
    >
      {/*
        Selected and current are different states and the rail has to show
        both: you can preview "Insights" while the page you are on lives in
        "Sales". The pill marks what the panel is showing, the brand tint
        marks where you actually are — the same pairing the panel rows use,
        so the two tiers read as one system.

        An earlier version put a brand bar against the rail's left edge, but
        a 40px button centred in a 56px rail leaves only 8px of gutter, so
        the bar sat half off-screen.
      */}
      <NavIcon
        href={section.icon}
        className={cn("h-[19px] w-[19px]", current ? "text-brand" : undefined)}
      />
    </button>
  )
}

function PanelRow({ item, active }: { item: NavItem; active: boolean }) {
  const badge = formatNavCount(item.count)
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      aria-label={navItemAriaLabel(item)}
      className={cn(
        "group flex h-9 items-center gap-2.5 rounded-ctl px-2.5 text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong",
        active
          ? "bg-surface-2 font-medium text-ink-primary"
          : "text-ink-secondary hover:bg-surface-2/70 hover:text-ink-primary",
      )}
    >
      <NavIcon
        href={item.href}
        className={cn(
          "h-[17px] w-[17px] shrink-0",
          active ? "text-brand" : "text-ink-muted group-hover:text-ink-primary",
        )}
      />
      <span className="truncate">{item.label}</span>
      {badge === undefined ? null : (
        <span
          aria-hidden="true"
          className="ml-auto shrink-0 rounded-pill bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-secondary"
        >
          {badge}
        </span>
      )}
    </Link>
  )
}

export function Sidebar({
  panelOpen,
  onTogglePanel,
  workspaceLabel,
}: {
  panelOpen: boolean
  onTogglePanel: () => void
  workspaceLabel: string
}) {
  const pathname = usePathname()
  const [pick, setPick] = useState<string | null>(null)

  // The route is the source of truth; a rail preview only lasts until the
  // user actually goes somewhere. Compared against a ref so this clears once
  // per navigation rather than fighting the user on every render.
  const lastPath = useRef(pathname)
  useEffect(() => {
    if (lastPath.current !== pathname) {
      lastPath.current = pathname
      setPick(null)
    }
  }, [pathname])

  const { top, bottom } = railSections()
  const panel = resolvePanelSection(pathname, pick)
  const currentSectionId = sectionForPath(pathname)?.id ?? null

  const railButton = (section: NavSection) => (
    <RailButton
      key={section.id}
      section={section}
      selected={section.id === panel.id}
      current={section.id === currentSectionId}
      onSelect={() => setPick(section.id)}
    />
  )

  return (
    <div className="hidden shrink-0 md:flex">
      <div
        className={cn(
          "flex flex-col items-center border-r border-border bg-surface-1 py-3",
          RAIL_WIDTH,
        )}
      >
        <Link
          href="/app/dashboard"
          aria-label={`${workspaceLabel} home`}
          title={workspaceLabel}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-ctl bg-brand text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
        >
          {workspaceLabel.charAt(0).toUpperCase()}
        </Link>

        <div className="mt-3 flex flex-col items-center gap-1">{top.map(railButton)}</div>

        <div className="mt-auto flex flex-col items-center gap-1 pt-3">{bottom.map(railButton)}</div>
      </div>

      {panelOpen ? (
        <div className={cn("flex flex-col border-r border-border bg-surface-1", PANEL_WIDTH)}>
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink-primary">{panel.label}</p>
              <p className="truncate text-[11px] text-ink-muted">{workspaceLabel}</p>
            </div>
            <button
              type="button"
              onClick={onTogglePanel}
              aria-label="Hide navigation panel"
              title="Hide navigation panel"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            >
              <PanelIcon className="h-4 w-4" />
            </button>
          </div>

          <nav aria-label="Primary" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            <ul className="flex flex-col gap-0.5">
              {panel.items.map((item) => (
                <li key={item.href}>
                  <PanelRow item={item} active={isActiveRoute(pathname, item.href)} />
                </li>
              ))}
            </ul>
          </nav>

          <div className="shrink-0 border-t border-border p-2">
            <Link
              href="/app/settings"
              className="flex h-9 items-center gap-2.5 rounded-ctl px-2.5 text-sm font-medium text-brand transition-colors hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="h-[17px] w-[17px] shrink-0"
              >
                <path d="M12 3l2.4 5.3 5.6.6-4.2 3.9 1.2 5.6L12 15.8 7 18.4l1.2-5.6L4 8.9l5.6-.6z" />
              </svg>
              <span className="truncate">Upgrade to Premium</span>
            </Link>
          </div>

          <div className="shrink-0 border-t border-border p-2">
            <SidebarUser expanded />
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Reveals the panel once it has been hidden. Lives in the topbar because the
 * 56px rail has no room for a labelled control, and burying the only way
 * back into a tooltip on a fifth icon would be worse.
 */
export function SidebarPanelToggle({ onToggle }: { onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label="Show navigation panel"
      title="Show navigation panel"
      className="hidden h-8 w-8 items-center justify-center rounded-ctl text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong md:inline-flex"
    >
      <PanelIcon className="h-4 w-4" />
    </button>
  )
}
