"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Button } from "@yourcrm/ui"
import { ALL_ROUTES } from "./nav-sections"
import { NotificationBell } from "./notification-bell"
import { OfflineBanner } from "./offline-banner"
import { MobileNav } from "./mobile-nav"
import { NavIcon } from "./nav-icons"
import { Sidebar } from "./sidebar"
import { ThemeToggle } from "./theme-toggle"
import { useUiStore, useWorkspaceStore } from "@/lib/store"

/**
 * Left navigation shell. The 56px topbar is per
 * docs/design/DASHBOARD-REDESIGN.md §2 — `--surface-2` search field, ⌘K
 * hint, theme toggle, bell and avatar.
 *
 * The shell now composes as floating panels on the page canvas (the
 * reference layouts the sidebar is built from): the nav column and the
 * content column are both rounded cards separated by a gutter of `--page`.
 * The sidebar itself carries its own design notes — see sidebar.tsx. What
 * survives from §2 here is the "Upgrade to Premium" card pinned at the
 * bottom of the sidebar, still the ONE gradient allowed in the product.
 */

const CREATE_LINKS = [
  { href: "/app/people/new", label: "Person" },
  { href: "/app/companies/new", label: "Company" },
  { href: "/app/quotes/new", label: "Quote" },
  { href: "/app/invoices/new", label: "Invoice" },
  { href: "/app/tickets/new", label: "Ticket" },
  { href: "/app/reports/new", label: "Report" },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, toggleSidebar } = useUiStore()
  const workspaceName = useWorkspaceStore((s) => s.workspaceName)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const label = workspaceName && workspaceName !== "Select workspace" ? workspaceName : "YourCRM"

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  return (
    /*
      Layout contract: the shell is exactly one viewport tall and never
      scrolls as a document. The sidebar and the main column each own their
      scrollbar instead.

      Previously this was `min-h-screen`, so the shell grew with whatever the
      page rendered. That left the <aside> unbounded, which meant its
      `overflow-y-auto` nav could never engage — the browser scrolled the
      whole document, and a long page dragged the sidebar's full height along
      with it.

      `h-dvh` rather than `h-screen`: on mobile `100vh` counts the area behind
      the browser chrome, which pushes the bottom of the app out of view.

      A page that should fill the viewport without an outer scrollbar (the AI
      assistant's chat column, inbox-style panes) renders a root of
      `h-full` and scrolls internally — <main> is a definite height, so `h-full`
      resolves against it and produces no overflow.

      The `p-3`/`gap-3` gutters are what make the panels float: both columns
      are rounded cards, and the page background shows through between them.
    */
    <div className="flex h-dvh gap-3 overflow-hidden bg-page p-3">
      <Sidebar
        expanded={sidebarOpen}
        onToggle={toggleSidebar}
        onSearch={() => setPaletteOpen(true)}
        workspaceLabel={label}
      />

      <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-page shadow-float">
        <OfflineBanner />
        {/* Not `sticky` any more: it sits outside the scroll container, so it
            is pinned by the layout itself. `shrink-0` keeps the 56px bar from
            being squeezed when the main column is short. */}
        <header className="z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-4">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-full max-w-[420px] items-center gap-2 rounded-ctl border border-border bg-surface-2 px-3 text-sm text-ink-muted transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.3-4.3" />
            </svg>
            <span className="truncate">Search or jump to…</span>
            <kbd className="ml-auto hidden rounded border border-border bg-surface-1 px-1.5 py-0.5 font-sans text-[10px] font-medium text-ink-muted sm:inline">
              ⌘K
            </kbd>
          </button>
          <div className="ml-auto flex items-center gap-1.5">
            <CreateMenu />
            <ThemeToggle />
            <NotificationBell />
            <span
              role="img"
              aria-label={`${label} workspace avatar`}
              title={label}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand"
            >
              {label.charAt(0).toUpperCase()}
            </span>
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 pb-20 md:p-6 md:pb-8">
          {children}
        </main>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <MobileNav />
    </div>
  )
}

function CreateMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("mousedown", onClick)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("mousedown", onClick)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <Button
        size="sm"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className="h-4 w-4"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        Create
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-card border border-border bg-surface-1 p-1 shadow-pop"
        >
          <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
            New
          </p>
          {CREATE_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block rounded-ctl px-2.5 py-1.5 text-sm text-ink-primary transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            >
              {link.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Global search / command palette (route navigation). */
function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const matches = ALL_ROUTES.filter((r) =>
    r.label.toLowerCase().includes(query.toLowerCase()),
  ).slice(0, 12)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/45 p-4 pt-24 backdrop-blur-[2px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-card border border-border bg-surface-1 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches[0]) {
              router.push(matches[0].href)
              onClose()
            }
          }}
          placeholder="Search pages and jump…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm text-ink-primary outline-none placeholder:text-ink-muted"
        />
        <ul className="max-h-72 overflow-y-auto p-2">
          {matches.map((m) => (
            <li key={m.href}>
              <Link
                href={m.href}
                onClick={onClose}
                className="flex items-center gap-2.5 rounded-ctl px-3 py-2 text-sm text-ink-primary transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
              >
                <NavIcon href={m.href} className="h-4 w-4 text-ink-muted" />
                {m.label}
              </Link>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-ink-muted">No matches</li>
          )}
        </ul>
        <p className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-ink-muted">
          <span>↵ open</span>
          <span>esc close</span>
        </p>
      </div>
    </div>
  )
}
