"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@yourcrm/ui"
import { NAV_SECTIONS, type NavItem } from "./nav-sections"
import { NavIcon } from "./nav-icons"
import { SidebarUser } from "./sidebar-user"
import { formatNavCount, isActiveRoute, navItemAriaLabel } from "./sidebar-nav"

/**
 * Primary navigation, built after the celoxis-style reference: a warm,
 * floating panel with a wordmark row, a large airy title, a search field,
 * and one monochrome list.
 *
 * History, because it constrains the design: three light versions failed
 * because a grey list on a near-white surface can only differentiate the
 * active row by a few percent of lightness; the dark slab brute-forced that
 * at the cost of a permanent dark column; the all-pill panel fixed the
 * mechanism but read flat; and a tile tier fixed the flatness but made the
 * panel busier than the reference the product is measured against.
 *
 * The celoxis panel earns its character from four quieter moves, and this
 * file copies each of them:
 *
 *   - The ground is WARM (`--nav-bg` is a warm grey, inks warm to match) —
 *     temperature, not structure, is most of the reference's softness.
 *   - A large light title sits between the wordmark row and the list, so
 *     the panel opens with typography instead of chrome.
 *   - The active row is a raised white pill — elevation, not tone — and it
 *     carries a small circular chevron chip on its right edge, which gives
 *     the selection an object to be, the way the reference's "×" chip does.
 *   - The list itself is monochrome: bare 1.8-stroke icons, muted ink, one
 *     accent nowhere except the brand chip and the upgrade card.
 *
 * Collapsing narrows the same panel to an icon rail rather than removing
 * it, so navigation never costs you the whole sidebar. Group headings drop
 * on the rail — there is no room — and fold into each entry's aria-label
 * so the grouping survives for screen readers.
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

function SearchIcon({ className }: { className?: string }) {
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
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  )
}

function ChevronIcon({ className }: { className?: string }) {
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
      <path d="M9 6l6 6-6 6" />
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
        "group relative flex h-10 items-center gap-3 rounded-pill text-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand",
        expanded ? "px-3.5" : "justify-center px-0",
        active
          ? "bg-nav-active font-medium text-nav-ink shadow-pill"
          : "text-nav-ink-2 hover:bg-nav-hover hover:text-nav-ink",
      )}
    >
      <NavIcon
        href={item.href}
        className={cn(
          "h-[18px] w-[18px] shrink-0 transition-colors",
          active ? "text-nav-ink" : "text-nav-ink-muted group-hover:text-nav-ink-2",
        )}
      />
      {expanded ? (
        <>
          <span className="truncate">{item.label}</span>
          {active ? (
            // The selection chip: a small circle riding the pill's right
            // edge, mirroring the reference's "×" chip. Grounded in the
            // panel colour so it reads on the raised white pill in light
            // theme and against the raised pill in dark.
            <span
              aria-hidden="true"
              className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-nav ring-1 ring-nav-border"
            >
              <ChevronIcon className="h-3 w-3 text-nav-ink-muted" />
            </span>
          ) : badge === undefined ? null : (
            <span
              aria-hidden="true"
              className="ml-auto shrink-0 rounded-pill bg-nav-hover px-2 py-0.5 text-[11px] font-medium tabular-nums text-nav-ink-2"
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
          className={cn(
            "absolute right-2 top-2 h-1.5 w-1.5 rounded-full",
            active ? "bg-nav-brand" : "bg-nav-ink-muted",
          )}
        />
      )}
    </Link>
  )
}

export function Sidebar({
  expanded,
  onToggle,
  onSearch,
  workspaceLabel,
}: {
  expanded: boolean
  onToggle: () => void
  onSearch: () => void
  workspaceLabel: string
}) {
  const pathname = usePathname()

  return (
    <aside
      className={cn(
        "nav-glow hidden shrink-0 flex-col overflow-hidden rounded-card border border-nav-border bg-nav shadow-float md:flex",
        expanded ? PANEL_WIDTH : RAIL_WIDTH,
      )}
    >
      {/* Wordmark row: brand chip left, collapse control right — the
          reference panel's top row before its title takes over. */}
      <div
        className={cn(
          "flex h-14 shrink-0 items-center justify-between",
          expanded ? "px-3.5" : "justify-center px-0",
        )}
      >
        <Link
          href="/app/dashboard"
          aria-label={`${workspaceLabel} home`}
          title={expanded ? undefined : workspaceLabel}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand to-brand-deep text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
        >
          {workspaceLabel.charAt(0).toUpperCase()}
        </Link>
        {expanded ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-nav-ink-muted transition-colors hover:bg-nav-hover hover:text-nav-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
          >
            <PanelIcon className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* The large airy title from the reference panel: the workspace opens
          the column in display type, and the list starts under it. */}
      {expanded ? (
        <div className="shrink-0 px-4 pb-2">
          <p className="line-clamp-2 text-[22px] font-light leading-tight tracking-tight text-nav-ink">
            {workspaceLabel}
          </p>
        </div>
      ) : null}

      {/* Search hands off to the command palette, so the sidebar search and
          ⌘K stay one feature instead of two. */}
      {expanded ? (
        <div className="shrink-0 px-2.5 pb-1">
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search (opens the command palette)"
            className="flex h-9 w-full items-center gap-2.5 rounded-pill border border-nav-border bg-nav-active px-3.5 text-sm text-nav-ink-muted shadow-xs transition-shadow hover:shadow-pill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
          >
            <SearchIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">Search…</span>
            <kbd className="ml-auto shrink-0 rounded border border-nav-border bg-nav px-1.5 py-0.5 font-sans text-[10px] font-medium">
              ⌘K
            </kbd>
          </button>
        </div>
      ) : (
        <div className="flex shrink-0 flex-col items-center gap-1 pb-1 pt-1">
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search (opens the command palette)"
            title="Search"
            className="flex h-9 w-9 items-center justify-center rounded-pill text-nav-ink-muted transition-colors hover:bg-nav-hover hover:text-nav-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
          >
            <SearchIcon className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            onClick={onToggle}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="flex h-9 w-9 items-center justify-center rounded-pill text-nav-ink-muted transition-colors hover:bg-nav-hover hover:text-nav-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
          >
            <PanelIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      <nav
        aria-label="Primary"
        className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2 pt-1 [scrollbar-color:var(--nav-border)_transparent] [scrollbar-width:thin]"
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
              // Sentence-case and quiet — the reference panel labels its
              // groups barely at all, but a 26-item CRM still needs the
              // scaffolding to be scannable.
              <p className="px-3.5 pb-1 pt-3 text-[11px] font-medium text-nav-ink-muted">
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

      <div className={cn("shrink-0", expanded ? "px-2.5 pb-2.5 pt-1" : "px-2.5 pb-2 pt-1")}>
        {expanded ? (
          <Link
            href="/app/settings"
            className="relative block overflow-hidden rounded-card bg-gradient-to-br from-brand to-brand-deep p-3.5 transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
          >
            {/* Decorative light blobs — inside the ONE gradient the spec
                reserves for this card. */}
            <span
              aria-hidden="true"
              className="absolute -right-5 -top-7 h-20 w-20 rounded-full bg-white/15"
            />
            <span
              aria-hidden="true"
              className="absolute -bottom-8 -left-3 h-14 w-14 rounded-full bg-white/10"
            />
            <p className="relative flex items-center gap-2 text-sm font-semibold text-white">
              <SparkIcon className="h-4 w-4 shrink-0" />
              Upgrade to Premium
            </p>
            <p className="relative mt-0.5 text-[11px] leading-snug text-white/75">
              Unlimited AI runs, custom objects and priority support.
            </p>
          </Link>
        ) : (
          <Link
            href="/app/settings"
            aria-label="Upgrade to Premium"
            title="Upgrade to Premium"
            className="mx-1 flex h-10 items-center justify-center rounded-pill bg-gradient-to-br from-brand to-brand-deep text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nav-brand"
          >
            <SparkIcon className="h-[18px] w-[18px]" />
          </Link>
        )}
      </div>

      <div className="shrink-0 px-2.5 pb-2 pt-1">
        <SidebarUser expanded={expanded} />
      </div>
    </aside>
  )
}
