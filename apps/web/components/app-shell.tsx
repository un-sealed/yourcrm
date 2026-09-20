"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { Button, cn } from "@yourcrm/ui"
import { ALL_ROUTES, NAV_SECTIONS } from "./nav-sections"
import { NotificationBell } from "./notification-bell"
import { SessionFooter } from "./session-footer"
import { OfflineBanner } from "./offline-banner"
import { MobileNav } from "./mobile-nav"
import { NavIcon } from "./nav-icons"
import { ThemeToggle } from "./theme-toggle"
import { useUiStore, useWorkspaceStore } from "@/lib/store"

/**
 * Left navigation shell per docs/design/DASHBOARD-REDESIGN.md §2: 248px
 * sidebar (`--surface-1`, 1px right border), grouped nav with uppercase
 * 11px muted section labels, 36px items (active = `--brand-soft` bg +
 * `--brand` text), count badges, and the "Upgrade to Premium" card pinned
 * at the bottom — the ONE gradient allowed in the product. Topbar is 56px
 * with a `--surface-2` search field, ⌘K hint, theme toggle, bell and avatar.
 */

const CREATE_LINKS = [
  { href: "/app/people/new", label: "Person" },
  { href: "/app/companies/new", label: "Company" },
  { href: "/app/quotes/new", label: "Quote" },
  { href: "/app/invoices/new", label: "Invoice" },
  { href: "/app/tickets/new", label: "Ticket" },
  { href: "/app/reports/new", label: "Report" },
]

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true
  if (href === "/app/dashboard") return false
  if (!pathname.startsWith(`${href}/`)) return false
  // Parent-highlight nested routes (/app/settings/notifications), but never
  // when another nav entry is itself the exact match (/app/settings/onboarding).
  return !ALL_ROUTES.some((route) => route.href === pathname)
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
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
    <div className="flex min-h-screen bg-page">
      {sidebarOpen && (
        <aside className="hidden w-[248px] shrink-0 flex-col border-r border-border bg-surface-1 md:flex">
          <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl bg-brand text-sm font-semibold text-white">
              {label.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-ink-primary">{label}</p>
              <p className="truncate text-[11px] text-ink-muted">Workspace</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
              className="h-7 w-7 text-ink-muted hover:bg-surface-2 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </Button>
          </div>

          <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 py-3">
            {NAV_SECTIONS.map((section) => (
              <div key={section.group} className="mb-4 last:mb-0">
                <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                  {section.group}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {section.items.map((item) => {
                    const active = isActive(pathname, item.href)
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "group flex h-9 items-center gap-3 rounded-ctl px-2.5 text-sm transition-colors",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong",
                            active
                              ? "bg-brand-soft font-medium text-brand"
                              : "text-ink-secondary hover:bg-surface-2 hover:text-ink-primary",
                          )}
                        >
                          <NavIcon
                            href={item.href}
                            className={cn(
                              "h-[18px] w-[18px] shrink-0",
                              active ? "text-brand" : "text-ink-muted group-hover:text-ink-primary",
                            )}
                          />
                          <span className="truncate">{item.label}</span>
                          {item.count !== undefined && (
                            <span className="ml-auto shrink-0 rounded-pill bg-surface-2 px-1.5 py-0.5 text-xs font-medium tabular-nums text-ink-secondary">
                              {item.count}
                            </span>
                          )}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="flex flex-col gap-3 p-3">
            <div className="border-t border-border pt-3 text-xs text-ink-muted">
              <SessionFooter />
            </div>
            <div className="rounded-card bg-gradient-to-br from-brand to-brand-deep p-4 text-white">
              <p className="text-sm font-semibold">Upgrade to Premium</p>
              <p className="mt-1 text-xs text-white/80">
                Unlock AI insights, automations and more.
              </p>
              <Link
                href="/app/settings"
                className="mt-3 inline-flex h-8 items-center rounded-pill bg-white px-3.5 text-sm font-medium text-brand transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Upgrade
              </Link>
            </div>
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface-1 px-4">
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
              className="hidden h-8 w-8 text-ink-secondary hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-strong md:inline-flex"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </Button>
          )}
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
        <main className="flex-1 p-4 pb-20 md:p-6 md:pb-8">{children}</main>
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
