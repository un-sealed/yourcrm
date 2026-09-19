"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Button } from "@yourcrm/ui"
import { cn } from "@yourcrm/ui"
import { ALL_ROUTES, NAV_SECTIONS } from "./nav-sections"
import { NotificationBell } from "./notification-bell"
import { SessionFooter } from "./session-footer"
import { OfflineBanner } from "./offline-banner"
import { MobileNav } from "./mobile-nav"
import { useUiStore, useWorkspaceStore } from "@/lib/store"

/** Left navigation shell: workspace switcher, nav, user menu, palette entry. */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { sidebarOpen, toggleSidebar } = useUiStore()
  const { workspaceName } = useWorkspaceStore()
  const [paletteOpen, setPaletteOpen] = useState(false)

  return (
    <div className="flex min-h-screen">
      {sidebarOpen && (
        <aside className="hidden w-60 shrink-0 flex-col border-r bg-card md:flex">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <button className="truncate text-left text-sm font-semibold" title="Workspace switcher">
              {workspaceName}
            </button>
            <Button variant="ghost" size="sm" onClick={toggleSidebar} aria-label="Collapse sidebar">
              «
            </Button>
          </div>
          <nav className="flex-1 overflow-y-auto p-2">
            {NAV_SECTIONS.map((section) => (
              <div key={section.group} className="mb-3">
                <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.group}
                </p>
                {section.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "block rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                      pathname === item.href && "bg-accent font-medium",
                    )}
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="border-t p-3 text-xs text-muted-foreground">
            <SessionFooter />
          </div>
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleSidebar}
              aria-label="Expand sidebar"
              className="hidden md:inline-flex"
            >
              »
            </Button>
          )}
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex w-full max-w-md items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground"
          >
            Search or command… <kbd className="ml-auto rounded border px-1 text-[11px]">⌘K</kbd>
          </button>
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell />
            <Button size="sm">+ Create</Button>
          </div>
        </header>
        <main className="flex-1 p-4 pb-20 md:p-6 md:pb-6">{children}</main>
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <MobileNav />
    </div>
  )
}

/** Global search / command palette (foundation: route navigation). */
function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("")
  const matches = ALL_ROUTES.filter((r) =>
    r.label.toLowerCase().includes(query.toLowerCase()),
  ).slice(0, 12)

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-label="Command palette"
    >
      <div
        className="mx-auto mt-24 max-w-lg overflow-hidden rounded-lg border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command or search…"
          className="w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
        />
        <ul className="max-h-64 overflow-y-auto p-2">
          {matches.map((m) => (
            <li key={m.href}>
              <Link
                href={m.href}
                onClick={onClose}
                className="block rounded-md px-3 py-2 text-sm hover:bg-accent"
              >
                Go to {m.label}
              </Link>
            </li>
          ))}
          {matches.length === 0 && (
            <li className="px-3 py-2 text-sm text-muted-foreground">No matches</li>
          )}
        </ul>
        <p className="border-t px-4 py-2 text-[11px] text-muted-foreground">
          ↑↓ navigate · ↵ select · esc close
        </p>
      </div>
    </div>
  )
}
