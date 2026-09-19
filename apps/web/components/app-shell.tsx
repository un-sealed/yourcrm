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
import { useUiStore, useWorkspaceStore } from "@/lib/store"

/** Left navigation shell: brand, grouped nav, session footer, header, palette. */

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

  return (
    <div className="flex min-h-screen bg-background">
      {sidebarOpen && (
        <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
          <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
              Y
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-sidebar-foreground">{label}</p>
              <p className="truncate text-[11px] text-sidebar-muted">Workspace</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              aria-label="Collapse sidebar"
              className="h-7 w-7 text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              «
            </Button>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 py-3">
            {NAV_SECTIONS.map((section) => (
              <div key={section.group} className="mb-4 last:mb-0">
                <p className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted">
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
                            "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                            active
                              ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                              : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                          )}
                        >
                          <NavIcon
                            href={item.href}
                            className={cn(
                              "h-[18px] w-[18px] shrink-0",
                              active
                                ? "text-sidebar-accent-foreground"
                                : "text-sidebar-muted group-hover:text-sidebar-foreground",
                            )}
                          />
                          <span className="truncate">{item.label}</span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="border-t border-sidebar-border p-3 text-xs text-sidebar-muted">
            <SessionFooter />
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
              className="hidden h-8 w-8 md:inline-flex"
            >
              »
            </Button>
          )}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-input bg-card px-3 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            <kbd className="ml-auto hidden rounded border border-border bg-muted px-1.5 py-0.5 font-sans text-[10px] font-medium text-muted-foreground sm:inline">
              ⌘K
            </kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell />
            <CreateMenu />
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
          className="absolute right-0 z-50 mt-2 w-44 overflow-hidden rounded-xl border border-border bg-card p-1 shadow-pop"
        >
          <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            New
          </p>
          {CREATE_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block rounded-md px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
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
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-pop"
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
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
        />
        <ul className="max-h-72 overflow-y-auto p-2">
          {matches.map((m) => (
            <li key={m.href}>
              <Link
                href={m.href}
                onClick={onClose}
                className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent"
              >
                <NavIcon href={m.href} className="h-4 w-4 text-muted-foreground" />
                {m.label}
              </Link>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matches</li>
          )}
        </ul>
        <p className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>↵ open</span>
          <span>esc close</span>
        </p>
      </div>
    </div>
  )
}
